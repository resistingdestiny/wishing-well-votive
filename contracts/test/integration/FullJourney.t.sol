// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NativeVotive} from "../../src/NativeVotive.sol";
import {Intent, VotiveKind, VotiveState} from "../../src/VotiveTypes.sol";
import {AgentBountyRail} from "../../src/bounties/AgentBountyRail.sol";
import {HumanBackedAccessGate} from "../../src/gates/HumanBackedAccessGate.sol";
import {AgentStandingAdapter} from "../../src/world/AgentStandingAdapter.sol";
import {AssuranceTiers} from "../../src/world/AssuranceTiers.sol";
import {CommonsPool} from "../../src/world/CommonsPool.sol";
import {HumanBackingRegistry} from "../../src/world/HumanBackingRegistry.sol";
import {StandingLedger} from "../../src/world/StandingLedger.sol";
import {VotiveTest} from "../helpers/VotiveTest.sol";

/// @notice One wish, end to end, through every part of the protocol at once.
///
///         The other suites each hold one piece to its own promises. This one is
///         about the seams: that a founder verified once can open a wish, that an
///         agent verified once can be paid to work on it, that the money it spends
///         getting the work done comes out of a budget belonging to the human
///         behind it, that delivering raises what that human may spend next time —
///         and that a single conduct report closes every one of those doors at
///         once without touching anything already settled.
///
///         If any seam here comes apart, the parts can all still pass their own
///         tests and the protocol is still broken.
contract FullJourneyTest is VotiveTest {
    HumanBackingRegistry internal humans;
    StandingLedger internal ledger;
    AgentStandingAdapter internal adapter;
    CommonsPool internal commons;
    HumanBackedAccessGate internal humanGate;
    AgentBountyRail internal rail;

    address internal reviewer = makeAddr("reviewer");
    address internal supplier = makeAddr("supplier");

    address internal agent = makeAddr("agent");
    address internal agentPayout = makeAddr("agentPayout");
    address internal agentSecondWallet = makeAddr("agentSecondWallet");

    bytes32 internal founderHuman = keccak256("human:the-founder");
    bytes32 internal agentHuman = keccak256("human:the-agent-operator");

    uint64 internal constant EPOCH = 1 days;
    uint256 internal constant COMMONS_BASE = 20 ether;
    uint256 internal constant BOUNTY = 30 ether;

    function setUp() public override {
        super.setUp();

        humans = new HumanBackingRegistry(owner, attestor);
        ledger = new StandingLedger(owner);
        adapter = new AgentStandingAdapter(owner, humans, ledger);
        commons =
            new CommonsPool(owner, humans, ledger, EPOCH, COMMONS_BASE, 0, AssuranceTiers.DEVICE);
        humanGate = new HumanBackedAccessGate(owner, humans, ledger, AssuranceTiers.DEVICE);
        rail = new AgentBountyRail(registry, adapter);

        vm.startPrank(owner);
        ledger.setRecorder(address(adapter), true);
        ledger.setReviewer(reviewer, true);
        adapter.setRail(address(rail), true);
        // The protocol now admits only addresses a verified human stands behind.
        factory.setAccessGate(humanGate);
        vm.stopPrank();

        vm.deal(address(this), 500 ether);
        commons.fund{value: 200 ether}();
        vm.deal(agent, 5 ether);
    }

    // ------------------------------------------------------------- utilities

    function _verify(address wallet, bytes32 humanId, uint8 tier) internal {
        vm.prank(attestor);
        humans.attest(wallet, humanId, tier, EVIDENCE);
    }

    function _bar(bytes32 humanId, StandingLedger.Category category) internal {
        vm.prank(reviewer);
        ledger.reportConduct(humanId, category, StandingLedger.Severity.Critical, EVIDENCE);
    }

    function _realWorldTaskIntent() internal view returns (Intent memory intent_) {
        intent_ = defaultIntent();
        intent_.kind = VotiveKind.RealWorldTask;
        intent_.expenseBudget = 5 ether;
    }

    // ================================================================ the trace

    /// @notice The whole thing, in the order it actually happens.
    ///
    ///         Written as one test on purpose. Each step depends on the state the
    ///         last one left, and splitting them into separate cases would let the
    ///         suite stay green while the seam between any two of them came apart.
    function test_aWishTravelsAllTheWayThrough() public {
        // ---- 1. Nobody unverified gets in ---------------------------------
        assertFalse(humanGate.isPermitted(founder), "unverified founder admitted");
        vm.prank(founder);
        vm.expectRevert();
        factory.open{value: DEPOSIT}(_realWorldTaskIntent(), noOverrides(), anyTerms());

        // ---- 2. A verified founder opens the wish -------------------------
        _verify(founder, founderHuman, AssuranceTiers.SELFIE);
        assertTrue(humanGate.isPermitted(founder));

        NativeVotive votive = openVotive(_realWorldTaskIntent(), DEPOSIT);
        assertEq(uint8(votive.state()), uint8(VotiveState.Waiting));
        assertEq(votive.principal(), DEPOSIT);

        // ---- 3. An unverified agent cannot be paid to work on it ----------
        vm.prank(founder);
        uint256 bountyId = rail.postBounty{value: BOUNTY}(
            address(votive), keccak256("task:file-the-thing"), CAPABILITY, 7 days, 60 days
        );

        vm.prank(agent);
        rail.registerAgent(agentPayout);
        passCapability(); // the frontier has arrived; the gate is not the blocker

        vm.prank(agent);
        vm.expectRevert(AgentBountyRail.NotInGoodStanding.selector);
        rail.claim(bountyId);

        // ---- 4. Verified, it can ------------------------------------------
        _verify(agent, agentHuman, AssuranceTiers.SELFIE);
        vm.prank(agent);
        rail.claim(bountyId);
        assertEq(rail.bountyOf(bountyId).agent, agent);

        // ---- 5. It spends the commons to get the job done -----------------
        assertEq(commons.ceilingOf(agent), COMMONS_BASE, "standing starts at parity");
        uint256 supplierBefore = supplier.balance;

        vm.prank(agent);
        commons.draw(8 ether, supplier);

        assertEq(supplier.balance - supplierBefore, 8 ether, "the supplier was not paid");
        assertEq(commons.remainingOf(agent), COMMONS_BASE - 8 ether);

        // A second wallet of the same operator draws on what is left, not on a
        // fresh allowance. This is the property the whole identity layer exists for.
        _verify(agentSecondWallet, agentHuman, AssuranceTiers.SELFIE);
        assertEq(commons.remainingOf(agentSecondWallet), COMMONS_BASE - 8 ether);

        // ---- 6. The work is attested and the agent is paid ----------------
        bytes32 milestone = keccak256("milestone:filed");
        vm.prank(attestor);
        registry.attestCondition(address(rail), milestone, true, EVIDENCE);
        rail.release(bountyId, milestone, BOUNTY);

        assertEq(rail.credited(agentPayout), BOUNTY, "the agent was not credited");
        assertEq(ledger.standingOf(agentHuman).fulfilments, 1, "the rail did not record delivery");

        uint256 payoutBefore = agentPayout.balance;
        vm.prank(agentPayout);
        rail.withdraw();
        assertEq(agentPayout.balance - payoutBefore, BOUNTY);

        // ---- 7. The wish itself settles -----------------------------------
        vm.prank(executor);
        votive.beginAttempt();
        assertEq(uint8(votive.state()), uint8(VotiveState.Attempting));

        meetCondition(address(votive));
        uint256 founderBefore = founder.balance;

        vm.prank(executor);
        votive.fulfil();

        assertEq(uint8(votive.state()), uint8(VotiveState.Fulfilled));
        assertGt(founder.balance, founderBefore, "the beneficiary was never paid");

        // ---- 8. Delivering bought a larger allowance next epoch -----------
        vm.warp(block.timestamp + EPOCH);
        uint256 raised = (COMMONS_BASE * (10_000 + ledger.FULFILMENT_STEP_BPS())) / 10_000;
        assertEq(commons.ceilingOf(agent), raised, "delivery changed nothing");
        assertGt(raised, COMMONS_BASE);
        // And it applies to the operator's other wallet too, because it is theirs.
        assertEq(commons.ceilingOf(agentSecondWallet), raised);
    }

    // =========================================================== the dark path

    /// @notice The same trace, but the operator turns out to have been working a
    ///         wish that asked for somebody to be hurt.
    ///
    ///         One report has to close every door at once — creating, spending and
    ///         being paid — across every wallet, while leaving settled money alone.
    function test_oneReportClosesEveryDoorAndTouchesNothingSettled() public {
        _verify(founder, founderHuman, AssuranceTiers.SELFIE);
        _verify(agent, agentHuman, AssuranceTiers.ORB);
        _verify(agentSecondWallet, agentHuman, AssuranceTiers.ORB);

        NativeVotive votive = openVotive(_realWorldTaskIntent(), DEPOSIT);
        vm.prank(agent);
        rail.registerAgent(agentPayout);
        passCapability();

        vm.prank(founder);
        uint256 bountyId = rail.postBounty{value: BOUNTY}(
            address(votive), keccak256("task:one"), CAPABILITY, 7 days, 60 days
        );
        vm.prank(agent);
        rail.claim(bountyId);

        // Earned honestly, before anything came to light.
        bytes32 milestone = keccak256("milestone:one");
        vm.prank(attestor);
        registry.attestCondition(address(rail), milestone, true, EVIDENCE);
        rail.release(bountyId, milestone, BOUNTY);
        assertEq(rail.credited(agentPayout), BOUNTY);

        // ---- the report ---------------------------------------------------
        _bar(agentHuman, StandingLedger.Category.ViolenceAgainstPeople);

        // Creating: closed, on both wallets.
        assertFalse(humanGate.isPermitted(agent));
        assertFalse(humanGate.isPermitted(agentSecondWallet));

        // Spending: closed, on both wallets.
        assertEq(commons.ceilingOf(agent), 0);
        assertEq(commons.ceilingOf(agentSecondWallet), 0);
        vm.prank(agentSecondWallet);
        vm.expectRevert(
            abi.encodeWithSelector(CommonsPool.Refused.selector, CommonsPool.Refusal.Barred)
        );
        commons.draw(1 ether, supplier);

        // Being paid for new work: closed.
        vm.prank(founder);
        uint256 next = rail.postBounty{value: 1 ether}(
            address(votive), keccak256("task:two"), CAPABILITY, 7 days, 60 days
        );
        vm.prank(agent);
        vm.expectRevert(AgentBountyRail.NotInGoodStanding.selector);
        rail.claim(next);

        // A fresh wallet is not a fresh start.
        address freshWallet = makeAddr("freshWallet");
        _verify(freshWallet, agentHuman, AssuranceTiers.ORB);
        assertFalse(humanGate.isPermitted(freshWallet));
        assertEq(commons.ceilingOf(freshWallet), 0);

        // ---- but what was already settled is untouched --------------------
        uint256 before = agentPayout.balance;
        vm.prank(agentPayout);
        rail.withdraw();
        assertEq(agentPayout.balance - before, BOUNTY, "settled earnings were confiscated");

        // And the votive that already exists is still live and still fulfillable.
        // Admission is checked at creation and never re-checked; money committed to
        // a wish belongs to that wish.
        assertEq(uint8(votive.state()), uint8(VotiveState.Waiting));
        vm.prank(executor);
        votive.beginAttempt();
        meetCondition(address(votive));
        vm.prank(executor);
        votive.fulfil();
        assertEq(uint8(votive.state()), uint8(VotiveState.Fulfilled));
    }

    // ============================================================ the founder

    /// @notice A founder barred for the wish they wrote cannot open another one —
    ///         which is the direction that matters most, since the wish is the
    ///         thing that asked for harm.
    function test_aBarredFounderCannotOpenAnotherWish() public {
        _verify(founder, founderHuman, AssuranceTiers.SELFIE);
        NativeVotive first = openVotive(_realWorldTaskIntent(), DEPOSIT);

        _bar(founderHuman, StandingLedger.Category.ViolenceAgainstPeople);

        assertFalse(humanGate.isPermitted(founder));
        vm.prank(founder);
        vm.expectRevert();
        factory.open{value: DEPOSIT}(_realWorldTaskIntent(), noOverrides(), anyTerms());

        // The one they already funded is still theirs to redirect or fulfil.
        assertEq(uint8(first.state()), uint8(VotiveState.Waiting));
    }

    /// @notice Failure is not misconduct. An agent that takes work and does not
    ///         deliver loses headroom and keeps its place.
    function test_failingToDeliverCostsHeadroomButNotAccess() public {
        _verify(founder, founderHuman, AssuranceTiers.SELFIE);
        _verify(agent, agentHuman, AssuranceTiers.SELFIE);

        NativeVotive votive = openVotive(_realWorldTaskIntent(), DEPOSIT);
        vm.prank(agent);
        rail.registerAgent(agentPayout);
        passCapability();

        vm.prank(founder);
        uint256 bountyId = rail.postBounty{value: BOUNTY}(
            address(votive), keccak256("task:abandoned"), CAPABILITY, 7 days, 60 days
        );
        vm.prank(agent);
        rail.claim(bountyId);

        // The agent goes quiet; the funder frees the task once the window lapses.
        vm.warp(block.timestamp + 8 days);
        vm.prank(founder);
        rail.releaseClaim(bountyId);

        assertEq(ledger.standingOf(agentHuman).failures, 1);
        assertTrue(humanGate.isPermitted(agent), "a failure locked the agent out");
        assertLt(commons.ceilingOf(agent), COMMONS_BASE);
        assertGt(commons.ceilingOf(agent), 0, "a failure retired the agent");
    }
}
