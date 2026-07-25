// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AquaVotive} from "../src/AquaVotive.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {NativeVotive} from "../src/NativeVotive.sol";
import {VotiveFactory} from "../src/VotiveFactory.sol";
import {OpenAccessGate} from "../src/gates/OpenAccessGate.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

/// @notice Deploys the protocol and wires it up.
///
/// @dev No address is written down in this file, and none ever should be. Roles
///      come from the environment and default to whoever is broadcasting, so a
///      throwaway testnet deployment is one command and a production one is the
///      same command with four variables set. Addresses come out in the log and in
///      Foundry's broadcast artefacts, which are git-ignored — a deployment record
///      belongs to a deployment, not to the source tree.
///
///      Usage:
///
///        forge script script/Deploy.s.sol:Deploy \
///          --rpc-url "$RPC_URL" --account deployer --broadcast
///
///      Optional environment:
///
///        VOTIVE_OWNER     admin of the registry and the factory   (default: sender)
///        VOTIVE_TREASURY  where protocol fees go                  (default: sender)
///        VOTIVE_EXECUTOR  the runtime allowed to attempt/fulfil   (default: sender)
///        VOTIVE_ATTESTOR  the key that posts attestations         (default: sender)
///        VOTIVE_TOKEN     an ERC-20 to allowlist for funding      (default: none)
contract Deploy is Script {
    struct Deployment {
        address registry;
        address accessGate;
        address nativeImplementation;
        address tokenImplementation;
        address factory;
    }

    function run() external returns (Deployment memory out) {
        address sender = msg.sender;
        address owner = vm.envOr("VOTIVE_OWNER", sender);
        address treasury = vm.envOr("VOTIVE_TREASURY", sender);
        address executor = vm.envOr("VOTIVE_EXECUTOR", sender);
        address attestor = vm.envOr("VOTIVE_ATTESTOR", sender);
        address fundingToken = vm.envOr("VOTIVE_TOKEN", address(0));

        vm.startBroadcast();

        AttestationRegistry registry = new AttestationRegistry(owner, attestor);
        OpenAccessGate accessGate = new OpenAccessGate();
        NativeVotive nativeImplementation = new NativeVotive();
        // AquaVotive rather than TokenVotive: it is a strict superset — the same
        // votive, plus the ability to quote its own principal through Aqua. Making
        // it the implementation is what makes *every* token-funded wish a vault
        // that can offer itself, rather than a privilege of specially-deployed ones.
        AquaVotive tokenImplementation = new AquaVotive();

        VotiveFactory factory = new VotiveFactory(
            owner,
            registry,
            address(nativeImplementation),
            address(tokenImplementation),
            treasury,
            executor,
            accessGate
        );

        // The registry and the factory each need the other's address, so one of
        // the two links is made after the fact. Only the owner can make it; when
        // the owner is somebody else, say so plainly rather than reverting three
        // contracts into the deployment and leaving it half-wired.
        bool wired = false;
        if (owner == sender) {
            registry.setFactory(address(factory));
            wired = true;
            if (fundingToken != address(0)) {
                factory.setTokenAllowed(fundingToken, true);
            }
        }

        vm.stopBroadcast();

        out = Deployment({
            registry: address(registry),
            accessGate: address(accessGate),
            nativeImplementation: address(nativeImplementation),
            tokenImplementation: address(tokenImplementation),
            factory: address(factory)
        });

        _report(out, owner, treasury, executor, attestor, fundingToken, wired);
    }

    function _report(
        Deployment memory out,
        address owner,
        address treasury,
        address executor,
        address attestor,
        address fundingToken,
        bool wired
    ) private view {
        console.log("");
        console.log("  Votive deployed to chain %s", block.chainid);
        console.log("  ------------------------------------------------------");
        console.log("  AttestationRegistry  %s", out.registry);
        console.log("  VotiveFactory        %s", out.factory);
        console.log("  OpenAccessGate       %s", out.accessGate);
        console.log("  NativeVotive impl    %s", out.nativeImplementation);
        console.log("  AquaVotive impl      %s", out.tokenImplementation);
        console.log("  ------------------------------------------------------");
        console.log("  owner                %s", owner);
        console.log("  treasury             %s", treasury);
        console.log("  executor             %s", executor);
        console.log("  attestor             %s", attestor);
        if (fundingToken != address(0)) {
            console.log("  funding token        %s", fundingToken);
        }
        console.log("");

        if (!wired) {
            console.log("  STILL TO DO -- the owner is not the sender, so these are left undone:");
            console.log("    registry.setFactory(%s)", out.factory);
            if (fundingToken != address(0)) {
                console.log("    factory.setTokenAllowed(%s, true)", fundingToken);
            }
            console.log("  Until setFactory is called, no votive can be opened.");
            console.log("");
        }
    }
}
