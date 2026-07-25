// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NativeVotive} from "../src/NativeVotive.sol";
import {VotiveBase} from "../src/VotiveBase.sol";
import {Intent, VotiveState} from "../src/VotiveTypes.sol";
import {GasHungryReceiver, ReentrantReceiver, RejectingReceiver} from "./helpers/Recipients.sol";
import {VotiveTest} from "./helpers/VotiveTest.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice A settlement must not be blockable by the person it is paying, and
///         value that lands after the fact must not be trapped.
contract VotivePayoutsTest is VotiveTest {
    function test_aRefusedPayoutIsDeferredRatherThanReverted() public {
        RejectingReceiver hostile = new RejectingReceiver();

        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = address(hostile);
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        readyToFulfil(votive);
        vm.prank(executor);
        votive.fulfil();

        assertState(votive, VotiveState.Fulfilled); // the settlement went through anyway
        assertEq(address(hostile).balance, 0);
        assertEq(votive.deferred(address(hostile)), DEPOSIT);
        assertEq(votive.deferredTotal(), DEPOSIT);
        assertEq(address(votive).balance, DEPOSIT, "held for collection, not lost");
    }

    function test_anExpensiveRecipientIsAlsoDeferred() public {
        GasHungryReceiver greedy = new GasHungryReceiver();

        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = address(greedy);
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        readyToFulfil(votive);
        vm.prank(executor);
        votive.fulfil();

        assertEq(votive.deferred(address(greedy)), DEPOSIT, "the push gas ceiling held");
    }

    function test_aDeferredPayoutCanBePulledAtFullGas() public {
        GasHungryReceiver greedy = new GasHungryReceiver();

        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = address(greedy);
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        readyToFulfil(votive);
        vm.prank(executor);
        votive.fulfil();

        vm.prank(address(greedy));
        votive.claimDeferred();

        assertEq(address(greedy).balance, DEPOSIT);
        assertEq(votive.deferred(address(greedy)), 0);
        assertEq(votive.deferredTotal(), 0);
        assertEq(address(votive).balance, 0);
    }

    function test_claimDeferred_isOnlyForWhoeverIsOwed() public {
        RejectingReceiver hostile = new RejectingReceiver();

        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = address(hostile);
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        readyToFulfil(votive);
        vm.prank(executor);
        votive.fulfil();

        vm.prank(stranger);
        vm.expectRevert(VotiveBase.NothingDeferred.selector);
        votive.claimDeferred();
    }

    function test_aRefusedTreasuryPayoutIsDeferredToo() public {
        RejectingReceiver hostile = new RejectingReceiver();
        vm.prank(owner);
        factory.setTreasury(address(hostile));

        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = payee;
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        vm.warp(block.timestamp + 365 days);
        readyToFulfil(votive);
        vm.prank(executor);
        votive.fulfil();

        assertEq(votive.deferred(address(hostile)), 2 ether);
        assertEq(payee.balance, 98 ether, "the beneficiary is not held up by the treasury");
    }

    // ----------------------------------------------------------------- strays

    function test_valueArrivingAfterSettlementGoesBackToTheFounder() public {
        NativeVotive votive = openDefault();
        readyToFulfil(votive);
        vm.prank(executor);
        votive.fulfil();
        assertEq(address(votive).balance, 0);

        // Forced in the only way a settled votive can be: no code path accepts it.
        vm.deal(address(votive), 3 ether);

        uint256 before = founder.balance;
        vm.prank(stranger);
        votive.sweepStray();

        assertEq(founder.balance, before + 3 ether);
        assertEq(address(votive).balance, 0);
    }

    function test_sweepingIsNotAvailableWhileLive() public {
        NativeVotive votive = openDefault();
        vm.expectRevert(VotiveBase.WrongState.selector);
        votive.sweepStray();
    }

    function test_sweepingCannotTouchADeferredPayout() public {
        RejectingReceiver hostile = new RejectingReceiver();

        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = address(hostile);
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        readyToFulfil(votive);
        vm.prank(executor);
        votive.fulfil();

        vm.expectRevert(VotiveBase.NothingToSweep.selector);
        votive.sweepStray();

        vm.deal(address(votive), DEPOSIT + 1 ether);
        uint256 before = founder.balance;
        votive.sweepStray();

        assertEq(founder.balance, before + 1 ether, "only the stray, never the debt");
        assertEq(address(votive).balance, DEPOSIT);
        assertEq(votive.deferred(address(hostile)), DEPOSIT);
    }

    function test_sweepingNothingReverts() public {
        NativeVotive votive = openDefault();
        readyToFulfil(votive);
        vm.prank(executor);
        votive.fulfil();

        vm.expectRevert(VotiveBase.NothingToSweep.selector);
        votive.sweepStray();
    }

    // ------------------------------------------------------------ reentrancy

    function test_aRecipientThatCallsBackInIsTurnedAway() public {
        ReentrantReceiver hostile = new ReentrantReceiver();
        vm.prank(owner);
        factory.setTreasury(address(hostile));

        NativeVotive votive = openDefault();
        hostile.arm(address(votive), abi.encodeCall(votive.settleStream, ()));

        vm.warp(block.timestamp + 365 days);
        votive.settleStream();

        assertTrue(hostile.reentered(), "the recipient did try");
        assertTrue(hostile.reentryReverted(), "and the guard turned it away");
        assertEq(address(hostile).balance, 2 ether, "while the outer payment still landed");
        assertEq(votive.streamPaid(), 2 ether);
    }

    function test_aRecipientCannotReenterASettlement() public {
        ReentrantReceiver hostile = new ReentrantReceiver();

        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = address(hostile);
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        hostile.arm(address(votive), abi.encodeCall(votive.sweepStray, ()));
        readyToFulfil(votive);

        vm.prank(executor);
        votive.fulfil();

        assertState(votive, VotiveState.Fulfilled);
        // Either the callback was refused outright or the push ran out of gas and
        // fell through to the ledger. Both are safe; what must not happen is the
        // recipient draining anything twice.
        assertEq(
            address(hostile).balance + votive.deferred(address(hostile)),
            DEPOSIT,
            "paid exactly once, one way or the other"
        );
    }
}
