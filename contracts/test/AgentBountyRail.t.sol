// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {AgentBountyRail} from "../src/bounties/AgentBountyRail.sol";
import {IAgentStanding} from "../src/interfaces/IAgentStanding.sol";
import {RejectingReceiver} from "./helpers/Recipients.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Paying an agent for real-world work, in increments, without either
///         side having to trust the other first.
contract AgentBountyRailTest is Test {
    AttestationRegistry internal registry;
    AgentBountyRail internal rail;

    address internal owner = makeAddr("owner");
    address internal attestor = makeAddr("attestor");
    address internal funder = makeAddr("funder");
    address internal agent = makeAddr("agent");
    address internal agentPayout = makeAddr("agent-cold-wallet");
    address internal rival = makeAddr("rival-agent");
    address internal stranger = makeAddr("stranger");
    address internal votive = makeAddr("votive");

    bytes32 internal constant CAPABILITY = keccak256("capability:file-the-paperwork");
    bytes32 internal constant TASK = keccak256("task:file-form-27B-stroke-6");

    uint256 internal constant REWARD = 3 ether;
    uint64 internal constant CLAIM_WINDOW = 7 days;
    uint64 internal constant LIFETIME = 30 days;

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new AttestationRegistry(owner, attestor);
        // No standing gate: this suite is about the escrow mechanics, and the rail
        // ungated behaves exactly as it did before there was anything to gate on.
        rail = new AgentBountyRail(registry, IAgentStanding(address(0)));

        vm.deal(funder, 100 ether);
        vm.prank(agent);
        rail.registerAgent(agentPayout);
    }

    // ---------------------------------------------------------------- helpers

    function post() internal returns (uint256 id) {
        vm.prank(funder);
        id = rail.postBounty{value: REWARD}(votive, TASK, CAPABILITY, CLAIM_WINDOW, LIFETIME);
    }

    function openCapability() internal {
        vm.prank(attestor);
        registry.attestCapability(CAPABILITY, keccak256("model"), true, bytes32(0));
    }

    /// @dev A milestone is a fact about a bounty, so the attestation is bound to
    ///      the bounty id — the same words about a different bounty is a different
    ///      fact, and cannot be spent here.
    function milestone(uint256 id, uint256 index) internal pure returns (bytes32) {
        return keccak256(abi.encode("milestone", id, index));
    }

    function attest(bytes32 milestoneHash) internal {
        vm.prank(attestor);
        registry.attestCondition(address(rail), milestoneHash, true, bytes32(0));
    }

    function claimed() internal returns (uint256 id) {
        id = post();
        openCapability();
        vm.prank(agent);
        rail.claim(id);
    }

    // ---------------------------------------------------------------- posting

    function test_postingEscrowsTheReward() public {
        uint256 id = post();

        assertEq(id, 1);
        assertEq(address(rail).balance, REWARD, "the reward is held, not promised");
        assertEq(rail.escrowed(), REWARD);
        assertEq(rail.remaining(id), REWARD);

        AgentBountyRail.Bounty memory b = rail.bountyOf(id);
        assertEq(b.funder, funder);
        assertEq(b.votive, votive, "traceable back to the wish it serves");
        assertEq(b.total, REWARD);
        assertEq(b.paid, 0);
        assertEq(b.agent, address(0));
    }

    function test_aBountyMustCarryAReward() public {
        vm.prank(funder);
        vm.expectRevert(AgentBountyRail.ZeroReward.selector);
        rail.postBounty{value: 0}(votive, TASK, CAPABILITY, CLAIM_WINDOW, LIFETIME);
    }

    function test_theWindowsHaveFloors() public {
        vm.startPrank(funder);
        vm.expectRevert(AgentBountyRail.WindowTooShort.selector);
        rail.postBounty{value: REWARD}(votive, TASK, CAPABILITY, 1 minutes, LIFETIME);

        vm.expectRevert(AgentBountyRail.LifetimeTooShort.selector);
        rail.postBounty{value: REWARD}(votive, TASK, CAPABILITY, CLAIM_WINDOW, 1 hours);
        vm.stopPrank();
    }

    // --------------------------------------------------------------- claiming

    function test_anAgentCannotClaimWorkNoModelCanDoYet() public {
        uint256 id = post();

        vm.prank(agent);
        vm.expectRevert(AgentBountyRail.CapabilityNotOpen.selector);
        rail.claim(id);

        openCapability();
        vm.prank(agent);
        rail.claim(id);
        assertEq(rail.bountyOf(id).agent, agent);
    }

    function test_anUnregisteredAgentCannotClaim() public {
        uint256 id = post();
        openCapability();

        vm.prank(rival);
        vm.expectRevert(AgentBountyRail.NotRegistered.selector);
        rail.claim(id);
    }

    function test_aClaimIsExclusive() public {
        uint256 id = claimed();

        vm.prank(rival);
        rail.registerAgent(rival);
        vm.prank(rival);
        vm.expectRevert(AgentBountyRail.AlreadyClaimed.selector);
        rail.claim(id);
    }

    function test_theClaimWindowStartsWhenTheClaimIsTaken() public {
        uint256 id = post();
        openCapability();
        vm.warp(block.timestamp + 10 days); // long after posting

        vm.prank(agent);
        rail.claim(id);
        assertEq(
            rail.bountyOf(id).claimExpiresAt,
            block.timestamp + CLAIM_WINDOW,
            "the agent gets its full window regardless of when it arrived"
        );
    }

    function test_aStalledClaimCanBeFreedByAnyone() public {
        uint256 id = claimed();

        vm.prank(stranger);
        vm.expectRevert(AgentBountyRail.ClaimStillHeld.selector);
        rail.releaseClaim(id);

        vm.warp(block.timestamp + CLAIM_WINDOW);
        vm.prank(stranger);
        rail.releaseClaim(id);

        assertEq(rail.bountyOf(id).agent, address(0), "the task is available again");

        // And somebody else can pick it up.
        vm.prank(rival);
        rail.registerAgent(rival);
        vm.prank(rival);
        rail.claim(id);
        assertEq(rail.bountyOf(id).agent, rival);
    }

    function test_anAgentMayHandBackAClaimEarly() public {
        uint256 id = claimed();
        vm.prank(agent);
        rail.releaseClaim(id);
        assertEq(rail.bountyOf(id).agent, address(0));
    }

    // -------------------------------------------------------------- releasing

    function test_aMilestoneMustBeAttestedBeforeItPays() public {
        uint256 id = claimed();
        bytes32 m = milestone(id, 0);

        vm.expectRevert(AgentBountyRail.MilestoneNotAttested.selector);
        rail.release(id, m, 1 ether);

        attest(m);
        rail.release(id, m, 1 ether);
        assertEq(rail.credited(agentPayout), 1 ether);
    }

    /// @notice The point of the whole design: an agent is paid as it goes, not
    ///         once at the end.
    function test_anAgentIsPaidInIncrementsAsItWorks() public {
        uint256 id = claimed();

        for (uint256 i = 0; i < 3; i++) {
            bytes32 m = milestone(id, i);
            attest(m);
            rail.release(id, m, 1 ether);
            assertEq(rail.credited(agentPayout), (i + 1) * 1 ether);
            assertEq(rail.bountyOf(id).paid, (i + 1) * 1 ether);
        }

        assertEq(rail.earned(agent), REWARD);
        assertEq(rail.milestonesDelivered(agent), 3);
        assertTrue(rail.bountyOf(id).closed, "fully paid is fully done");
        assertEq(rail.remaining(id), 0);
    }

    function test_theSameAttestationCannotBeSpentTwice() public {
        uint256 id = claimed();
        bytes32 m = milestone(id, 0);
        attest(m);
        rail.release(id, m, 1 ether);

        vm.expectRevert(AgentBountyRail.MilestoneAlreadyReleased.selector);
        rail.release(id, m, 1 ether);
    }

    function test_aReleaseCannotExceedWhatIsLeft() public {
        uint256 id = claimed();
        bytes32 m = milestone(id, 0);
        attest(m);

        vm.expectRevert(AgentBountyRail.ExceedsRemaining.selector);
        rail.release(id, m, REWARD + 1);
    }

    /// @dev A milestone attested for one bounty must not pay out on another.
    function test_anAttestationIsBoundToItsOwnBounty() public {
        uint256 first = claimed();
        vm.prank(funder);
        uint256 second =
            rail.postBounty{value: REWARD}(votive, TASK, CAPABILITY, CLAIM_WINDOW, LIFETIME);
        vm.prank(agent);
        rail.claim(second);

        bytes32 forFirst = milestone(first, 0);
        attest(forFirst);

        // The hash names the first bounty, so the second cannot spend it — nothing
        // has been attested under a hash bound to the second.
        vm.expectRevert(AgentBountyRail.MilestoneNotAttested.selector);
        rail.release(second, milestone(second, 0), 1 ether);
    }

    function test_releasingNeedsAClaimingAgent() public {
        uint256 id = post();
        bytes32 m = milestone(id, 0);
        attest(m);

        vm.expectRevert(AgentBountyRail.NothingClaimed.selector);
        rail.release(id, m, 1 ether);
    }

    /// @dev Permissionless, because the authority is the registry's, not the
    ///      caller's. A stranger can push a release through and the money still
    ///      goes only where the attestor approved.
    function test_anyoneMayPushAnAttestedReleaseThrough() public {
        uint256 id = claimed();
        bytes32 m = milestone(id, 0);
        attest(m);

        vm.prank(stranger);
        rail.release(id, m, 1 ether);

        assertEq(rail.credited(agentPayout), 1 ether, "to the agent, not the caller");
        assertEq(rail.credited(stranger), 0);
    }

    // ---------------------------------------------------------------- refunds

    function test_whatWasNeverEarnedGoesBack() public {
        uint256 id = claimed();
        bytes32 m = milestone(id, 0);
        attest(m);
        rail.release(id, m, 1 ether);

        vm.warp(block.timestamp + LIFETIME);
        vm.prank(funder);
        rail.refund(id);

        assertEq(rail.credited(funder), REWARD - 1 ether, "only the unearned part");
        assertEq(rail.credited(agentPayout), 1 ether, "the agent keeps what it earned");
        assertTrue(rail.bountyOf(id).closed);
    }

    function test_aFunderCannotPullTheRewardOutFromUnderAWorkingAgent() public {
        // A claim window that outlasts the bounty's lifetime, so there is a
        // stretch where the funder may refund in principle but an agent is still
        // mid-task. That stretch is the one the guard exists for.
        vm.prank(funder);
        uint256 id = rail.postBounty{value: REWARD}(votive, TASK, CAPABILITY, 60 days, LIFETIME);
        openCapability();
        vm.prank(agent);
        rail.claim(id);

        vm.warp(block.timestamp + LIFETIME + 1);
        assertGt(rail.bountyOf(id).claimExpiresAt, block.timestamp, "the agent is still working");

        vm.prank(funder);
        vm.expectRevert(AgentBountyRail.ClaimStillHeld.selector);
        rail.refund(id);

        // Once the agent's window does lapse, the funder is free to reclaim.
        vm.warp(rail.bountyOf(id).claimExpiresAt);
        vm.prank(funder);
        rail.refund(id);
        assertEq(rail.credited(funder), REWARD);
    }

    function test_refundIsForTheFunderAndNotBeforeTime() public {
        uint256 id = post();

        vm.prank(stranger);
        vm.expectRevert(AgentBountyRail.NotTheFunder.selector);
        rail.refund(id);

        vm.prank(funder);
        vm.expectRevert(AgentBountyRail.TooSoonToRefund.selector);
        rail.refund(id);
    }

    // ------------------------------------------------------------- withdrawal

    function test_manyMilestonesOneWithdrawal() public {
        uint256 id = claimed();
        for (uint256 i = 0; i < 3; i++) {
            bytes32 m = milestone(id, i);
            attest(m);
            rail.release(id, m, 1 ether);
        }

        vm.prank(agentPayout);
        uint256 taken = rail.withdraw();

        assertEq(taken, REWARD);
        assertEq(agentPayout.balance, REWARD, "paid to the cold wallet it registered");
        assertEq(rail.credited(agentPayout), 0);
        assertEq(rail.creditedTotal(), 0);
        assertEq(address(rail).balance, 0);
    }

    function test_withdrawingNothingReverts() public {
        vm.prank(stranger);
        vm.expectRevert(AgentBountyRail.NothingCredited.selector);
        rail.withdraw();
    }

    /// @dev A payout address that refuses value can only ever break its own
    ///      withdrawal. Everybody else's money is untouched, which is the reason
    ///      earnings are credited rather than pushed.
    function test_aHostilePayoutAddressBreaksOnlyItself() public {
        RejectingReceiver hostile = new RejectingReceiver();
        vm.prank(rival);
        rail.registerAgent(address(hostile));

        uint256 id = post();
        openCapability();
        vm.prank(rival);
        rail.claim(id);

        bytes32 m = milestone(id, 0);
        attest(m);
        rail.release(id, m, 1 ether); // the release itself still works

        vm.prank(address(hostile));
        vm.expectRevert(AgentBountyRail.TransferFailed.selector);
        rail.withdraw();

        assertEq(rail.credited(address(hostile)), 1 ether, "still owed, not lost");
        assertEq(address(rail).balance, REWARD, "and nobody else is affected");
    }

    // ----------------------------------------------------------- the accounting

    /// @notice Escrow and earnings are different money, and together they are all
    ///         the money. If this ever fails the contract has lost track of whose
    ///         funds it is holding.
    function testFuzz_escrowPlusEarningsIsTheWholeBalance(
        uint96 reward,
        uint8 slices,
        bool refundAtEnd
    ) public {
        reward = uint96(bound(reward, 1_000, 50 ether));
        slices = uint8(bound(slices, 1, 5));

        vm.deal(funder, reward);
        vm.prank(funder);
        uint256 id =
            rail.postBounty{value: reward}(votive, TASK, CAPABILITY, CLAIM_WINDOW, LIFETIME);
        openCapability();
        vm.prank(agent);
        rail.claim(id);

        uint256 slice = reward / (uint256(slices) + 1);
        if (slice > 0) {
            for (uint256 i = 0; i < slices; i++) {
                bytes32 m = milestone(id, i);
                attest(m);
                rail.release(id, m, slice);
                assertEq(rail.escrowed() + rail.creditedTotal(), address(rail).balance);
            }
        }

        if (refundAtEnd) {
            vm.warp(block.timestamp + LIFETIME + CLAIM_WINDOW);
            vm.prank(funder);
            rail.refund(id);
        }

        assertEq(
            rail.escrowed() + rail.creditedTotal(),
            address(rail).balance,
            "escrow plus earnings is the whole balance"
        );
        assertLe(rail.bountyOf(id).paid, rail.bountyOf(id).total, "never overpaid");
    }
}
