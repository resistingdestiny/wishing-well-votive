// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AquaVotive} from "../src/AquaVotive.sol";
import {VotiveBase} from "../src/VotiveBase.sol";
import {Deadlines, Intent, Terms, VotiveState} from "../src/VotiveTypes.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {MockERC20} from "./helpers/Tokens.sol";
import {VotiveTest} from "./helpers/VotiveTest.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Aqua's accounting, as a votive can observe it.
///
/// @dev Deliberately faithful about the one property that matters: `ship` records
///      and transfers nothing, and a fill later moves tokens from the maker with
///      `transferFrom`. A mock that escrowed on `ship` would let a test pass that
///      the real contract would fail, and would hide exactly the risk the votive
///      is built around.
contract AquaMock is IAqua {
    mapping(bytes32 => mapping(address => uint256)) public declared;
    mapping(bytes32 => bool) public docked;
    uint256 public shipCount;

    function ship(
        address, /* app */
        bytes calldata strategy,
        address[] calldata tokens,
        uint256[] calldata amounts
    ) external returns (bytes32 strategyHash) {
        strategyHash = keccak256(strategy);
        for (uint256 i = 0; i < tokens.length; i++) {
            declared[strategyHash][tokens[i]] = amounts[i];
        }
        shipCount++;
    }

    function safeBalances(address, address, bytes32 hash, address a, address b)
        external
        view
        returns (uint256, uint256)
    {
        return (declared[hash][a], declared[hash][b]);
    }

    function dock(address, bytes32 hash, address[] calldata tokens) external {
        for (uint256 i = 0; i < tokens.length; i++) {
            declared[hash][tokens[i]] = 0;
        }
        docked[hash] = true;
    }

    /// @dev What a router does on a fill: spend the maker's allowance.
    function simulateFill(address maker, address token, uint256 amount, address to) external {
        require(IERC20(token).transferFrom(maker, to, amount), "fill failed");
    }
}

/// @notice Stands in for the factory a votive was opened by.
///
/// @dev A votive calls its factory back for two things: who is allowed to execute
///      it, and a nudge when it settles. Opening a clone directly in a test means
///      something has to answer those, and a purpose-built stub is clearer than
///      making the test contract pretend — the test contract cannot expose an
///      `executor()` getter anyway, because the fixture already uses that name for
///      an internal variable.
///
///      Three calls, found one revert at a time: `executor()` on every guarded
///      action, `treasury()` when a fee is taken at settlement, and `onTerminal()`
///      once the votive is done. Each one only shows up on the path that needs it.
contract FactoryStub {
    address public executor;
    address public treasury;

    constructor(address executor_, address treasury_) {
        executor = executor_;
        treasury = treasury_;
    }

    function open(
        AquaVotive votive,
        Intent memory intent_,
        Deadlines memory deadlines_,
        Terms memory terms_,
        address registry_,
        IERC20 token_
    ) external {
        votive.initialize(intent_, deadlines_, terms_, registry_, token_);
    }

    function onTerminal() external {}
}

