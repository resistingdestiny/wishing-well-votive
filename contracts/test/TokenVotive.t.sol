// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TokenVotive} from "../src/TokenVotive.sol";
import {VotiveBase} from "../src/VotiveBase.sol";
import {VotiveFactory} from "../src/VotiveFactory.sol";
import {Intent, VotiveState} from "../src/VotiveTypes.sol";
import {
    BlocklistToken,
    DirtyReturnToken,
    FeeOnTransferToken,
    MockERC20,
    NoReturnToken
} from "./helpers/Tokens.sol";
import {VotiveTest} from "./helpers/VotiveTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TokenVotiveTest is VotiveTest {
    MockERC20 internal usd;

    /// @dev Six decimals, because the protocol should not quietly assume every
    ///      token looks like ether.
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant FUNDING = 100 * UNIT;

    function setUp() public override {
        super.setUp();

        usd = new MockERC20("Mock Dollar", "mUSD", 6);
        vm.prank(owner);
        factory.setTokenAllowed(address(usd), true);

        usd.mint(founder, 1_000 * UNIT);
        usd.mint(stranger, 1_000 * UNIT);
    }

    function openToken(Intent memory intent_, uint256 amount)
        internal
        returns (TokenVotive votive)
    {
        vm.startPrank(intent_.founder);
        usd.approve(address(factory), amount);
        votive = TokenVotive(factory.openWithToken(intent_, noOverrides(), anyTerms(), usd, amount));
        vm.stopPrank();
    }

    function openTokenDefault() internal returns (TokenVotive) {
        return openToken(defaultIntent(), FUNDING);
    }

    function attemptToken(TokenVotive votive) internal {
        passCapability();
        vm.prank(executor);
        votive.beginAttempt();
        meetCondition(address(votive));
    }

    // --------------------------------------------------------------- opening

    function test_openingInATokenFundsTheVotiveDirectly() public {
        TokenVotive votive = openTokenDefault();

        assertState(votive, VotiveState.Waiting);
        assertEq(votive.principal(), FUNDING);
        assertEq(usd.balanceOf(address(votive)), FUNDING);
        assertEq(usd.balanceOf(address(factory)), 0, "the factory never holds anybody's money");
        assertEq(votive.asset(), address(usd));
        assertEq(address(votive.token()), address(usd));
    }

    function test_onlyAllowlistedTokens() public {
        MockERC20 rando = new MockERC20("Rando", "RND", 18);
        rando.mint(founder, 1 ether);

        vm.startPrank(founder);
        rando.approve(address(factory), 1 ether);
        vm.expectRevert(VotiveFactory.TokenNotAllowed.selector);
        factory.openWithToken(defaultIntent(), noOverrides(), anyTerms(), rando, 1 ether);
        vm.stopPrank();
    }

    function test_openWithToken_rejectsNothing() public {
        vm.prank(founder);
        vm.expectRevert(VotiveFactory.ZeroFunding.selector);
        factory.openWithToken(defaultIntent(), noOverrides(), anyTerms(), usd, 0);
    }

    function test_openWithToken_theSenderMustBeTheFounder() public {
        vm.startPrank(stranger);
        usd.approve(address(factory), FUNDING);
        vm.expectRevert(VotiveFactory.NotFounder.selector);
        factory.openWithToken(defaultIntent(), noOverrides(), anyTerms(), usd, FUNDING);
        vm.stopPrank();
    }

    /// @dev The whole reason principal is measured rather than trusted.
    function test_aSkimmingTokenCreditsWhatActuallyArrived() public {
        FeeOnTransferToken skim = new FeeOnTransferToken(100); // 1 %
        skim.mint(founder, 1_000 ether);
        vm.prank(owner);
        factory.setTokenAllowed(address(skim), true);

        vm.startPrank(founder);
        skim.approve(address(factory), 100 ether);
        address votive =
            factory.openWithToken(defaultIntent(), noOverrides(), anyTerms(), skim, 100 ether);
        vm.stopPrank();

        assertEq(TokenVotive(votive).principal(), 99 ether);
        assertEq(skim.balanceOf(votive), 99 ether);
    }

    function test_delistingATokenLeavesExistingVotivesAlone() public {
        TokenVotive votive = openTokenDefault();

        vm.prank(owner);
        factory.setTokenAllowed(address(usd), false);

        // The open votive is untouched: still funded, still topped up, still
        // settleable — de-listing is a decision about tomorrow, not about
        // somebody's money today.
        vm.startPrank(founder);
        usd.approve(address(votive), 10 * UNIT);
        votive.topUp(10 * UNIT);
        vm.stopPrank();
        assertEq(votive.principal(), FUNDING + 10 * UNIT);

        attemptToken(votive);
        vm.prank(executor);
        votive.fulfil();
        assertEq(usd.balanceOf(founder), 1_000 * UNIT);
    }

    function test_setTokenAllowed_onlyOwnerAndNonZero() public {
        vm.prank(stranger);
        vm.expectRevert();
        factory.setTokenAllowed(address(usd), false);

        vm.prank(owner);
        vm.expectRevert(VotiveFactory.ZeroAddress.selector);
        factory.setTokenAllowed(address(0), true);
    }

    // --------------------------------------------------------------- funding

    function test_topUpPullsFromTheFounder() public {
        TokenVotive votive = openTokenDefault();

        vm.startPrank(founder);
        usd.approve(address(votive), 50 * UNIT);
        votive.topUp(50 * UNIT);
        vm.stopPrank();

        assertEq(votive.principal(), 150 * UNIT);
        assertEq(votive.offerings(), 0);
    }

    function test_topUp_onlyFounder() public {
        TokenVotive votive = openTokenDefault();
        vm.startPrank(stranger);
        usd.approve(address(votive), 1 * UNIT);
        vm.expectRevert(VotiveBase.NotFounder.selector);
        votive.topUp(1 * UNIT);
        vm.stopPrank();
    }

    function test_offeringIsNotPrincipal() public {
        TokenVotive votive = openTokenDefault();

        vm.startPrank(stranger);
        usd.approve(address(votive), 25 * UNIT);
        votive.offer(25 * UNIT);
        vm.stopPrank();

        assertEq(votive.principal(), FUNDING);
        assertEq(votive.offerings(), 25 * UNIT);
    }

    function test_aBareTransferCountsAsAnOfferingToo() public {
        TokenVotive votive = openTokenDefault();

        vm.prank(stranger);
        assertTrue(usd.transfer(address(votive), 10 * UNIT));

        assertEq(votive.offerings(), 10 * UNIT, "the accounting reads the balance, not events");
    }

    function test_anOfferingFromTheFounderCountsAsPresence() public {
        TokenVotive votive = openTokenDefault();
        vm.warp(block.timestamp + 100 days);

        vm.startPrank(founder);
        usd.approve(address(votive), 1 * UNIT);
        votive.offer(1 * UNIT);
        vm.stopPrank();

        assertEq(votive.lastFounderSignal(), block.timestamp);
    }

    // ------------------------------------------------------------ settlement

    function test_feesAreChargedInTheVotivesOwnToken() public {
        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = payee;
        TokenVotive votive = openToken(intent_, FUNDING);

        vm.startPrank(stranger);
        usd.approve(address(votive), 50 * UNIT);
        votive.offer(50 * UNIT);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days);
        attemptToken(votive);
        vm.prank(executor);
        votive.fulfil();

        assertEq(usd.balanceOf(treasury), 2 * UNIT + 4 * UNIT);
        assertEq(usd.balanceOf(payee), 98 * UNIT + 46 * UNIT);
        assertEq(usd.balanceOf(address(votive)), 0);
    }

    function test_redirectAndEscheatWorkTheSameInTokens() public {
        Intent memory intent_ = defaultIntent();
        intent_.fallbackTo = charity;

        TokenVotive redirected = openToken(intent_, FUNDING);
        vm.prank(founder);
        redirected.redirect(payee);
        assertEq(usd.balanceOf(payee), FUNDING);

        TokenVotive escheated = openToken(intent_, FUNDING);
        vm.warp(escheated.escheatOpensAt());
        escheated.escheat();
        assertEq(usd.balanceOf(treasury), 10 * UNIT, "five years of streaming, nothing more");
        assertEq(usd.balanceOf(charity), 90 * UNIT);
    }

    function test_settleStreamPaysTheTreasuryInTokens() public {
        TokenVotive votive = openTokenDefault();
        vm.warp(block.timestamp + 365 days);

        vm.prank(stranger);
        votive.settleStream();

        assertEq(usd.balanceOf(treasury), 2 * UNIT);
        assertEq(usd.balanceOf(address(votive)), 98 * UNIT);
    }

    // ------------------------------------------------------- awkward tokens

    function test_aTokenThatReturnsNothingStillWorks() public {
        NoReturnToken quiet = new NoReturnToken();
        quiet.mint(founder, 1_000 * UNIT);
        vm.prank(owner);
        factory.setTokenAllowed(address(quiet), true);

        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = payee;

        vm.startPrank(founder);
        quiet.approve(address(factory), FUNDING);
        TokenVotive votive = TokenVotive(
            factory.openWithToken(
                intent_, noOverrides(), anyTerms(), IERC20(address(quiet)), FUNDING
            )
        );
        vm.stopPrank();

        attemptToken(votive);
        vm.prank(executor);
        votive.fulfil();

        assertEq(quiet.balanceOf(payee), FUNDING);
        assertEq(votive.deferred(payee), 0, "a silent success is still a success");
    }

    /// @dev `abi.decode(returndata, (bool))` reverts on a word that is not 0 or 1.
    ///      Reading it with assembly is what keeps a settlement from being wedged
    ///      by a token that answers oddly.
    function test_aTokenThatAnswersOddlyDefersRatherThanWedges() public {
        DirtyReturnToken dirty = new DirtyReturnToken();
        dirty.mint(founder, 1_000 * UNIT);
        vm.prank(owner);
        factory.setTokenAllowed(address(dirty), true);

        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = payee;

        vm.startPrank(founder);
        dirty.approve(address(factory), FUNDING);
        TokenVotive votive = TokenVotive(
            factory.openWithToken(
                intent_, noOverrides(), anyTerms(), IERC20(address(dirty)), FUNDING
            )
        );
        vm.stopPrank();

        attemptToken(votive);
        vm.prank(executor);
        votive.fulfil();

        assertState(votive, VotiveState.Fulfilled);
        assertEq(votive.deferred(payee), FUNDING, "recorded as owed rather than reverting");
    }

    function test_aBlockedBeneficiaryDoesNotWedgeTheSettlement() public {
        BlocklistToken guarded = new BlocklistToken();
        guarded.mint(founder, 1_000 * UNIT);
        guarded.block_(payee, true);
        vm.prank(owner);
        factory.setTokenAllowed(address(guarded), true);

        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = payee;

        vm.startPrank(founder);
        guarded.approve(address(factory), FUNDING);
        TokenVotive votive = TokenVotive(
            factory.openWithToken(
                intent_, noOverrides(), anyTerms(), IERC20(address(guarded)), FUNDING
            )
        );
        vm.stopPrank();

        attemptToken(votive);
        vm.prank(executor);
        votive.fulfil();

        assertState(votive, VotiveState.Fulfilled);
        assertEq(votive.deferred(payee), FUNDING);

        // Once the block lifts, the beneficiary pulls what was always theirs.
        guarded.block_(payee, false);
        vm.prank(payee);
        votive.claimDeferred();
        assertEq(guarded.balanceOf(payee), FUNDING);
    }

    // ---------------------------------------------------------------- rescue

    function test_aForeignTokenGoesBackToTheFounder() public {
        TokenVotive votive = openTokenDefault();

        MockERC20 wrongTurn = new MockERC20("Wrong Turn", "WT", 18);
        wrongTurn.mint(address(votive), 5 ether);

        vm.prank(stranger);
        votive.recoverToken(wrongTurn);

        assertEq(wrongTurn.balanceOf(founder), 5 ether);
        assertEq(votive.principal(), FUNDING, "and the real accounting is untouched");
    }

    function test_theFundingTokenIsNotRecoverable() public {
        TokenVotive votive = openTokenDefault();
        vm.expectRevert(TokenVotive.TokenIsTheFundingAsset.selector);
        votive.recoverToken(usd);
    }

    function test_recoveringNothingReverts() public {
        TokenVotive votive = openTokenDefault();
        MockERC20 empty = new MockERC20("Empty", "MT", 18);

        vm.expectRevert(VotiveBase.NothingToSweep.selector);
        votive.recoverToken(empty);

        vm.expectRevert(VotiveBase.NothingToSweep.selector);
        votive.recoverNative();
    }

    function test_nativeValueForcedIntoATokenVotiveGoesHome() public {
        TokenVotive votive = openTokenDefault();
        vm.deal(address(votive), 3 ether);

        uint256 before = founder.balance;
        vm.prank(stranger);
        votive.recoverNative();

        assertEq(founder.balance, before + 3 ether);
        assertEq(address(votive).balance, 0);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_valueIsConservedInTokensToo(uint96 funding, uint96 offering, uint32 elapsed)
        public
    {
        funding = uint96(bound(funding, 1, 1_000 * UNIT));
        offering = uint96(bound(offering, 0, 1_000 * UNIT));

        usd.mint(founder, funding);
        usd.mint(stranger, offering);
        uint256 founderBefore = usd.balanceOf(founder);
        uint256 strangerBefore = usd.balanceOf(stranger);

        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = payee;
        TokenVotive votive = openToken(intent_, funding);

        if (offering > 0) {
            vm.startPrank(stranger);
            usd.approve(address(votive), offering);
            votive.offer(offering);
            vm.stopPrank();
        }

        vm.warp(block.timestamp + elapsed);
        attemptToken(votive);
        vm.prank(executor);
        votive.fulfil();

        assertEq(usd.balanceOf(address(votive)), 0);
        assertEq(
            usd.balanceOf(treasury) + usd.balanceOf(payee),
            uint256(funding) + uint256(offering),
            "everything that went in came out somewhere"
        );
        assertEq(usd.balanceOf(founder), founderBefore - funding);
        assertEq(usd.balanceOf(stranger), strangerBefore - offering);
    }
}
