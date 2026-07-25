// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {TokenMock} from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";
import {MockTaker} from "@1inch/swap-vm-test/mocks/MockTaker.sol";
import {Program, ProgramBuilder} from "@1inch/swap-vm-test/utils/ProgramBuilder.sol";
import {SwapVM} from "@1inch/swap-vm/SwapVM.sol";
import {Controls} from "@1inch/swap-vm/instructions/Controls.sol";
import {XYCSwap} from "@1inch/swap-vm/instructions/XYCSwap.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/libs/TakerTraits.sol";
import {AquaOpcodesDebug} from "@1inch/swap-vm/opcodes/AquaOpcodesDebug.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {VotiveAquaRouter} from "../src/VotiveAquaRouter.sol";
import {AttestationsMock, VotiveMock} from "../test/mocks/VotiveMocks.sol";

/// @notice Fills a votive position through the official Aqua contracts, on a real
///         chain, moving real ERC-20 balances.
///
///         The test suite already proves the gates and the fee arithmetic. What it
///         cannot do is *show* anything: it runs in a simulated EVM and leaves no
///         transactions behind. This script broadcasts, so every step is a
///         transaction with a hash, and the token balances it prints are balances
///         a block explorer would agree with.
///
///         It runs the position through its whole life in one go, because the
///         interesting part is the order of events rather than any single call:
///
///           1. a votive position is shipped to Aqua, priced by our program;
///           2. filling it is **refused** — the AI frontier has not reached the job
///              the wish was opened for, so the capability gate is shut;
///           3. the capability opens and the wish's condition is attested;
///           4. the same fill now succeeds, tokens move, and the protocol's
///              performance fee is carved out of the surplus.
///
/// @dev Everything here is deployed fresh, including the official `Aqua` contract
///      and two mock ERC-20s. That is deliberate: the point is to demonstrate the
///      instructions against the real Aqua implementation, and a throwaway pair of
///      tokens keeps the demo from depending on a faucet.
///
///      Usage — against a local node, which the rules explicitly permit:
///
///        anvil &
///        forge script script/DemoFill.s.sol:DemoFill \
///          --rpc-url http://127.0.0.1:8545 --private-key "$PK" --broadcast
contract DemoFill is Script, AquaOpcodesDebug {
    using ProgramBuilder for Program;

    /// @dev Inherited only for `_opcodes()`, which is `pure` and is the official
    ///      instruction table. ProgramBuilder uses it to turn a function pointer
    ///      into the opcode index the VM will read — pure metadata, computed here
    ///      and never called into, which is why the address it is constructed with
    ///      is irrelevant.
    constructor() AquaOpcodesDebug(address(0)) {}

    bytes32 internal constant CAPABILITY = keccak256("capability:translate-the-tablet");
    bytes32 internal constant CONDITION = keccak256("condition:the-translation-was-published");

    /// @dev What the founder committed, denominated in the token the maker
    ///      receives. Only proceeds above this are a gain, and only a gain is
    ///      charged the performance fee — set below the fill so the demo actually
    ///      shows the carve happening rather than the no-fee branch.
    uint256 internal constant PRINCIPAL = 30e18;
    /// @dev 8%, on SwapVM's 1e9 == 100% scale.
    uint32 internal constant PERFORMANCE_BPS = 8e7;

    uint256 internal constant MAKER_IN = 100e18;
    uint256 internal constant MAKER_OUT = 200e18;
    uint256 internal constant FILL = 50e18;

    Aqua internal aqua;
    SwapVM internal swapVM;
    TokenMock internal tokenA;
    TokenMock internal tokenB;
    MockTaker internal taker;
    AttestationsMock internal attestations;
    VotiveMock internal votive;

    /// @dev Built once and reused. Two inlined copies of `TakerTraitsLib.build`
    ///      inside this contract exhaust the optimiser's stack — the library is
    ///      large, and this script already carries the whole opcode table.
    bytes internal takerTraits;

    address internal broadcaster;
    address internal treasury;
    uint256 internal opcodeBase;

    function run() external {
        broadcaster = msg.sender;
        treasury = vm.envOr("VOTIVE_TREASURY", address(0xFEE));

        vm.startBroadcast();
        _deploy();
        takerTraits = abi.encodePacked(TakerTraitsLib.build(_takerArgs()));
        ISwapVM.Order memory order = _shipPosition();
        _showRefusalBeforeTheFrontierArrives(order);
        _openTheGates();
        _fill(order);
        vm.stopBroadcast();
    }

    // ------------------------------------------------------------------ setup

    function _deploy() private {
        // The official Aqua contract, unmodified.
        aqua = new Aqua();
        // Our router: the official one, plus four instructions appended to its
        // opcode table. Nothing official is replaced.
        swapVM = new VotiveAquaRouter(address(aqua), address(0), broadcaster);
        opcodeBase = VotiveAquaRouter(payable(address(swapVM))).votiveOpcodeBase();

        tokenA = new TokenMock("Votive Demo A", "VDA");
        tokenB = new TokenMock("Votive Demo B", "VDB");
        taker = new MockTaker(aqua, swapVM, broadcaster);

        attestations = new AttestationsMock();
        votive = new VotiveMock(PRINCIPAL);

        console.log("");
        console.log("  Deployed");
        console.log("  ------------------------------------------------------");
        console.log("  Aqua (official)        %s", address(aqua));
        console.log("  VotiveAquaRouter       %s", address(swapVM));
        console.log("  tokenA / tokenB        %s / %s", address(tokenA), address(tokenB));
        console.log("  MockTaker              %s", address(taker));
        console.log("  opcode base            %s (official table length)", opcodeBase);
        console.log("");
    }

    // ---------------------------------------------------------------- program

    function _instr(uint256 opcode, bytes memory args) private pure returns (bytes memory) {
        require(args.length <= type(uint8).max, "args too long");
        return bytes.concat(bytes1(uint8(opcode)), bytes1(uint8(args.length)), args);
    }

    /// @dev Three gates, then the performance fee bracketing the swap curve.
    function _program() private view returns (bytes memory) {
        Program memory p = ProgramBuilder.init(_opcodes());
        return bytes.concat(
            _instr(opcodeBase + 2, abi.encodePacked(address(votive))),
            _instr(opcodeBase + 0, abi.encodePacked(address(attestations), CAPABILITY)),
            _instr(
                opcodeBase + 1, abi.encodePacked(address(attestations), address(votive), CONDITION)
            ),
            _instr(opcodeBase + 3, abi.encodePacked(bytes32(PRINCIPAL), PERFORMANCE_BPS, treasury)),
            p.build(XYCSwap._xycSwapXD),
            p.build(Controls._salt, abi.encodePacked(uint256(0x2026)))
        );
    }

    function _shipPosition() private returns (ISwapVM.Order memory order) {
        order = MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: broadcaster,
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                receiver: address(0),
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: _program()
            })
        );

        // The maker funds both sides: what it offers, and headroom in the token the
        // performance fee is pulled in so the carve has something to draw on.
        tokenB.mint(broadcaster, MAKER_OUT);
        tokenA.mint(broadcaster, MAKER_IN + FILL);
        tokenA.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(aqua), type(uint256).max);

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        uint256[] memory balances = new uint256[](2);
        balances[0] = MAKER_IN;
        balances[1] = MAKER_OUT;

        bytes32 strategyHash = aqua.ship(address(swapVM), abi.encode(order), tokens, balances);
        require(strategyHash == swapVM.hash(order), "strategy hash mismatch");

        console.log("  Position shipped to Aqua");
        console.log("    strategy hash        %s", vm.toString(strategyHash));
        console.log("    offering             %s of tokenB", MAKER_OUT / 1e18);
        console.log("");
    }

    // ------------------------------------------------------------- the gates

    /// @dev The whole point of the position: before the frontier reaches the job,
    ///      nobody can take the other side of it. Shown rather than asserted,
    ///      because a demo should let you watch the refusal happen.
    ///
    ///      Deliberately outside the broadcast. Foundry replays every recorded call
    ///      when it broadcasts, and a call that is *supposed* to revert would abort
    ///      the whole run at that point — so this one is simulated locally while the
    ///      transactions that matter are the ones that go to the chain.
    function _showRefusalBeforeTheFrontierArrives(ISwapVM.Order memory order) private {
        tokenA.mint(address(taker), FILL);
        vm.stopBroadcast();

        (bool ok, bytes memory reason) = address(taker)
            .call(
                abi.encodeCall(
                    MockTaker.swap, (order, address(tokenA), address(tokenB), FILL, takerTraits)
                )
            );

        vm.startBroadcast();
        require(!ok, "the position filled while its capability gate was shut");
        console.log("  Fill attempted before the frontier arrived");
        console.log("    refused, as it should be (%s bytes of revert data)", reason.length);
        console.log("");
    }

    function _openTheGates() private {
        attestations.setCapabilityOpen(CAPABILITY, true);
        attestations.setConditionMet(address(votive), CONDITION, true);
        console.log("  A model passed the capability check; the wish was attested true.");
        console.log("");
    }

    function _takerArgs() private view returns (TakerTraitsLib.Args memory) {
        return TakerTraitsLib.Args({
            taker: address(taker),
            isExactIn: true,
            shouldUnwrapWeth: false,
            hasPreTransferInCallback: true,
            hasPreTransferOutCallback: false,
            isStrictThresholdAmount: false,
            isFirstTransferFromTaker: false,
            useTransferFromAndAquaPush: false,
            threshold: "",
            to: address(0),
            deadline: 0,
            preTransferInHookData: "",
            postTransferInHookData: "",
            preTransferOutHookData: "",
            postTransferOutHookData: "",
            preTransferInCallbackData: "",
            preTransferOutCallbackData: "",
            instructionsArgs: "",
            signature: ""
        });
    }

    // -------------------------------------------------------------- the fill

    function _fill(ISwapVM.Order memory order) private {
        uint256 takerBefore = tokenB.balanceOf(address(taker));
        uint256 treasuryBefore = tokenA.balanceOf(treasury);

        (uint256 amountIn, uint256 amountOut) =
            taker.swap(order, address(tokenA), address(tokenB), FILL, takerTraits);

        uint256 takerAfter = tokenB.balanceOf(address(taker));
        uint256 treasuryAfter = tokenA.balanceOf(treasury);

        console.log("  Filled");
        console.log("  ------------------------------------------------------");
        console.log("    tokenA in            %s", amountIn);
        console.log("    tokenB out           %s", amountOut);
        console.log("    taker tokenB         %s -> %s", takerBefore, takerAfter);
        console.log("    treasury tokenA      %s -> %s", treasuryBefore, treasuryAfter);
        console.log("");

        require(amountOut > 0, "no tokens moved");
        require(takerAfter > takerBefore, "the taker was not paid");
        require(treasuryAfter > treasuryBefore, "the performance fee was never carved");
        console.log("  Real ERC-20 balances moved through the official Aqua contracts.");
        console.log("");
    }
}
