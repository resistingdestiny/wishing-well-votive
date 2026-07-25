// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NativeVotive} from "../src/NativeVotive.sol";
import {VotiveBase} from "../src/VotiveBase.sol";
import {VotiveLimits} from "../src/VotiveLimits.sol";
import {Intent, VotiveKind, VotiveState} from "../src/VotiveTypes.sol";
import {Merkle} from "./helpers/Merkle.sol";
import {RejectingReceiver} from "./helpers/Recipients.sol";
import {VotiveTest} from "./helpers/VotiveTest.sol";

/// @notice A wish for everyone still waiting: the settled value is allocated
///         across the live set and pulled, rather than paid to one address.
contract ShareWithActiveTest is VotiveTest {
    address[] internal recipients;
    uint256[] internal weights;
    bytes32[] internal leaves;

    function sharedIntent() internal view returns (Intent memory intent_) {
        intent_ = defaultIntent();
        intent_.kind = VotiveKind.ShareWithActive;
    }

    /// @dev Three ordinary votives with different amounts parked, so the
    ///      allocation has something real to be proportional to.
    function openWaitingSet() internal returns (NativeVotive[3] memory set) {
        address[3] memory people = [makeAddr("aisha"), makeAddr("bartek"), makeAddr("chidi")];
        uint256[3] memory amounts = [uint256(100 ether), 200 ether, 300 ether];

        for (uint256 i = 0; i < 3; i++) {
            vm.deal(people[i], amounts[i]);
            Intent memory intent_ = defaultIntent();
            intent_.founder = people[i];
            set[i] = openVotive(intent_, amounts[i]);
        }
    }

    /// @dev Snapshot the live set exactly as an executor would, and build the
    ///      allocation from it. The sharing votive excludes itself: a wish for
    ///      everyone still waiting is not a wish for itself.
    function snapshot(address sharing) internal returns (bytes32 root, uint256 totalWeight) {
        (address[] memory people, uint256[] memory parked, uint256 total) =
            factory.liveShares(address(0), sharing);

        delete recipients;
        delete weights;
        for (uint256 i = 0; i < people.length; i++) {
            recipients.push(people[i]);
            weights.push(parked[i]);
        }

        leaves = Merkle.leaves(recipients, weights);
        root = Merkle.root(leaves);
        totalWeight = total;
    }

    function claim(NativeVotive votive, uint256 index) internal {
        votive.claimShare(index, recipients[index], weights[index], Merkle.proof(leaves, index));
    }

    // ---------------------------------------------------------------- shaping

    function test_aSharedWishMayNotNameARecipient() public {
        Intent memory intent_ = sharedIntent();
        intent_.beneficiary = payee;

        vm.prank(founder);
        vm.expectRevert(VotiveBase.BadIntent.selector);
        factory.open{value: DEPOSIT}(intent_, noOverrides(), anyTerms());
    }

    function test_theTwoFulfilmentRoutesDoNotOverlap() public {
        NativeVotive shared = openVotive(sharedIntent(), DEPOSIT);
        readyToFulfil(shared);

        vm.prank(executor);
        vm.expectRevert(VotiveBase.ShareRequired.selector);
        shared.fulfil();

        NativeVotive ordinary = openDefault();
        readyToFulfil(ordinary);

        vm.prank(executor);
        vm.expectRevert(VotiveBase.NotShared.selector);
        ordinary.fulfilBySharing(keccak256("root"), 1, uint64(block.number));
    }

    function test_fulfilBySharing_onlyExecutorFromAttempting() public {
        NativeVotive shared = openVotive(sharedIntent(), DEPOSIT);

        vm.prank(stranger);
        vm.expectRevert(VotiveBase.NotExecutor.selector);
        shared.fulfilBySharing(keccak256("root"), 1, uint64(block.number));

        vm.prank(executor);
        vm.expectRevert(VotiveBase.WrongState.selector);
        shared.fulfilBySharing(keccak256("root"), 1, uint64(block.number));
    }

    function test_fulfilBySharing_needsTheConditionAttested() public {
        NativeVotive shared = openVotive(sharedIntent(), DEPOSIT);
        beginAttempt(shared);

        vm.prank(executor);
        vm.expectRevert(VotiveBase.ConditionNotMet.selector);
        shared.fulfilBySharing(keccak256("root"), 1, uint64(block.number));
    }

    // ---------------------------------------------------------------- sharing

    function test_theSnapshotWeighsWhatIsParked() public {
        openWaitingSet();
        (, uint256 totalWeight) = snapshot(address(0));

        assertEq(recipients.length, 3);
        assertEq(totalWeight, 600 ether);
        assertEq(weights[0], 100 ether);
        assertEq(weights[2], 300 ether);
    }

    function test_valueIsSharedInProportionToWhatEachHadParked() public {
        openWaitingSet();
        NativeVotive shared = openVotive(sharedIntent(), DEPOSIT);
        (bytes32 root, uint256 totalWeight) = snapshot(address(shared));

        readyToFulfil(shared);
        vm.prank(executor);
        shared.fulfilBySharing(root, totalWeight, uint64(block.number));

        assertState(shared, VotiveState.Fulfilled);
        assertEq(shared.shareTotal(), DEPOSIT);
        assertEq(shared.shareTotalWeight(), totalWeight);
        assertEq(shared.unclaimedShares(), DEPOSIT);

        vm.warp(block.timestamp + VotiveLimits.SHARE_CHALLENGE_WINDOW + 1);

        for (uint256 i = 0; i < recipients.length; i++) {
            claim(shared, i);
        }

        assertEq(recipients.length, 3);
        assertEq(totalWeight, 600 ether);
        assertEq(recipients[0].balance, DEPOSIT * 100 / 600);
        assertEq(recipients[1].balance, DEPOSIT * 200 / 600);
        assertEq(recipients[2].balance, DEPOSIT * 300 / 600);
        assertApproxEqAbs(shared.shareClaimed(), DEPOSIT, 3, "dust rounds down, nothing else");
    }

    function test_claimsAreClosedUntilTheChallengeWindowElapses() public {
        openWaitingSet();
        NativeVotive shared = openVotive(sharedIntent(), DEPOSIT);
        (bytes32 root, uint256 totalWeight) = snapshot(address(shared));

        readyToFulfil(shared);
        vm.prank(executor);
        shared.fulfilBySharing(root, totalWeight, uint64(block.number));

        vm.expectRevert(VotiveBase.ChallengeWindowOpen.selector);
        claim(shared, 0);

        vm.warp(shared.shareChallengeEndsAt() + 1);
        claim(shared, 0);
        assertGt(recipients[0].balance, 0);
    }

    function test_aLeafIsClaimedOnce() public {
        NativeVotive shared = _postedAllocation();

        claim(shared, 0);
        assertTrue(shared.hasClaimedShare(0));

        vm.expectRevert(VotiveBase.AlreadyClaimed.selector);
        claim(shared, 0);
    }

    function test_aBadProofIsRefused() public {
        NativeVotive shared = _postedAllocation();

        bytes32[] memory wrongPath = Merkle.proof(leaves, 1);
        vm.expectRevert(VotiveBase.BadProof.selector);
        shared.claimShare(0, recipients[0], weights[0], wrongPath);

        // Right proof, inflated weight: the leaf no longer hashes to anything in
        // the tree, so the arithmetic is never reached.
        vm.expectRevert(VotiveBase.BadProof.selector);
        shared.claimShare(0, recipients[0], weights[0] * 10, Merkle.proof(leaves, 0));

        // Right proof, someone else's address.
        vm.expectRevert(VotiveBase.BadProof.selector);
        shared.claimShare(0, stranger, weights[0], Merkle.proof(leaves, 0));
    }

    function test_anybodyMayPushSomeoneElsesClaimThrough() public {
        NativeVotive shared = _postedAllocation();

        vm.prank(stranger);
        claim(shared, 0);

        assertGt(recipients[0].balance, 0, "the value goes to the leaf, not the caller");
    }

    function test_aClaimThatCannotBePushedIsDeferred() public {
        RejectingReceiver hostile = new RejectingReceiver();

        Intent memory intent_ = defaultIntent();
        intent_.founder = address(hostile);
        vm.deal(address(hostile), 100 ether);
        vm.prank(address(hostile));
        factory.open{value: 100 ether}(intent_, noOverrides(), anyTerms());

        NativeVotive shared = openVotive(sharedIntent(), DEPOSIT);
        (bytes32 root, uint256 totalWeight) = snapshot(address(shared));
        readyToFulfil(shared);
        vm.prank(executor);
        shared.fulfilBySharing(root, totalWeight, uint64(block.number));
        vm.warp(shared.shareChallengeEndsAt() + 1);

        uint256 index = recipients[0] == address(hostile) ? 0 : 1;
        claim(shared, index);

        assertEq(shared.deferred(address(hostile)), DEPOSIT, "sole recipient, whole pot, deferred");
    }

    // ------------------------------------------------------------- corrections

    function test_theAttestorMayCorrectAMiscomputedAllocation() public {
        openWaitingSet();
        NativeVotive shared = openVotive(sharedIntent(), DEPOSIT);

        // The executor posts an allocation that gives everything to one address.
        address[] memory wrong = new address[](1);
        uint256[] memory wrongWeights = new uint256[](1);
        wrong[0] = stranger;
        wrongWeights[0] = 1;
        bytes32 wrongRoot = Merkle.root(Merkle.leaves(wrong, wrongWeights));

        readyToFulfil(shared);
        vm.prank(executor);
        shared.fulfilBySharing(wrongRoot, 1, uint64(block.number));
        assertEq(shared.shareRoot(), wrongRoot);

        (bytes32 root, uint256 totalWeight) = snapshot(address(shared));
        vm.prank(attestor);
        shared.correctShares(root, totalWeight);

        assertEq(shared.shareRoot(), root);
        assertEq(shared.shareTotalWeight(), totalWeight);
        assertEq(shared.shareTotal(), DEPOSIT, "the pot itself does not move");

        vm.warp(shared.shareChallengeEndsAt() + 1);
        claim(shared, 0);
        assertGt(recipients[0].balance, 0);
        assertEq(stranger.balance, 1_000 ether, "the bad allocation paid nobody");
    }

    function test_correctShares_onlyAttestorAndOnlyInTheWindow() public {
        NativeVotive shared = _postedAllocationBeforeChallengeEnds();

        vm.prank(stranger);
        vm.expectRevert(VotiveBase.NotAttestor.selector);
        shared.correctShares(keccak256("other"), 1);

        vm.prank(owner);
        vm.expectRevert(VotiveBase.NotAttestor.selector);
        shared.correctShares(keccak256("other"), 1);

        vm.warp(shared.shareChallengeEndsAt() + 1);
        vm.prank(attestor);
        vm.expectRevert(VotiveBase.ChallengeWindowClosed.selector);
        shared.correctShares(keccak256("other"), 1);
    }

    function test_correctShares_refusesAnEmptyAllocation() public {
        NativeVotive shared = _postedAllocationBeforeChallengeEnds();

        vm.startPrank(attestor);
        vm.expectRevert(VotiveBase.BadProof.selector);
        shared.correctShares(bytes32(0), 1);

        vm.expectRevert(VotiveBase.BadProof.selector);
        shared.correctShares(keccak256("root"), 0);
        vm.stopPrank();
    }

    // -------------------------------------------------------------- leftovers

    function test_whatNobodyCollectsGoesBackToTheFounder() public {
        NativeVotive shared = _postedAllocation();
        claim(shared, 0);

        uint256 leftover = shared.unclaimedShares();
        assertGt(leftover, 0);

        vm.expectRevert(VotiveBase.ClaimWindowOpen.selector);
        shared.sweepUnclaimedShares();

        vm.warp(shared.shareClaimEndsAt() + 1);

        vm.expectRevert(VotiveBase.ClaimWindowClosed.selector);
        claim(shared, 1);

        uint256 before = founder.balance;
        vm.prank(stranger);
        shared.sweepUnclaimedShares();

        assertEq(founder.balance, before + leftover);
        assertEq(shared.unclaimedShares(), 0);
        assertEq(address(shared).balance, 0);

        vm.expectRevert(VotiveBase.NothingToSweep.selector);
        shared.sweepUnclaimedShares();
    }

    function test_sweepStrayCannotReachIntoAnOpenPot() public {
        NativeVotive shared = _postedAllocation();

        vm.expectRevert(VotiveBase.NothingToSweep.selector);
        shared.sweepStray();

        vm.deal(address(shared), address(shared).balance + 5 ether);
        uint256 before = founder.balance;
        shared.sweepStray();

        assertEq(founder.balance, before + 5 ether, "only the stray");
        assertEq(shared.unclaimedShares(), DEPOSIT, "the pot is untouched");
    }

    function test_nobodyLeftToShareWithReturnsTheWishToItsFounder() public {
        NativeVotive shared = openVotive(sharedIntent(), DEPOSIT);
        readyToFulfil(shared);

        uint256 before = founder.balance;
        vm.prank(executor);
        shared.fulfilBySharing(bytes32(0), 0, uint64(block.number));

        assertEq(founder.balance, before + DEPOSIT);
        assertEq(shared.shareRoot(), bytes32(0));
        assertEq(address(shared).balance, 0);
    }

    function test_theScheduleIsSettledBeforeAnythingIsAllocated() public {
        openWaitingSet();
        NativeVotive shared = openVotive(sharedIntent(), DEPOSIT);

        vm.prank(stranger);
        (bool ok,) = address(shared).call{value: 50 ether}("");
        assertTrue(ok);

        vm.warp(block.timestamp + 365 days);
        (bytes32 root, uint256 totalWeight) = snapshot(address(shared));
        readyToFulfil(shared);
        vm.prank(executor);
        shared.fulfilBySharing(root, totalWeight, uint64(block.number));

        assertEq(treasury.balance, 2 ether + 4 ether, "fees first, allocation second");
        assertEq(shared.shareTotal(), 98 ether + 46 ether);
    }

    // ------------------------------------------------------------------ safety

    /// @dev An allocation whose weights sum to far more than the declared total
    ///      must still not be able to overdraw the pot.
    function test_anOverstatedAllocationCannotOverdrawThePot() public {
        openWaitingSet();
        NativeVotive shared = openVotive(sharedIntent(), DEPOSIT);

        // Every leaf claims the whole declared weight, four times over.
        (address[] memory people,,) = factory.liveShares(address(0), address(shared));
        delete recipients;
        delete weights;
        for (uint256 i = 0; i < people.length; i++) {
            recipients.push(people[i]);
            weights.push(100 ether);
        }
        leaves = Merkle.leaves(recipients, weights);

        readyToFulfil(shared);
        vm.prank(executor);
        shared.fulfilBySharing(Merkle.root(leaves), 100 ether, uint64(block.number));
        vm.warp(shared.shareChallengeEndsAt() + 1);

        uint256 paid;
        for (uint256 i = 0; i < recipients.length; i++) {
            uint256 before = recipients[i].balance + shared.deferred(recipients[i]);
            claim(shared, i);
            paid += recipients[i].balance + shared.deferred(recipients[i]) - before;
        }

        assertEq(paid, DEPOSIT, "the pot is the ceiling, whatever the root says");
        assertEq(address(shared).balance, shared.deferredTotal());
    }

    function testFuzz_sharesNeverExceedThePot(uint96[4] calldata amounts, uint8 claimOrder) public {
        address[] memory people = new address[](4);
        uint256[] memory parked = new uint256[](4);
        uint256 totalWeight;

        for (uint256 i = 0; i < 4; i++) {
            people[i] = makeAddr(string(abi.encodePacked("holder", i)));
            parked[i] = bound(amounts[i], 1, 1_000 ether);
            totalWeight += parked[i];
        }

        delete recipients;
        delete weights;
        for (uint256 i = 0; i < 4; i++) {
            recipients.push(people[i]);
            weights.push(parked[i]);
        }
        leaves = Merkle.leaves(recipients, weights);

        NativeVotive shared = openVotive(sharedIntent(), DEPOSIT);
        readyToFulfil(shared);
        vm.prank(executor);
        shared.fulfilBySharing(Merkle.root(leaves), totalWeight, uint64(block.number));
        vm.warp(shared.shareChallengeEndsAt() + 1);

        for (uint256 step = 0; step < 4; step++) {
            claim(shared, (uint256(claimOrder) + step) % 4);
        }

        assertLe(shared.shareClaimed(), shared.shareTotal());

        uint256 received;
        for (uint256 i = 0; i < 4; i++) {
            received += people[i].balance + shared.deferred(people[i]);
        }
        assertEq(received, shared.shareClaimed());
        assertLe(received, DEPOSIT);
    }

    // ----------------------------------------------------------------- helpers

    function _postedAllocation() private returns (NativeVotive shared) {
        shared = _postedAllocationBeforeChallengeEnds();
        vm.warp(shared.shareChallengeEndsAt() + 1);
    }

    function _postedAllocationBeforeChallengeEnds() private returns (NativeVotive shared) {
        openWaitingSet();
        shared = openVotive(sharedIntent(), DEPOSIT);
        (bytes32 root, uint256 totalWeight) = snapshot(address(shared));
        readyToFulfil(shared);
        vm.prank(executor);
        shared.fulfilBySharing(root, totalWeight, uint64(block.number));
    }
}
