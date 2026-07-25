// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {TokenMock} from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";
import {MockTaker} from "@1inch/swap-vm-test/mocks/MockTaker.sol";
import {Program, ProgramBuilder} from "@1inch/swap-vm-test/utils/ProgramBuilder.sol";
import {Controls} from "@1inch/swap-vm/instructions/Controls.sol";
import {XYCSwap} from "@1inch/swap-vm/instructions/XYCSwap.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/libs/TakerTraits.sol";
import {AquaOpcodesDebug} from "@1inch/swap-vm/opcodes/AquaOpcodesDebug.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {VotiveAquaRouter} from "../src/VotiveAquaRouter.sol";
import {IVotiveAttestations, IVotiveState} from "../src/interfaces/IVotiveReads.sol";

/// @notice Ship an Aqua position priced off a **real** votive, and try to fill it.
///
/// @dev The demo fill uses mocks for the votive and the attestation registry,
///      which proves the instructions compute correctly but proves nothing about
///      whether they can read the protocol as actually deployed. This script takes
///      the addresses of a live votive and the live registry and prices a position
///      off those — so the gates open and shut because of the real protocol's
///      state, not because a mock was told to say so.
///
///      It reads the votive's `principal()` for the fee threshold rather than
///      taking one as a parameter. The threshold *is* the founder's committed
///      capital; letting a script pass its own would let a demo quietly show a fee
///      being charged on money that was never a gain.
///
///        forge script script/ShipVotivePosition.s.sol:ShipVotivePosition \
///          --rpc-url "$RPC" --private-key "$PK" --broadcast --slow
///
///      Required: AQUA, AQUA_ROUTER, AQUA_TOKEN_A, AQUA_TOKEN_B, AQUA_TAKER,
///      VOTIVE_ADDRESS, VOTIVE_ATTESTATIONS, VOTIVE_CAPABILITY, VOTIVE_CONDITION.
contract ShipVotivePosition is Script, AquaOpcodesDebug {
    using ProgramBuilder for Program;

    constructor() AquaOpcodesDebug(address(0)) {}

    /// @dev 8%, on SwapVM's 1e9 == 100% scale.
    uint32 internal constant PERFORMANCE_BPS = 8e7;

    uint256 internal constant MAKER_IN = 100e18;
    uint256 internal constant MAKER_OUT = 200e18;
    uint256 internal constant FILL = 50e18;

    function _instr(uint256 opcode, bytes memory args) private pure returns (bytes memory) {
        require(args.length <= type(uint8).max, "args too long");
        return bytes.concat(bytes1(uint8(opcode)), bytes1(uint8(args.length)), args);
    }

    function run() external {
        Aqua aqua = Aqua(payable(vm.envAddress("AQUA")));
        VotiveAquaRouter router = VotiveAquaRouter(payable(vm.envAddress("AQUA_ROUTER")));
        TokenMock tokenA = TokenMock(vm.envAddress("AQUA_TOKEN_A"));
        TokenMock tokenB = TokenMock(vm.envAddress("AQUA_TOKEN_B"));
        MockTaker taker = MockTaker(payable(vm.envAddress("AQUA_TAKER")));

        address votive = vm.envAddress("VOTIVE_ADDRESS");
        address attestations = vm.envAddress("VOTIVE_ATTESTATIONS");
        bytes32 capabilityId = vm.envBytes32("VOTIVE_CAPABILITY");
        bytes32 conditionHash = vm.envBytes32("VOTIVE_CONDITION");
        address treasury = vm.envOr("AQUA_TREASURY", address(0xFEE));

        // Read the real protocol before touching anything.
        uint8 state = IVotiveState(votive).state();
        uint256 principal = IVotiveState(votive).principal();
        bool capabilityOpen = IVotiveAttestations(attestations).isCapabilityOpen(capabilityId);
        bool conditionMet = IVotiveAttestations(attestations).isConditionMet(votive, conditionHash);

        console.log("");
        console.log("  Pricing a position off a live votive");
        console.log("  ------------------------------------------------------");
        console.log("  votive                 %s", votive);
        console.log("  state                  %s (1 = Waiting, 2 = Attempting)", state);
        console.log("  principal              %s wei", principal);
        console.log("  capability open        %s", capabilityOpen);
        console.log("  condition met          %s", conditionMet);
        console.log("");

        uint256 base = router.votiveOpcodeBase();
        Program memory p = ProgramBuilder.init(_opcodes());

        bytes memory program = bytes.concat(
            _instr(base + 2, abi.encodePacked(votive)),
            _instr(base + 0, abi.encodePacked(attestations, capabilityId)),
            _instr(base + 1, abi.encodePacked(attestations, votive, conditionHash)),
            _instr(base + 3, abi.encodePacked(bytes32(principal), PERFORMANCE_BPS, treasury)),
            p.build(XYCSwap._xycSwapXD),
            p.build(Controls._salt, abi.encodePacked(block.timestamp))
        );

        vm.startBroadcast();

        ISwapVM.Order memory order = MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: msg.sender,
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
                program: program
            })
        );

        tokenA.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(aqua), type(uint256).max);

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        uint256[] memory balances = new uint256[](2);
        balances[0] = MAKER_IN;
        balances[1] = MAKER_OUT;

        bytes32 strategyHash = aqua.ship(address(router), abi.encode(order), tokens, balances);
        require(strategyHash == router.hash(order), "strategy hash mismatch");

        vm.stopBroadcast();

        console.log("  Position shipped");
        console.log("    strategy hash        %s", vm.toString(strategyHash));
        console.log("    offering             %s of tokenB", MAKER_OUT / 1e18);
        console.log("");

        // Whether it can be filled is the protocol's answer, not ours. The gates
        // are read again here from the same contracts the program will read, so
        // what this prints and what the VM decides cannot disagree.
        bool fillable = capabilityOpen && conditionMet && state >= 1 && state <= 2;

        if (!capabilityOpen) {
            console.log("  Not fillable: the frontier has not reached this wish yet.");
        } else if (!conditionMet) {
            console.log("  Not fillable: the capability is open but this wish is not yet true.");
        } else if (!fillable) {
            console.log("  Not fillable: this votive has already settled.");
        }

        if (fillable) {
            uint256 takerBefore = tokenB.balanceOf(address(taker));
            uint256 treasuryBefore = tokenA.balanceOf(treasury);

            vm.startBroadcast();
            (uint256 amountIn, uint256 amountOut) = taker.swap(
                order,
                address(tokenA),
                address(tokenB),
                FILL,
                abi.encodePacked(TakerTraitsLib.build(_takerArgs(address(taker))))
            );
            vm.stopBroadcast();

            console.log("  Filled against the live votive");
            console.log("    tokenA in            %s", amountIn);
            console.log("    tokenB out           %s", amountOut);
            console.log(
                "    taker tokenB         %s -> %s", takerBefore, tokenB.balanceOf(address(taker))
            );
            console.log(
                "    treasury tokenA      %s -> %s", treasuryBefore, tokenA.balanceOf(treasury)
            );
            require(amountOut > 0, "no tokens moved");
        }

        console.log("");
        console.log("  Add to .env.local:");
        console.log("    NEXT_PUBLIC_AQUA_STRATEGY=%s", vm.toString(strategyHash));
        console.log("    NEXT_PUBLIC_AQUA_VOTIVE=%s", votive);
        console.log("");
    }

    function _takerArgs(address taker) private pure returns (TakerTraitsLib.Args memory) {
        return TakerTraitsLib.Args({
            taker: taker,
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
}