/// @notice A wish that holds its own principal and quotes itself.
///
///         The suite is about the one claim that carries risk: shipping a position
///         grants an allowance over the founder's money, so everything here is
///         about who can grant it, how much it can ever be, and how it comes back.
contract AquaVotiveTest is VotiveTest {
    AquaVotive internal implementation2;
    AquaVotive internal votive;
    AquaMock internal aqua;
    FactoryStub internal factoryStub;
    MockERC20 internal fundingToken;
    MockERC20 internal quoteToken;

    address internal router = makeAddr("router");
    address internal filler = makeAddr("filler");

    uint256 internal constant FUNDING = 1_000e18;

    function setUp() public override {
        super.setUp();

        aqua = new AquaMock();
        fundingToken = new MockERC20("Funding", "FUND", 18);
        quoteToken = new MockERC20("Quote", "QUOTE", 18);
        implementation2 = new AquaVotive();

        fundingToken.mint(founder, FUNDING);

        // A clone, because the implementation disables its own initialisers — the
        // standard guard against somebody initialising the template every clone
        // delegates to. Cloning here is also what a deployment actually does.
        votive = AquaVotive(payable(Clones.clone(address(implementation2))));
        vm.prank(founder);
        require(fundingToken.transfer(address(votive), FUNDING), "funding failed");

        // Real clocks, not the factory's zero-means-default sentinel: opening this
        // way bypasses the factory that would have filled them in.
        factoryStub = new FactoryStub(executor, treasury);
        factoryStub.open(
            votive,
            defaultIntent(),
            realDeadlines(),
            quotedTerms(),
            address(registry),
            IERC20(fundingToken)
        );
    }

    function realDeadlines() internal pure returns (Deadlines memory) {
        return Deadlines({guardianAfter: 30 days, escheatAfter: 365 days, attemptWindow: 1 days});
    }

    function quotedTerms() internal pure returns (Terms memory) {
        return Terms({streamBps: 200, performanceBps: 800});
    }

    function _configure() internal {
        vm.prank(founder);
        votive.configureAqua(IAqua(address(aqua)), router);
    }

    function _ship(uint256 offer) internal returns (bytes32) {
        vm.prank(founder);
        return
            votive.shipToAqua(
                abi.encode("a program with the gates in it"), address(quoteToken), offer
            );
    }

    // -------------------------------------------------------- opening it

    function test_theVotiveKeepsItsPrincipalWhenItShips() public {
        _configure();
        uint256 before = fundingToken.balanceOf(address(votive));

        _ship(100e18);

        assertEq(
            fundingToken.balanceOf(address(votive)),
            before,
            "shipping moved money; Aqua does not custody"
        );
        assertEq(votive.offered(), 100e18);
        assertTrue(votive.isPositionOpen());
    }

    /// The allowance is the whole risk, so it is bounded by the offer rather than
    /// granted infinitely.
    function test_theAllowanceIsExactlyWhatWasOffered() public {
        _configure();
        _ship(100e18);

        assertEq(fundingToken.allowance(address(votive), address(aqua)), 100e18);
    }

    function test_aFillSpendsTheAllowanceAndNoMore() public {
        _configure();
        _ship(100e18);

        aqua.simulateFill(address(votive), address(fundingToken), 100e18, filler);
        assertEq(fundingToken.balanceOf(filler), 100e18);

        // Nothing further: the allowance is used up.
        vm.expectRevert();
        aqua.simulateFill(address(votive), address(fundingToken), 1, filler);
    }

    /// A founder chooses to make their wish quotable. Nobody chooses it for them.
    function test_onlyTheFounderCanOpenAPosition() public {
        _configure();

        vm.prank(stranger);
        vm.expectRevert(VotiveBase.NotFounder.selector);
        votive.shipToAqua(abi.encode("p"), address(quoteToken), 10e18);
    }

    function test_configuringIsAlsoTheFoundersCall() public {
        vm.prank(stranger);
        vm.expectRevert(VotiveBase.NotFounder.selector);
        votive.configureAqua(IAqua(address(aqua)), router);
    }

    /// Offering more than is parked would promise money the protocol has already
    /// earned in fees and not yet taken.
    function test_itCannotOfferMoreThanIsParked() public {
        _configure();
        uint256 parked = votive.parked();

        vm.prank(founder);
        vm.expectRevert(
            abi.encodeWithSelector(AquaVotive.OffersMoreThanParked.selector, parked + 1, parked)
        );
        votive.shipToAqua(abi.encode("p"), address(quoteToken), parked + 1);
    }

    function test_anEmptyOfferIsRefused() public {
        _configure();
        vm.prank(founder);
        vm.expectRevert();
        votive.shipToAqua(abi.encode("p"), address(quoteToken), 0);
    }

    /// A pair of one token is not a market, and would let a fill round-trip the
    /// principal through the curve for nothing.
    function test_theQuoteTokenCannotBeTheFundingToken() public {
        _configure();
        vm.prank(founder);
        vm.expectRevert(AquaVotive.QuoteTokenIsFundingToken.selector);
        votive.shipToAqua(abi.encode("p"), address(fundingToken), 10e18);
    }

    function test_shippingNeedsAquaConfiguredFirst() public {
        vm.prank(founder);
        vm.expectRevert(AquaVotive.AquaNotConfigured.selector);
        votive.shipToAqua(abi.encode("p"), address(quoteToken), 10e18);
    }

    function test_onlyOnePositionAtATime() public {
        _configure();
        _ship(10e18);

        vm.prank(founder);
        vm.expectRevert(AquaVotive.PositionAlreadyOpen.selector);
        votive.shipToAqua(abi.encode("another"), address(quoteToken), 10e18);
    }

    // -------------------------------------------------------- closing it

    /// A position you cannot exit is a trap.
    function test_theFounderCanCloseAndTheAllowanceGoesToZero() public {
        _configure();
        bytes32 hash = _ship(100e18);

        vm.prank(founder);
        votive.dockFromAqua();

        assertEq(fundingToken.allowance(address(votive), address(aqua)), 0);
        assertFalse(votive.isPositionOpen());
        assertTrue(aqua.docked(hash));
    }

    function test_aStrangerCannotCloseALiveVotivesPosition() public {
        _configure();
        _ship(100e18);

        vm.prank(stranger);
        vm.expectRevert(VotiveBase.NotFounder.selector);
        votive.dockFromAqua();
    }

    /// Once the wish has settled, anyone may close it — a settled votive with a
    /// live allowance over its principal is the one state nobody should be able to
    /// leave it in.
    function test_anyoneCanCloseOnceTheVotiveHasSettled() public {
        _configure();
        _ship(100e18);

        passCapability();
        vm.prank(executor);
        votive.beginAttempt();
        meetCondition(address(votive));
        vm.prank(executor);
        votive.fulfil();
        assertEq(uint8(votive.state()), uint8(VotiveState.Fulfilled));

        vm.prank(stranger);
        votive.dockFromAqua();

        assertEq(fundingToken.allowance(address(votive), address(aqua)), 0);
    }

    function test_closingNothingIsAnError() public {
        _configure();
        vm.expectRevert(AquaVotive.NoPositionOpen.selector);
        votive.dockFromAqua();
    }

    // ----------------------------------------------------------- reading

    function test_theVotiveReportsWhatThePositionDeclares() public {
        _configure();
        _ship(250e18);

        (uint256 principalSide, uint256 quoteSide) = votive.positionBalances();
        assertEq(principalSide, 250e18);
        assertEq(quoteSide, 0, "this votive sells what it holds, it does not make a market");
    }

    function test_anUnconfiguredVotiveReportsNoPosition() public view {
        (uint256 a, uint256 b) = votive.positionBalances();
        assertEq(a, 0);
        assertEq(b, 0);
    }
}
