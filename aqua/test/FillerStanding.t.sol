// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AquaSwapVMTest} from "@1inch/swap-vm-test/base/AquaSwapVMTest.sol";
import {Program, ProgramBuilder} from "@1inch/swap-vm-test/utils/ProgramBuilder.sol";
import {SwapVM} from "@1inch/swap-vm/SwapVM.sol";
import {Controls} from "@1inch/swap-vm/instructions/Controls.sol";
import {XYCSwap} from "@1inch/swap-vm/instructions/XYCSwap.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";

import {VotiveAquaRouter} from "../src/VotiveAquaRouter.sol";
import {VotiveOpcodes} from "../src/VotiveOpcodes.sol";
import {
    AttestationsMock,
    HumanBackingMock,
    StandingMock,
    VotiveMock
} from "./mocks/VotiveMocks.sol";

/// @notice Who may fill a wish, and what their record is worth.
///
///         The other suite is about the wish: is it live, has the frontier
///         arrived, is it true. This one is about the *filler*. A position on a
///         wish that anybody can take is a position on a price; a position only a
///         human-backed agent in good standing can take is a position on the work
///         being done by somebody who can be held to it.
///
///         And the last instruction is what makes it a market rather than an
///         auction: two agents can fulfil the same wish, and the one with the
///         better record takes more of it home.
contract FillerStandingTest is AquaSwapVMTest {
    using ProgramBuilder for Program;

    AttestationsMock internal attestations;
    VotiveMock internal votive;
    HumanBackingMock internal humans;
    StandingMock internal standing;

    bytes32 internal constant CAPABILITY = keccak256("capability:read-the-tablet");
    bytes32 internal constant CONDITION = keccak256("condition:the-reading-was-published");
    bytes32 internal constant OPERATOR = keccak256("human:the-agent-operator");

    uint256 internal constant PRINCIPAL = 30e18;
    uint32 internal constant PERFORMANCE_BPS = 8e7; // 8% on SwapVM's 1e9 scale

    uint256 internal opcodeBase;

    function setUp() public override {
        super.setUp();
        attestations = new AttestationsMock();
        votive = new VotiveMock(PRINCIPAL);
        humans = new HumanBackingMock();
        standing = new StandingMock();
        opcodeBase = VotiveAquaRouter(payable(address(swapVM))).votiveOpcodeBase();

        attestations.setCapabilityOpen(CAPABILITY, true);
        attestations.setConditionMet(address(votive), CONDITION, true);
    }

    function _deployRouter() internal override returns (SwapVM) {
        return new VotiveAquaRouter(address(aqua), address(0), address(this));
    }

    function _instr(uint256 opcode, bytes memory args) internal pure returns (bytes memory) {
        require(args.length <= type(uint8).max, "args too long");
        return bytes.concat(bytes1(uint8(opcode)), bytes1(uint8(args.length)), args);
    }

    /// @dev The wish gates, then whatever filler rules this case is about.
    function _program(bytes memory fillerRules) internal view returns (bytes memory) {
        Program memory p = ProgramBuilder.init(_opcodes());
        return bytes.concat(
            _instr(opcodeBase + 2, abi.encodePacked(address(votive))),
            _instr(opcodeBase + 0, abi.encodePacked(address(attestations), CAPABILITY)),
            _instr(
                opcodeBase + 1, abi.encodePacked(address(attestations), address(votive), CONDITION)
            ),
            fillerRules,
            p.build(XYCSwap._xycSwapXD),
            p.build(Controls._salt, abi.encodePacked(vm.randomUint()))
        );
    }

    function _humanGate(uint8 minAssurance) internal view returns (bytes memory) {
        return _instr(opcodeBase + 4, abi.encodePacked(address(humans), minAssurance));
    }

    function _standingGate(uint32 minBps) internal view returns (bytes memory) {
        return _instr(opcodeBase + 5, abi.encodePacked(address(humans), address(standing), minBps));
    }

    function _standingBonus(uint32 maxBonusBps) internal view returns (bytes memory) {
        return
            _instr(
                opcodeBase + 6, abi.encodePacked(address(humans), address(standing), maxBonusBps)
            );
    }

    function _open(bytes memory fillerRules) internal returns (ISwapVM.Order memory order) {
        order = createStrategy(_program(fillerRules));
        shipStrategy(swapVM, order, tokenA, tokenB, 100e18, 200e18);
    }

    function _prime(uint256 amount) internal returns (SwapProgram memory sp) {
        sp = SwapProgram({
            amount: amount,
            taker: taker,
            tokenA: tokenA,
            tokenB: tokenB,
            zeroForOne: false,
            isExactIn: true
        });
        mintTokenInToTaker(sp);
        mintTokenOutToMaker(sp, 200e18);
        mintTokenInToMaker(sp, amount);
    }

    // ------------------------------------------------------- the human gate

    function test_anAnonymousFillerIsRefused() public {
        ISwapVM.Order memory order = _open(_humanGate(0));
        SwapProgram memory sp = _prime(50e18);

        vm.expectRevert(VotiveOpcodes.FillerNotHumanBacked.selector);
        swap(sp, order);
    }

    function test_aHumanBackedFillerIsAllowed() public {
        humans.bind(address(taker), OPERATOR, 2);
        ISwapVM.Order memory order = _open(_humanGate(0));
        SwapProgram memory sp = _prime(50e18);

        (, uint256 amountOut) = swap(sp, order);
        assertGt(amountOut, 0, "a verified filler was refused");
    }

    /// Some wishes are worth enough that a cheap signal should not reach them,
    /// however good the record.
    function test_aWishCanDemandStrongerEvidenceThanTheFillerHas() public {
        humans.bind(address(taker), OPERATOR, 1); // device only
        ISwapVM.Order memory order = _open(_humanGate(3)); // orb required
        SwapProgram memory sp = _prime(50e18);

        vm.expectRevert(VotiveOpcodes.FillerBelowAssurance.selector);
        swap(sp, order);
    }

    // ---------------------------------------------------- the standing gate

    /// The cross-integration in one line: an operator barred for asking somebody
    /// to be hurt cannot fill a wish, and the instruction never mentions conduct.
    function test_aBarredOperatorCannotFillAnyWish() public {
        humans.bind(address(taker), OPERATOR, 3);
        standing.setBarred(OPERATOR, true);

        ISwapVM.Order memory order = _open(_standingGate(0));
        SwapProgram memory sp = _prime(50e18);

        vm.expectRevert(VotiveOpcodes.FillerBarred.selector);
        swap(sp, order);
    }

    function test_anOperatorBelowTheStandingBarIsRefused() public {
        humans.bind(address(taker), OPERATOR, 3);
        standing.setMultiplier(OPERATOR, 5_000); // half of parity

        ISwapVM.Order memory order = _open(_standingGate(10_000));
        SwapProgram memory sp = _prime(50e18);

        vm.expectRevert(VotiveOpcodes.FillerStandingTooLow.selector);
        swap(sp, order);
    }

    /// Barred and merely-unproven are different situations and get different
    /// errors, because "go and deliver more work" is not the remedy for a bar.
    function test_barredAndUnprovenAreDistinguished() public {
        humans.bind(address(taker), OPERATOR, 3);

        standing.setMultiplier(OPERATOR, 4_000);
        ISwapVM.Order memory low = _open(_standingGate(10_000));
        SwapProgram memory sp = _prime(50e18);
        vm.expectRevert(VotiveOpcodes.FillerStandingTooLow.selector);
        swap(sp, low);

        standing.setBarred(OPERATOR, true);
        ISwapVM.Order memory barred = _open(_standingGate(10_000));
        SwapProgram memory sp2 = _prime(50e18);
        vm.expectRevert(VotiveOpcodes.FillerBarred.selector);
        swap(sp2, barred);
    }

    function test_anOperatorAtParityClearsAParityBar() public {
        humans.bind(address(taker), OPERATOR, 2);
        ISwapVM.Order memory order = _open(_standingGate(10_000));
        SwapProgram memory sp = _prime(50e18);

        (, uint256 amountOut) = swap(sp, order);
        assertGt(amountOut, 0);
    }

    // ------------------------------------------------------ the payout bonus

    /// The instruction that makes a wish a market: the same work, done by a better
    /// agent, pays more.
    function test_aBetterRecordTakesMoreHome() public {
        humans.bind(address(taker), OPERATOR, 2);

        ISwapVM.Order memory plain = _open("");
        SwapProgram memory sp = _prime(50e18);
        (, uint256 baseline) = swap(sp, plain);

        // A fresh fixture, so the curve starts from the same place.
        setUp();
        humans.bind(address(taker), OPERATOR, 2);
        standing.setMultiplier(OPERATOR, 20_000); // twice parity
        ISwapVM.Order memory bonused = _open(_standingBonus(1e8)); // up to 10%
        SwapProgram memory sp2 = _prime(50e18);
        (, uint256 rewarded) = swap(sp2, bonused);

        assertGt(rewarded, baseline, "a better record was paid no more");
    }

    /// Parity earns nothing extra. This rewards a record; it does not subsidise
    /// the absence of one.
    function test_parityEarnsNoBonus() public {
        humans.bind(address(taker), OPERATOR, 2);

        ISwapVM.Order memory plain = _open("");
        SwapProgram memory sp = _prime(50e18);
        (, uint256 baseline) = swap(sp, plain);

        setUp();
        humans.bind(address(taker), OPERATOR, 2);
        ISwapVM.Order memory bonused = _open(_standingBonus(1e8));
        SwapProgram memory sp2 = _prime(50e18);
        (, uint256 atParity) = swap(sp2, bonused);

        assertEq(atParity, baseline, "parity was paid a bonus");
    }

    /// An anonymous filler gets no bonus rather than reverting: the bonus is a
    /// reward, and a program that only rewards should not also be a gate.
    function test_anUnbackedFillerSimplyGetsNoBonus() public {
        ISwapVM.Order memory order = _open(_standingBonus(1e8));
        SwapProgram memory sp = _prime(50e18);

        (, uint256 amountOut) = swap(sp, order);
        assertGt(amountOut, 0, "the bonus instruction became a gate");
    }

    /// A bonus that could exceed the maker's inventory would be a hole, not a
    /// reward.
    function test_theBonusIsRefusedAboveOneHundredPercent() public {
        humans.bind(address(taker), OPERATOR, 2);
        standing.setMultiplier(OPERATOR, 20_000);

        ISwapVM.Order memory order = _open(_standingBonus(uint32(1e9 + 1)));
        SwapProgram memory sp = _prime(50e18);

        vm.expectRevert(VotiveOpcodes.StandingBonusOutOfRange.selector);
        swap(sp, order);
    }

    // ------------------------------------------------- the whole thing at once

    /// Every rule in one program: the wish must be live and true, the filler must
    /// be a human-backed agent in good standing, and a better record pays more.
    function test_aWishPricedForAgentsEndToEnd() public {
        humans.bind(address(taker), OPERATOR, 2);
        standing.setMultiplier(OPERATOR, 15_000);

        bytes memory rules = bytes.concat(_humanGate(2), _standingGate(10_000), _standingBonus(5e7));

        ISwapVM.Order memory order = _open(rules);
        SwapProgram memory sp = _prime(50e18);

        (uint256 amountIn, uint256 amountOut) = swap(sp, order);
        assertEq(amountIn, 50e18);
        assertGt(amountOut, 0);
    }

    /// And the same program refuses the same fill once the operator is barred —
    /// the wish is unchanged, the filler is not.
    function test_theSameProgramRefusesOnceTheOperatorIsBarred() public {
        humans.bind(address(taker), OPERATOR, 2);
        standing.setBarred(OPERATOR, true);

        bytes memory rules = bytes.concat(_humanGate(2), _standingGate(10_000), _standingBonus(5e7));

        ISwapVM.Order memory order = _open(rules);
        SwapProgram memory sp = _prime(50e18);

        vm.expectRevert(VotiveOpcodes.FillerBarred.selector);
        swap(sp, order);
    }
}
