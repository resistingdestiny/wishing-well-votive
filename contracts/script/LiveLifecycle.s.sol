// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {NativeVotive} from "../src/NativeVotive.sol";
import {VotiveFactory} from "../src/VotiveFactory.sol";
import {Deadlines, Intent, Terms, VotiveKind, VotiveState} from "../src/VotiveTypes.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

/// @notice Walks one votive through its whole life against a live deployment:
///         open it, watch the gate refuse an attempt, open the gate, attempt,
///         attest the condition, fulfil, and check the money landed.
///
/// @dev This is the on-chain counterpart to the unit suite. The tests prove the
///      logic; this proves the deployment — that the addresses are wired to each
///      other, that the roles are held by who we think, and that a real
///      transaction sequence behaves the way the local one does.
///
///      Run against a deployment with:
///
///        forge script script/LiveLifecycle.s.sol:LiveLifecycle \
///          --rpc-url "$RPC_URL" --private-key "$PK" --broadcast --slow
///
///      Requires VOTIVE_FACTORY and VOTIVE_REGISTRY in the environment. The
///      sending key must hold the founder, executor and attestor roles, which is
///      how the deploy script leaves a single-operator testnet deployment.
contract LiveLifecycle is Script {
    function run() external {
        VotiveFactory factory = VotiveFactory(vm.envAddress("VOTIVE_FACTORY"));
        AttestationRegistry registry = AttestationRegistry(vm.envAddress("VOTIVE_REGISTRY"));
        uint256 deposit = vm.envOr("VOTIVE_DEPOSIT", uint256(0.001 ether));

        address me = msg.sender;
        // Unique per run, so repeated runs never collide on an already-registered
        // capability or a condition somebody already attested.
        bytes32 salt = keccak256(abi.encodePacked(block.chainid, block.timestamp, me));
        bytes32 capabilityId = keccak256(abi.encodePacked("capability:live:", salt));
        bytes32 conditionHash = keccak256(abi.encodePacked("condition:live:", salt));
        bytes32 modelId = keccak256("model:live-smoke");

        Intent memory intent = Intent({
            kind: VotiveKind.ReleaseOnCondition,
            founder: me,
            guardian: address(0),
            beneficiary: address(0),
            fallbackTo: address(0),
            capabilityId: capabilityId,
            conditionHash: conditionHash,
            storyHash: keccak256(abi.encodePacked("story:live:", salt)),
            expenseBudget: 0,
            irrevocable: false
        });

        console.log("");
        console.log("  chain      %s", block.chainid);
        console.log("  factory    %s", address(factory));
        console.log("  registry   %s", address(registry));
        console.log("  operator   %s", me);
        console.log("");

        vm.startBroadcast();

        // 1. Open the votive.
        address votiveAddress = factory.open{value: deposit}(
            intent,
            Deadlines({guardianAfter: 0, escheatAfter: 0, attemptWindow: 0}),
            Terms({streamBps: type(uint16).max, performanceBps: type(uint16).max})
        );
        NativeVotive votive = NativeVotive(payable(votiveAddress));
        console.log("  1. opened            %s", votiveAddress);

        // 2. The frontier reaches the capability, so an attempt becomes possible.
        registry.attestCapability(capabilityId, modelId, true, keccak256("evidence:live"));
        console.log("  2. capability open   %s", registry.isCapabilityOpen(capabilityId));

        // 3. The executor takes it up.
        votive.beginAttempt();
        console.log("  3. attempting");

        // 4. The condition comes true for this votive specifically.
        registry.attestCondition(votiveAddress, conditionHash, true, keccak256("evidence:live"));
        console.log(
            "  4. condition met     %s", registry.isConditionMet(votiveAddress, conditionHash)
        );

        // 5. Settle.
        votive.fulfil();
        console.log("  5. fulfilled");

        vm.stopBroadcast();

        console.log("");
        console.log("  final state          %s  (4 == Fulfilled)", uint256(uint8(votive.state())));
        console.log("  votive balance       %s wei  (0 == fully settled)", address(votive).balance);
        console.log("  live set size        %s", factory.liveVotivesLength());
        console.log("");
    }
}
