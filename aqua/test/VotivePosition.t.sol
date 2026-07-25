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
import {AttestationsMock, VotiveMock} from "./mocks/VotiveMocks.sol";

/// @notice A votive as an Aqua position, filled through the official Aqua contracts
///         and the official SwapVM test harness — the only substitution is the
///         router, which is ours because ours is the one with the extra
///         instructions.
///
///         The shape being demonstrated: a position that *cannot be filled* until
///         the AI frontier reaches the job the votive was opened for, and which,
///         when it does fill, pays the protocol's performance fee out of the
///         surplus rather than out of the founder's principal.
contract VotivePositionTest is AquaSwapVMTest {
    using ProgramBuilder for Program;

    AttestationsMock internal attestations;
    VotiveMock internal votive;

    address internal treasury = makeAddr("treasury");

    bytes32 internal constant CAPABILITY = keccak256("capability:write-the-brief");
    bytes32 internal constant CONDITION = keccak256("condition:the-brief-was-filed");

    /// @dev The founder committed 200 of tokenB; only proceeds above that are a
    ///      gain, and only a gain is charged the performance fee.
    uint256 internal constant PRINCIPAL = 200e18;
    /// @dev 8 %, on SwapVM's 1e9 == 100 % scale.
    uint32 internal constant PERFORMANCE_BPS = 8e7;

    uint256 internal opcodeBase;

    function setUp() public override {
        super.setUp();
        attestations = new AttestationsMock();
        votive = new VotiveMock(PRINCIPAL);
        opcodeBase = VotiveAquaRouter(payable(address(swapVM))).votiveOpcodeBase();
    }

    /// @dev The whole modification: the official router, with our instructions.
    function _deployRouter() internal override returns (SwapVM) {
        return new VotiveAquaRouter(address(aqua), address(0), address(this));
    }

    // ------------------------------------------------------------ the program

    /// @dev `[opcode][argsLength][args]`, which is all a SwapVM program is.
    function _instr(uint256 opcode, bytes memory args) internal pure returns (bytes memory) {
        require(args.length <= type(uint8).max, "args too long");
        return bytes.concat(bytes1(uint8(opcode)), bytes1(uint8(args.length)), args);
    }

    function _gateArgs() internal view returns (bytes memory) {
        return abi.encodePacked(address(attestations), CAPABILITY);
    }

    function _conditionArgs() internal view returns (bytes memory) {
        return abi.encodePacked(address(attestations), address(votive), CONDITION);
    }

    function _lifecycleArgs() internal view returns (bytes memory) {
        return abi.encodePacked(address(votive));
    }

    function _feeArgs() internal view returns (bytes memory) {
        return abi.encodePacked(bytes32(PRINCIPAL), PERFORMANCE_BPS, treasury);
    }

    /// @notice The votive's pricing program: three gates, then the performance
    ///         fee bracketing the swap curve.
    function _votiveProgram() internal view returns (bytes memory) {
        Program memory p = ProgramBuilder.init(_opcodes());
        return bytes.concat(
            _instr(opcodeBase + 2, _lifecycleArgs()),
            _instr(opcodeBase + 0, _gateArgs()),
            _instr(opcodeBase + 1, _conditionArgs()),
            _instr(opcodeBase + 3, _feeArgs()),
            p.build(XYCSwap._xycSwapXD),
            p.build(Controls._salt, abi.encodePacked(vm.randomUint()))
        );
    }

    function _openPosition() internal returns (ISwapVM.Order memory order) {
        order = createStrategy(_votiveProgram());
        shipStrategy(swapVM, order, tokenA, tokenB, 100e18, 200e18);
    }

    /// @dev Funds both sides and returns the fill, without performing it — kept
    ///      separate so a `vm.expectRevert` in a gate test lands on the swap and
    ///      not on a mint.
    function _prime(uint256 amount) internal returns (SwapProgram memory swapProgram) {
        swapProgram = SwapProgram({
            amount: amount,
            taker: taker,
            tokenA: tokenA,
            tokenB: tokenB,
            zeroForOne: false,
            isExactIn: true
        });
        mintTokenInToTaker(swapProgram);
        mintTokenOutToMaker(swapProgram, 100e18);
        // Headroom in the token the performance fee is pulled in, so the carve has
        // something to draw on independently of the taker's delivery.
        mintTokenInToMaker(swapProgram, amount);
    }

    function _openTheGates() internal {
        attestations.setCapabilityOpen(CAPABILITY, true);
        attestations.setConditionMet(address(votive), CONDITION, true);
    }

    // ------------------------------------------------- the official set is intact

    /// @notice Our instructions are appended, not inserted. If this ever changes,
    ///         every program the official SDK encodes would silently mean
    ///         something else.
    function test_theOfficialOpcodeSetIsUntouched() public view {
        assertEq(opcodeBase, _opcodes().length, "the official table moved");
        assertEq(
            VotiveAquaRouter(payable(address(swapVM))).VOTIVE_OPCODE_COUNT(),
            7,
            "seven votive instructions"
        );
    }

    // ------------------------------------------------------------------- gates

    function test_aClosedCapabilityGateMakesThePositionUnfillable() public {
        ISwapVM.Order memory order = _openPosition();
        SwapProgram memory sp = _prime(50e18);

        vm.expectRevert(VotiveOpcodes.CapabilityNotOpen.selector);
        swap(sp, order);
    }

    function test_theConditionGateIsSeparateFromTheCapabilityGate() public {
        ISwapVM.Order memory order = _openPosition();

        // The frontier has reached the job, but *this* wish has not come true yet.
        attestations.setCapabilityOpen(CAPABILITY, true);
        SwapProgram memory sp = _prime(50e18);

        vm.expectRevert(VotiveOpcodes.ConditionNotMet.selector);
        swap(sp, order);
    }

    function test_aSettledVotiveHasNoFillablePosition() public {
        ISwapVM.Order memory order = _openPosition();
        _openTheGates();

        votive.setState(3); // Fulfilled — the votive is over
        SwapProgram memory sp = _prime(50e18);

        vm.expectRevert(VotiveOpcodes.VotiveNotLive.selector);
        swap(sp, order);
    }

    // ------------------------------------------------------- the position fills

    /// @notice The demonstration: with the frontier reached and the condition
    ///         attested, the position fills and real tokens move through Aqua.
    function test_onceTheFrontierArrivesThePositionFillsAndTokensMove() public {
        ISwapVM.Order memory order = _openPosition();
        _openTheGates();

        uint256 takerOutBefore = tokenA.balanceOf(address(taker));

        (uint256 amountIn, uint256 amountOut) = swap(_prime(50e18), order);

        assertEq(amountIn, 50e18, "the taker delivered what it offered");
        assertGt(amountOut, 0, "and received tokens back");
        assertEq(
            tokenA.balanceOf(address(taker)) - takerOutBefore,
            amountOut,
            "the token actually moved on chain"
        );
    }

    /// @notice Proceeds at or below the committed principal are the founder's own
    ///         money coming back, so nothing is charged.
    function test_noFeeBelowTheCommittedPrincipal() public {
        ISwapVM.Order memory order = _openPosition();
        _openTheGates();

        swap(_prime(50e18), order); // 50 in, far below the 200 principal

        assertEq(tokenB.balanceOf(treasury), 0, "no gain, no performance fee");
    }

    /// @notice Above the principal there is a gain, and the protocol's share of it
    ///         lands at the treasury — pulled from the maker's Aqua balance, in the
    ///         token the taker delivered.
    function test_theFeeIsChargedOnTheGainAndReachesTheTreasury() public {
        ISwapVM.Order memory order = _openPosition();
        _openTheGates();

        uint256 proceeds = 300e18; // 100 above the committed principal
        swap(_prime(proceeds), order);

        uint256 expected = (proceeds - PRINCIPAL) * PERFORMANCE_BPS / 1e9;
        assertEq(expected, 8e18, "8 % of the 100 gain");
        assertEq(tokenB.balanceOf(treasury), expected, "the treasury was paid on chain");
    }
}
