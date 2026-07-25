// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NativeVotive} from "../src/NativeVotive.sol";
import {VotiveBase} from "../src/VotiveBase.sol";
import {Intent, VotiveKind, VotiveState} from "../src/VotiveTypes.sol";
import {Merkle} from "./helpers/Merkle.sol";
import {VotiveTest} from "./helpers/VotiveTest.sol";

/// @notice Two recipients a share allocation must refuse, because paying them is
///         worse than not paying at all.
///
///         Both are reachable through an allocation the executor posts. Neither is
///         reachable through an *honest* allocation — `liveShares` never yields
///         either address — so this is about what happens when the executor is
///         wrong or malicious, which is exactly the case the challenge window and
///         the solvency clamp exist for.
contract ShareRecipientsTest is VotiveTest {
    function sharedIntent() internal view returns (Intent memory intent_) {
        intent_ = defaultIntent();
        intent_.kind = VotiveKind.ShareWithActive;
    }

    /// @dev Posts a single-leaf allocation naming `account`, then tries to claim it.
    function postAndClaim(address account, uint256 weight) internal returns (NativeVotive votive) {
        votive = openVotive(sharedIntent(), DEPOSIT);
        readyToFulfil(votive);

        bytes32 root = Merkle.leafOf(0, account, weight);
        vm.prank(executor);
        votive.fulfilBySharing(root, weight, uint64(block.number));

        vm.warp(votive.shareChallengeEndsAt() + 1);
        votive.claimShare(0, account, weight, new bytes32[](0));
    }

    /// @dev A transfer to the zero address *succeeds* at the EVM level, so without
    ///      a guard the pot drains into it: no revert, no deferral, and no event
    ///      that says anything went wrong. The value is simply gone.
    function test_aLeafNamingNobodyIsRefused() public {
        NativeVotive votive = openVotive(sharedIntent(), DEPOSIT);
        readyToFulfil(votive);

        bytes32 root = Merkle.leafOf(0, address(0), 1);
        vm.prank(executor);
        votive.fulfilBySharing(root, 1, uint64(block.number));
        vm.warp(votive.shareChallengeEndsAt() + 1);

        vm.expectRevert(VotiveBase.BadRecipient.selector);
        votive.claimShare(0, address(0), 1, new bytes32[](0));

        // Refused rather than burned: the pot is untouched and still claimable by
        // a corrected allocation, or sweepable back to the founder at the end.
        assertEq(votive.unclaimedShares(), DEPOSIT);
        assertEq(address(votive).balance, DEPOSIT);
    }

    /// @dev A leaf naming the votive itself would push to `address(this)`, fail
    ///      (a settled votive refuses value), and land in `deferred[votive]` —
    ///      which nothing can ever claim, because the votive cannot call
    ///      `claimDeferred` on its own behalf. Stranded for good.
    function test_aLeafNamingTheVotiveItselfIsRefused() public {
        NativeVotive votive = openVotive(sharedIntent(), DEPOSIT);
        readyToFulfil(votive);

        bytes32 root = Merkle.leafOf(0, address(votive), 1);
        vm.prank(executor);
        votive.fulfilBySharing(root, 1, uint64(block.number));
        vm.warp(votive.shareChallengeEndsAt() + 1);

        vm.expectRevert(VotiveBase.BadRecipient.selector);
        votive.claimShare(0, address(votive), 1, new bytes32[](0));

        assertEq(votive.deferred(address(votive)), 0, "nothing stranded in an unclaimable entry");
        assertEq(votive.unclaimedShares(), DEPOSIT);
    }

    /// @dev The griefing route that made this reachable in practice: a stranger
    ///      opens a cheap votive whose beneficiary *is* the sharing votive, so the
    ///      address turns up in `liveShares` and an honest executor puts it in the
    ///      tree. Refusing the claim keeps the slice in the pot.
    function test_aGrieferCannotStrandPartOfThePot() public {
        NativeVotive shared = openVotive(sharedIntent(), DEPOSIT);

        Intent memory griefer = defaultIntent();
        griefer.founder = stranger;
        griefer.beneficiary = address(shared);
        openVotive(griefer, 100 ether);

        (address[] memory people, uint256[] memory parked, uint256 totalWeight) =
            factory.liveShares(address(0), address(shared));

        bool namesTheVotive;
        for (uint256 i = 0; i < people.length; i++) {
            if (people[i] == address(shared)) namesTheVotive = true;
        }
        assertTrue(namesTheVotive, "the snapshot really does surface it");

        bytes32[] memory leaves = Merkle.leaves(people, parked);
        readyToFulfil(shared);
        vm.prank(executor);
        shared.fulfilBySharing(Merkle.root(leaves), totalWeight, uint64(block.number));
        vm.warp(shared.shareChallengeEndsAt() + 1);

        uint256 index;
        for (uint256 i = 0; i < people.length; i++) {
            if (people[i] == address(shared)) index = i;
        }

        vm.expectRevert(VotiveBase.BadRecipient.selector);
        shared.claimShare(index, address(shared), parked[index], Merkle.proof(leaves, index));

        // The slice was never paid out and never stranded, so once the claim
        // window closes it goes back to the founder like any other remainder.
        vm.warp(shared.shareClaimEndsAt() + 1);
        uint256 before = founder.balance;
        shared.sweepUnclaimedShares();
        assertGt(founder.balance, before);
        assertEq(shared.unclaimedShares(), 0);
    }

    /// @dev And the ordinary case still works, so the guard is not over-broad.
    function test_anOrdinaryLeafStillClaims() public {
        NativeVotive votive = postAndClaim(payee, 1);
        assertEq(payee.balance, DEPOSIT);
        assertEq(votive.unclaimedShares(), 0);
    }
}
