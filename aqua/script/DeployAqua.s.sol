// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {TokenMock} from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";
import {MockTaker} from "@1inch/swap-vm-test/mocks/MockTaker.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {VotiveAquaRouter} from "../src/VotiveAquaRouter.sol";

/// @notice Puts the Aqua stack on a public chain, next to the deployed protocol.
///
/// @dev The demo fill runs everything on a local node in one process, which is
///      enough to show the instructions working but leaves the integration
///      unreachable from anywhere else — a frontend cannot read a position that
///      only exists inside a `forge script` run.
///
///      This deploys the same contracts to whatever chain the RPC points at, so
///      the position is a thing with an address that anyone can query. The
///      official `Aqua` contract is deployed rather than looked up because Aqua is
///      not on Base Sepolia; the bytecode is the package's, unmodified.
///
///      Two demo tokens come with it. A position needs a pair, and depending on a
///      faucet for testnet tokens is a good way to have a demo fail for a reason
///      that has nothing to do with the protocol.
///
///        forge script script/DeployAqua.s.sol:DeployAqua \
///          --rpc-url "$RPC" --private-key "$PK" --broadcast --slow
contract DeployAqua is Script {
    function run() external {
        address deployer = msg.sender;
        address owner = vm.envOr("AQUA_OWNER", deployer);

        vm.startBroadcast();

        Aqua aqua = new Aqua();
        VotiveAquaRouter router = new VotiveAquaRouter(address(aqua), address(0), owner);
        TokenMock tokenA = new TokenMock("Votive Demo A", "VDA");
        TokenMock tokenB = new TokenMock("Votive Demo B", "VDB");
        MockTaker taker = new MockTaker(aqua, router, owner);

        // Give the deployer something to ship and the taker something to pay
        // with, so a position can be opened and filled without a second step.
        tokenA.mint(deployer, 1_000e18);
        tokenB.mint(deployer, 1_000e18);
        tokenA.mint(address(taker), 500e18);

        vm.stopBroadcast();

        console.log("");
        console.log("  Aqua stack deployed to chain %s", block.chainid);
        console.log("  ------------------------------------------------------");
        console.log("  Aqua (official)        %s", address(aqua));
        console.log("  VotiveAquaRouter       %s", address(router));
        console.log("  tokenA (VDA)           %s", address(tokenA));
        console.log("  tokenB (VDB)           %s", address(tokenB));
        console.log("  MockTaker              %s", address(taker));
        console.log("  votive opcode base     %s", router.votiveOpcodeBase());
        console.log("  ------------------------------------------------------");
        console.log("");
        console.log("  Add to .env.local:");
        console.log("    NEXT_PUBLIC_AQUA=%s", address(aqua));
        console.log("    NEXT_PUBLIC_AQUA_ROUTER=%s", address(router));
        console.log("    NEXT_PUBLIC_AQUA_TOKEN_A=%s", address(tokenA));
        console.log("    NEXT_PUBLIC_AQUA_TOKEN_B=%s", address(tokenB));
        console.log("    NEXT_PUBLIC_AQUA_TAKER=%s", address(taker));
        console.log("");
    }
}
