// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AttestationRegistry} from "../../src/AttestationRegistry.sol";
import {AgentBountyRail} from "../../src/bounties/AgentBountyRail.sol";
import {HumanBackedAccessGate} from "../../src/gates/HumanBackedAccessGate.sol";
import {AgentStandingAdapter} from "../../src/world/AgentStandingAdapter.sol";
import {AssuranceTiers} from "../../src/world/AssuranceTiers.sol";
import {CommonsPool} from "../../src/world/CommonsPool.sol";
import {HumanBackingRegistry} from "../../src/world/HumanBackingRegistry.sol";
import {StandingLedger} from "../../src/world/StandingLedger.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The whole integration wired together, exercised the way a deployment
///         actually runs it.
///
///         The unit suites each prove one contract keeps its own promises. This one
///         is about the promises that only exist *between* them: that delivering
///         work raises the allowance the same operator can draw next time, that
///         asking for somebody to be hurt removes that operator from every surface
///         at once, and that a new wallet does not undo any of it.
contract HumanBackedFlowTest is Test {
    AttestationRegistry internal attestations;
    HumanBackingRegistry internal humans;
    StandingLedger internal ledger;
    AgentStandingAdapter internal adapter;
    CommonsPool internal commons;
    HumanBackedAccessGate internal gate;
    AgentBountyRail internal rail;

    address internal owner = makeAddr("owner");
    address internal attestor = makeAddr("attestor");
    address internal reviewer = makeAddr("reviewer");
    address internal funder = makeAddr("funder");
    address internal supplier = makeAddr("supplier");

    address internal agent = makeAddr("agent");
    address internal agentPayout = makeAddr("agentPayout");
    address internal secondWallet = makeAddr("secondWallet");

    bytes32 internal operator = keccak256("human:operator");
    bytes32 internal evidence = keccak256("evidence");
    bytes32 internal capability = keccak256("capability:translate-a-dead-language");

    uint64 internal constant EPOCH = 1 days;
    uint256 internal constant BASE = 10 ether;

    function setUp() public {
        attestations = new AttestationRegistry(owner, attestor);
        humans = new HumanBackingRegistry(owner, attestor);
        ledger = new StandingLedger(owner);
        adapter = new AgentStandingAdapter(owner, humans, ledger);
        commons = new CommonsPool(owner, humans, ledger, EPOCH, BASE, 0, AssuranceTiers.DEVICE);
        gate = new HumanBackedAccessGate(owner, humans, ledger, AssuranceTiers.DEVICE);
        rail = new AgentBountyRail(attestations, adapter);

        vm.startPrank(owner);
        // The adapter records on the rail's behalf; the ledger only listens to it.
        ledger.setRecorder(address(adapter), true);
        ledger.setReviewer(reviewer, true);
        adapter.setRail(address(rail), true);
        vm.stopPrank();

        vm.deal(funder, 1_000 ether);
        vm.deal(agent, 10 ether);
        vm.prank(funder);
        commons.fund{value: 200 ether}();

        // The capability the bounty needs is open.
        vm.prank(attestor);
        attestations.attestCapability(capability, keccak256("frontier-model"), true, evidence);
    }

    function _attestHuman(address wallet, bytes32 humanId, uint8 tier) internal {
        vm.prank(attestor);
        humans.attest(wallet, humanId, tier, evidence);
    }

    function _postAndClaim(uint256 reward) internal returns (uint256 id) {
        vm.prank(funder);
        id = rail.postBounty{value: reward}(
            address(0), keccak256(abi.encode("task", reward)), capability, 7 days, 60 days
        );
        vm.prank(agent);
        rail.claim(id);
    }

    function _deliver(uint256 id, uint256 amount) internal {
        bytes32 milestone = keccak256(abi.encode("milestone", id, amount));
        vm.prank(attestor);
        attestations.attestCondition(address(rail), milestone, true, evidence);
        rail.release(id, milestone, amount);
    }

    // --------------------------------------------------------- the happy path

    /// An operator verifies once, and everything downstream opens up: admission,
    /// a commons allowance, and the right to take on paid work.
    function test_verifyingOnceOpensEverySurface() public {
        assertFalse(gate.isPermitted(agent), "unverified but admitted");
        assertEq(commons.ceilingOf(agent), 0);
        assertFalse(adapter.mayWork(agent));

        _attestHuman(agent, operator, AssuranceTiers.SELFIE);

        assertTrue(gate.isPermitted(agent), "verified but not admitted");
        assertEq(commons.ceilingOf(agent), BASE);
        assertTrue(adapter.mayWork(agent));
    }

    /// The loop the whole design is for: draw from the commons to pay a supplier,
    /// deliver the work, get paid, and find next epoch's allowance larger for it.
    function test_deliveredWorkRaisesTheAllowanceItCanDrawNextTime() public {
        _attestHuman(agent, operator, AssuranceTiers.SELFIE);
        vm.prank(agent);
        rail.registerAgent(agentPayout);

        // Spend commons capital on an input the job needs.
        vm.prank(agent);
        commons.draw(3 ether, supplier);
        assertEq(supplier.balance, 3 ether);
        assertEq(commons.remainingOf(agent), BASE - 3 ether);

        // Do the work and get paid for it.
        uint256 id = _postAndClaim(5 ether);
        _deliver(id, 5 ether);

        assertEq(rail.credited(agentPayout), 5 ether);
        assertEq(ledger.standingOf(operator).fulfilments, 1, "the rail did not record it");

        // Next epoch, the same operator may draw more than before.
        vm.warp(block.timestamp + EPOCH);
        uint256 raised = (BASE * (10_000 + ledger.FULFILMENT_STEP_BPS())) / 10_000;
        assertEq(commons.ceilingOf(agent), raised, "delivering changed nothing");
        assertGt(raised, BASE);
    }

    /// Failing to deliver costs headroom but is not misconduct — the agent stays in
    /// the system and can climb back.
    function test_lettingAClaimLapseCostsHeadroomButNotAccess() public {
        _attestHuman(agent, operator, AssuranceTiers.SELFIE);
        vm.prank(agent);
        rail.registerAgent(agentPayout);

        uint256 id = _postAndClaim(5 ether);

        // The agent goes quiet; somebody else frees the task once the window lapses.
        vm.warp(block.timestamp + 8 days);
        vm.prank(funder);
        rail.releaseClaim(id);

        assertEq(ledger.standingOf(operator).failures, 1);
        assertTrue(adapter.mayWork(agent), "a failure locked the agent out");
        assertLt(commons.ceilingOf(agent), BASE);
        assertGt(commons.ceilingOf(agent), 0);
    }

    /// Handing a task back yourself is free, so the rail never teaches an agent to
    /// sit on a claim it cannot finish.
    function test_givingATaskBackHonestlyCostsNothing() public {
        _attestHuman(agent, operator, AssuranceTiers.SELFIE);
        vm.prank(agent);
        rail.registerAgent(agentPayout);

        uint256 id = _postAndClaim(5 ether);
        vm.prank(agent);
        rail.releaseClaim(id);

        assertEq(ledger.standingOf(operator).failures, 0, "honesty was penalised");
        assertEq(commons.ceilingOf(agent), BASE);
    }

    // ------------------------------------------------------ the malicious wish

    /// The headline path. An operator behind a wish for somebody's death is barred,
    /// and that single act closes admission, the commons, and the right to take
    /// paid work — for every wallet they hold, in the same block, without anybody
    /// touching the identity registry.
    function test_aWishToHaveSomebodyKilledRemovesTheOperatorEverywhere() public {
        _attestHuman(agent, operator, AssuranceTiers.ORB);
        _attestHuman(secondWallet, operator, AssuranceTiers.ORB);
        vm.prank(agent);
        rail.registerAgent(agentPayout);

        // Established and trusted beforehand.
        uint256 id = _postAndClaim(5 ether);
        _deliver(id, 5 ether);
        assertTrue(gate.isPermitted(agent));
        assertGt(commons.ceilingOf(secondWallet), 0);

        vm.prank(reviewer);
        ledger.reportConduct(
            operator,
            StandingLedger.Category.ViolenceAgainstPeople,
            StandingLedger.Severity.Critical,
            keccak256("wish text: have this person killed")
        );

        // Admission: closed, on both wallets.
        assertFalse(gate.isPermitted(agent));
        assertFalse(gate.isPermitted(secondWallet));

        // The commons: closed, on both wallets.
        assertEq(commons.ceilingOf(agent), 0);
        assertEq(commons.ceilingOf(secondWallet), 0);
        vm.prank(secondWallet);
        vm.expectRevert(
            abi.encodeWithSelector(CommonsPool.Refused.selector, CommonsPool.Refusal.Barred)
        );
        commons.draw(1 ether, supplier);

        // Paid work: closed.
        assertFalse(adapter.mayWork(agent));
        vm.prank(funder);
        uint256 next = rail.postBounty{value: 1 ether}(
            address(0), keccak256("another task"), capability, 7 days, 60 days
        );
        vm.prank(agent);
        vm.expectRevert(AgentBountyRail.NotInGoodStanding.selector);
        rail.claim(next);
    }

    /// Money the operator had already earned stays theirs. The bar is an exclusion,
    /// not a fine — and a rail that confiscated settled earnings would be a rail
    /// nobody sane would work for.
    function test_aBarDoesNotConfiscateWhatWasAlreadyEarned() public {
        _attestHuman(agent, operator, AssuranceTiers.SELFIE);
        vm.prank(agent);
        rail.registerAgent(agentPayout);

        uint256 id = _postAndClaim(5 ether);
        _deliver(id, 5 ether);

        vm.prank(reviewer);
        ledger.reportConduct(
            operator,
            StandingLedger.Category.Exploitation,
            StandingLedger.Severity.Critical,
            evidence
        );

        uint256 before = agentPayout.balance;
        vm.prank(agentPayout);
        uint256 taken = rail.withdraw();

        assertEq(taken, 5 ether);
        assertEq(agentPayout.balance - before, 5 ether, "earnings were confiscated");
    }

    /// And a fresh wallet gets a barred operator nowhere, which is the reason any of
    /// this is keyed to a human instead of an address.
    function test_aFreshWalletDoesNotEscapeABar() public {
        vm.prank(reviewer);
        ledger.reportConduct(
            operator,
            StandingLedger.Category.WeaponsOrMassHarm,
            StandingLedger.Severity.Critical,
            evidence
        );

        address thirdWallet = makeAddr("thirdWallet");
        _attestHuman(thirdWallet, operator, AssuranceTiers.ORB);

        assertFalse(gate.isPermitted(thirdWallet));
        assertEq(commons.ceilingOf(thirdWallet), 0);
        assertFalse(adapter.mayWork(thirdWallet));
    }

    /// The registry cannot be used to launder a barred operator onto a clean
    /// identifier in one move — that is the two-step rebinding rule, seen from the
    /// outside.
    function test_theRegistryCannotLaunderABarredOperator() public {
        _attestHuman(agent, operator, AssuranceTiers.ORB);
        vm.prank(reviewer);
        ledger.reportConduct(
            operator,
            StandingLedger.Category.ViolenceAgainstPeople,
            StandingLedger.Severity.Critical,
            evidence
        );

        bytes32 cleanIdentifier = keccak256("human:someone-else");
        vm.prank(attestor);
        vm.expectRevert(
            abi.encodeWithSelector(
                HumanBackingRegistry.WalletBoundToAnotherHuman.selector, operator
            )
        );
        humans.attest(agent, cleanIdentifier, AssuranceTiers.ORB, evidence);

        assertFalse(gate.isPermitted(agent));
    }

    // ------------------------------------------------------------ the commons

    /// Two operators are metered independently; one being barred does not touch the
    /// other's allowance.
    function test_oneOperatorsDisgraceIsNotAnothers() public {
        bytes32 other = keccak256("human:other");
        address otherAgent = makeAddr("otherAgent");

        _attestHuman(agent, operator, AssuranceTiers.SELFIE);
        _attestHuman(otherAgent, other, AssuranceTiers.SELFIE);

        vm.prank(reviewer);
        ledger.reportConduct(
            operator,
            StandingLedger.Category.ViolenceAgainstPeople,
            StandingLedger.Severity.Critical,
            evidence
        );

        assertEq(commons.ceilingOf(agent), 0);
        assertEq(commons.ceilingOf(otherAgent), BASE);
        assertTrue(gate.isPermitted(otherAgent));
    }

    /// Everything an operator draws across every wallet comes out of one bucket,
    /// end to end through the real contracts.
    function test_theCommonsIsMeteredPerOperatorNotPerWallet() public {
        _attestHuman(agent, operator, AssuranceTiers.SELFIE);
        _attestHuman(secondWallet, operator, AssuranceTiers.SELFIE);

        vm.prank(agent);
        commons.draw(7 ether, supplier);
        vm.prank(secondWallet);
        commons.draw(3 ether, supplier);

        assertEq(supplier.balance, BASE);
        assertEq(commons.remainingOf(agent), 0);
        assertEq(commons.remainingOf(secondWallet), 0);
    }
}
