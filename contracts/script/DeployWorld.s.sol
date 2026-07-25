// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentBountyRail} from "../src/bounties/AgentBountyRail.sol";
import {HumanBackedAccessGate} from "../src/gates/HumanBackedAccessGate.sol";
import {IAttestationRegistry} from "../src/interfaces/IAttestationRegistry.sol";
import {AgentStandingAdapter} from "../src/world/AgentStandingAdapter.sol";
import {AssuranceTiers} from "../src/world/AssuranceTiers.sol";
import {CommonsPool} from "../src/world/CommonsPool.sol";
import {HumanBackingRegistry} from "../src/world/HumanBackingRegistry.sol";
import {StandingLedger} from "../src/world/StandingLedger.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

/// @notice Deploys the human-backing layer and wires it to an existing protocol.
///
/// @dev Separate from the core deployment on purpose. The protocol runs perfectly
///      well without any of this — votives open, bounties pay — and a deployment
///      should be able to add identity, standing and a commons as a decision rather
///      than as a precondition. Everything here reads an existing
///      `AttestationRegistry` and, optionally, an existing factory.
///
///      Like the core script, no address is written down in this file and none ever
///      should be. Roles come from the environment and default to the broadcaster.
///
///      Usage:
///
///        forge script script/DeployWorld.s.sol:DeployWorld \
///          --rpc-url "$RPC_URL" --account deployer --broadcast
///
///      Required environment:
///
///        VOTIVE_ATTESTATIONS   the AttestationRegistry the bounty rail reads
///
///      Optional environment:
///
///        VOTIVE_OWNER          admin of every contract here      (default: sender)
///        VOTIVE_ATTESTOR       mirrors AgentBook on-chain        (default: sender)
///        VOTIVE_REVIEWER       may file conduct reports          (default: sender)
///        VOTIVE_FACTORY        factory to point at the new gate  (default: none)
///        VOTIVE_EPOCH          allowance window, seconds         (default: 1 day)
///        VOTIVE_BASE_ALLOWANCE per-epoch base allowance, wei     (default: 1e17)
///        VOTIVE_STEP_UP        cumulative draw needing Orb, wei  (default: 0, off)
///        VOTIVE_MIN_ASSURANCE  weakest tier admitted, 0-3        (default: 1, device)
///        VOTIVE_COMMONS_SEED   value to seed the commons, wei    (default: 0)
contract DeployWorld is Script {
    struct Deployment {
        address humanRegistry;
        address standingLedger;
        address standingAdapter;
        address commonsPool;
        address accessGate;
        address bountyRail;
    }

    /// @dev Grouped rather than kept as a dozen locals. Solidity runs out of stack
    ///      slots long before this script runs out of things to configure, and a
    ///      struct is the fix that does not mean turning the optimiser on for a
    ///      deployment script.
    struct Config {
        address owner;
        address attestor;
        address reviewer;
        address attestations;
        address factory;
        uint64 epoch;
        uint256 baseAllowance;
        uint256 stepUp;
        uint8 minAssurance;
        uint256 seed;
    }

    function _config() internal view returns (Config memory cfg) {
        address sender = msg.sender;
        cfg.owner = vm.envOr("VOTIVE_OWNER", sender);
        cfg.attestor = vm.envOr("VOTIVE_ATTESTOR", sender);
        cfg.reviewer = vm.envOr("VOTIVE_REVIEWER", sender);
        cfg.attestations = vm.envAddress("VOTIVE_ATTESTATIONS");
        cfg.factory = vm.envOr("VOTIVE_FACTORY", address(0));
        cfg.epoch = uint64(vm.envOr("VOTIVE_EPOCH", uint256(1 days)));
        cfg.baseAllowance = vm.envOr("VOTIVE_BASE_ALLOWANCE", uint256(0.1 ether));
        cfg.stepUp = vm.envOr("VOTIVE_STEP_UP", uint256(0));
        cfg.minAssurance = uint8(vm.envOr("VOTIVE_MIN_ASSURANCE", uint256(AssuranceTiers.DEVICE)));
        cfg.seed = vm.envOr("VOTIVE_COMMONS_SEED", uint256(0));
    }

    function run() external returns (Deployment memory out) {
        Config memory cfg = _config();

        vm.startBroadcast();

        HumanBackingRegistry humanRegistry = new HumanBackingRegistry(cfg.owner, cfg.attestor);
        StandingLedger ledger = new StandingLedger(cfg.owner);
        AgentStandingAdapter adapter = new AgentStandingAdapter(cfg.owner, humanRegistry, ledger);
        CommonsPool commons = new CommonsPool(
            cfg.owner,
            humanRegistry,
            ledger,
            cfg.epoch,
            cfg.baseAllowance,
            cfg.stepUp,
            cfg.minAssurance
        );
        HumanBackedAccessGate gate =
            new HumanBackedAccessGate(cfg.owner, humanRegistry, ledger, cfg.minAssurance);
        AgentBountyRail rail = new AgentBountyRail(IAttestationRegistry(cfg.attestations), adapter);

        // The permissions that make the parts one system. Only the owner can grant
        // them, so when the owner is somebody else these are reported rather than
        // attempted — a half-wired deployment that looks finished is worse than one
        // that says what is left.
        bool wired = false;
        if (cfg.owner == msg.sender) {
            ledger.setRecorder(address(adapter), true);
            ledger.setReviewer(cfg.reviewer, true);
            adapter.setRail(address(rail), true);
            wired = true;
        }

        if (cfg.seed > 0) commons.fund{value: cfg.seed}();

        vm.stopBroadcast();

        out = Deployment({
            humanRegistry: address(humanRegistry),
            standingLedger: address(ledger),
            standingAdapter: address(adapter),
            commonsPool: address(commons),
            accessGate: address(gate),
            bountyRail: address(rail)
        });

        _report(out, cfg, wired);
    }

    function _report(Deployment memory out, Config memory cfg, bool wired) private view {
        address owner = cfg.owner;
        address attestor = cfg.attestor;
        address reviewer = cfg.reviewer;
        address factory = cfg.factory;
        uint256 seed = cfg.seed;

        console.log("");
        console.log("  Human-backing layer deployed to chain %s", block.chainid);
        console.log("  ------------------------------------------------------");
        console.log("  HumanBackingRegistry   %s", out.humanRegistry);
        console.log("  StandingLedger         %s", out.standingLedger);
        console.log("  AgentStandingAdapter   %s", out.standingAdapter);
        console.log("  CommonsPool            %s", out.commonsPool);
        console.log("  HumanBackedAccessGate  %s", out.accessGate);
        console.log("  AgentBountyRail        %s", out.bountyRail);
        console.log("  ------------------------------------------------------");
        console.log("  owner                  %s", owner);
        console.log("  attestor               %s", attestor);
        console.log("  reviewer               %s", reviewer);
        if (seed > 0) console.log("  commons seeded with    %s wei", seed);
        console.log("");

        if (!wired) {
            console.log("  STILL TO DO -- the owner is not the sender:");
            console.log("    ledger.setRecorder(%s, true)", out.standingAdapter);
            console.log("    ledger.setReviewer(%s, true)", reviewer);
            console.log("    adapter.setRail(%s, true)", out.bountyRail);
            console.log("  Until then no outcome is recorded and standing never moves.");
            console.log("");
        }

        // Swapping the factory's gate is deliberately never done automatically. It
        // changes who may open a votive on a live deployment, and that is a decision
        // somebody should make on purpose rather than inherit from having run a
        // deploy script with an extra variable set.
        if (factory != address(0)) {
            console.log("  TO REQUIRE VERIFICATION FOR NEW VOTIVES, the factory owner calls:");
            console.log("    factory.setAccessGate(%s)", out.accessGate);
            console.log("  on %s", factory);
            console.log("  Votives that already exist are unaffected.");
            console.log("");
        }
    }
}
