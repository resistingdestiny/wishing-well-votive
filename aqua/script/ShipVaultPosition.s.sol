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

/// @notice The wish itself as the maker: one vault per wish, quoting its own
///         principal, gated on who is allowed to fill it.
///
/// @dev The earlier script had a market-maker ship inventory and merely *price* it
///      off a votive. This is the version the design is actually about: the votive
///      holds the principal and ships it, so the thing being offered is the wish's
///      own money and the program is what protects it.
///
///      The program carries all seven instructions:
///        - the wish must be live, its capability open, its condition attested;
///        - the filler must be human-backed and in good standing;
///        - a better-standing agent is paid more for the same work;
///        - the protocol's fee comes out of the surplus alone.
///
///      Everything it reads is the deployed protocol. Nothing here is a mock.
interface IAquaVotive {
    function configureAqua(address aqua, address router) external;
    function shipToAqua(bytes calldata strategy, address quoteToken, uint256 offer, uint256 asking)
        external
        returns (bytes32);
    function isPositionOpen() external view returns (bool);
    function positionBalances() external view returns (uint256, uint256);
    function parked() external view returns (uint256);
    function token() external view returns (address);
}

contract ShipVaultPosition is Script, AquaOpcodesDebug {
    using ProgramBuilder for Program;

    constructor() AquaOpcodesDebug(address(0)) {}

    uint32 internal constant PERFORMANCE_BPS = 8e7; // 8% on the 1e9 scale
    uint32 internal constant BONUS_BPS = 5e7; // up to 5% more for a good record
    uint32 internal constant MIN_STANDING_BPS = 10_000; // parity

    function _instr(uint256 opcode, bytes memory args) private pure returns (bytes memory) {
        require(args.length <= type(uint8).max, "args too long");
        return bytes.concat(bytes1(uint8(opcode)), bytes1(uint8(args.length)), args);
    }

    function run() external {
        address votive = vm.envAddress("VOTIVE_ADDRESS");
        address aqua = vm.envAddress("AQUA");
        address router = vm.envAddress("AQUA_ROUTER");
        address quoteToken = vm.envAddress("AQUA_TOKEN_B");
        address attestations = vm.envAddress("VOTIVE_ATTESTATIONS");
        address humans = vm.envAddress("VOTIVE_HUMAN_REGISTRY");
        address standing = vm.envAddress("VOTIVE_STANDING_LEDGER");
        bytes32 capabilityId = vm.envBytes32("VOTIVE_CAPABILITY");
        bytes32 conditionHash = vm.envBytes32("VOTIVE_CONDITION");
        address treasury = vm.envOr("AQUA_TREASURY", address(0xFEE));
        uint256 offer = vm.envUint("VOTIVE_OFFER");

        uint256 principal = IVotiveState(votive).principal();
        uint8 state = IVotiveState(votive).state();

        console.log("");
        console.log("  The wish as its own vault");
        console.log("  ------------------------------------------------------");
        console.log("  votive            %s", votive);
        console.log("  state             %s (1 = Waiting)", state);
        console.log("  principal         %s", principal);
        console.log("  parked            %s", IAquaVotive(votive).parked());
        console.log("  offering          %s of its own principal", offer);
        console.log("");

        uint256 base = VotiveAquaRouter(payable(router)).votiveOpcodeBase();
        Program memory p = ProgramBuilder.init(_opcodes());

        // Seven instructions: three on the wish, two on the filler, one bonus,
        // one fee. The order matters — gates before the curve, fee bracketing it.
        bytes memory program = bytes.concat(
            _instr(base + 2, abi.encodePacked(votive)),
            _instr(base + 0, abi.encodePacked(attestations, capabilityId)),
            _instr(base + 1, abi.encodePacked(attestations, votive, conditionHash)),
            _instr(base + 4, abi.encodePacked(humans, uint8(1))),
            _instr(base + 5, abi.encodePacked(humans, standing, MIN_STANDING_BPS)),
            _instr(base + 6, abi.encodePacked(humans, standing, BONUS_BPS)),
            _instr(base + 3, abi.encodePacked(bytes32(principal), PERFORMANCE_BPS, treasury)),
            p.build(XYCSwap._xycSwapXD),
            p.build(Controls._salt, abi.encodePacked(block.timestamp))
        );

        ISwapVM.Order memory order = MakerTraitsLib.build(
            MakerTraitsLib.Args({
                // The votive is the maker. Its own principal is what is offered.
                maker: votive,
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

        vm.startBroadcast();
        if (!IAquaVotive(votive).isPositionOpen()) {
            IAquaVotive(votive).configureAqua(aqua, router);
            bytes32 hash = IAquaVotive(votive)
                .shipToAqua(abi.encode(order), quoteToken, offer, vm.envUint("VOTIVE_ASKING"));
            console.log("  Position shipped by the votive itself");
            console.log("    strategy        %s", vm.toString(hash));
        } else {
            console.log("  A position is already open for this votive.");
        }
        vm.stopBroadcast();

        (uint256 principalSide, uint256 quoteSide) = IAquaVotive(votive).positionBalances();
        console.log("    declared        %s of principal token", principalSide);
        console.log("    declared        %s of quote token", quoteSide);
        console.log("");
        console.log("  The principal has not moved. Aqua custodies nothing; the");
        console.log("  votive still holds it, and the program is what decides");
        console.log("  whether anybody may take any of it.");
        console.log("");
    }
}
