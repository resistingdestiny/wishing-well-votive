// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NativeVotive} from "../src/NativeVotive.sol";
import {VotiveBase} from "../src/VotiveBase.sol";
import {Deadlines, Intent, Terms, VotiveKind, VotiveState} from "../src/VotiveTypes.sol";
import {VotiveTest} from "./helpers/VotiveTest.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

contract VotiveLifecycleTest is VotiveTest {
    // -------------------------------------------------------------- opening

    function test_open_startsWaitingAndFullyFunded() public {
        NativeVotive votive = openDefault();

        assertState(votive, VotiveState.Waiting);
        assertEq(votive.principal(), DEPOSIT);
        assertEq(votive.parked(), DEPOSIT);
        assertEq(address(votive).balance, DEPOSIT);
        assertEq(votive.offerings(), 0);
        assertEq(votive.asset(), address(0), "native votives report the zero asset");
        assertEq(votive.lastFounderSignal(), block.timestamp);
        assertEq(votive.lastAccrual(), block.timestamp);
    }

    function test_open_freezesTermsAndClocks() public {
        NativeVotive votive = openDefault();

        (uint16 streamBps, uint16 performanceBps) = votive.terms();
        assertEq(streamBps, 200);
        assertEq(performanceBps, 800);

        (uint64 guardianAfter, uint64 escheatAfter, uint64 attemptWindow) = votive.deadlines();
        assertEq(guardianAfter, 365 days);
        assertEq(escheatAfter, 5 * 365 days);
        assertEq(attemptWindow, 7 days);
    }

    function test_open_recordsTheIntentVerbatim() public {
        Intent memory wanted = defaultIntent();
        wanted.guardian = guardian;
        wanted.beneficiary = payee;
        wanted.fallbackTo = charity;

        NativeVotive votive = openVotive(wanted, DEPOSIT);
        Intent memory stored = votive.intent();

        assertEq(uint8(stored.kind), uint8(wanted.kind));
        assertEq(stored.founder, founder);
        assertEq(stored.guardian, guardian);
        assertEq(stored.beneficiary, payee);
        assertEq(stored.fallbackTo, charity);
        assertEq(stored.capabilityId, CAPABILITY);
        assertEq(stored.conditionHash, CONDITION);
        assertEq(stored.storyHash, STORY);
        assertEq(votive.beneficiary(), payee);
    }

    function test_beneficiaryDefaultsToTheFounder() public {
        NativeVotive votive = openDefault();
        assertEq(votive.beneficiary(), founder);
    }

    function test_eachVotiveHasItsOwnStorageAndBalance() public {
        NativeVotive first = openDefault();
        NativeVotive second = openVotive(defaultIntent(), 7 ether);

        assertTrue(address(first) != address(second));
        assertEq(first.principal(), DEPOSIT);
        assertEq(second.principal(), 7 ether);
        assertEq(address(first).balance, DEPOSIT);
        assertEq(address(second).balance, 7 ether);
    }

    function test_theSharedImplementationIsInert() public {
        assertState(implementation, VotiveState.Nascent);
        assertEq(address(implementation).balance, 0);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        implementation.initialize(
            defaultIntent(), noOverrides(), Terms(200, 800), address(registry)
        );
    }

    function test_aVotiveCannotBeReopened() public {
        NativeVotive votive = openDefault();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        votive.initialize(defaultIntent(), noOverrides(), Terms(200, 800), address(registry));
    }

    // ------------------------------------------------------- founder liveness

    function test_heartbeatResetsBothClocks() public {
        NativeVotive votive = openDefault();
        uint256 opened = block.timestamp;

        vm.warp(opened + 200 days);
        vm.prank(founder);
        votive.heartbeat();

        assertEq(votive.lastFounderSignal(), opened + 200 days);
        assertEq(votive.guardianOpensAt(), opened + 200 days + 365 days);
        assertEq(votive.escheatOpensAt(), opened + 200 days + 5 * 365 days);
    }

    function test_heartbeat_onlyFounder() public {
        NativeVotive votive = openDefault();
        vm.prank(stranger);
        vm.expectRevert(VotiveBase.NotFounder.selector);
        votive.heartbeat();
    }

    function test_heartbeat_onlyWhileLive() public {
        NativeVotive votive = openDefault();
        vm.prank(founder);
        votive.redirect(payee);

        vm.prank(founder);
        vm.expectRevert(VotiveBase.WrongState.selector);
        votive.heartbeat();
    }

    // ------------------------------------------------------------- offerings

    function test_anyoneMayAddToALiveVotive() public {
        NativeVotive votive = openDefault();

        vm.prank(stranger);
        (bool ok,) = address(votive).call{value: 5 ether}("");
        assertTrue(ok);

        assertEq(votive.offerings(), 5 ether, "an offering is not principal");
        assertEq(votive.principal(), DEPOSIT);
        assertEq(votive.parked(), DEPOSIT);
    }

    function test_anOfferingFromTheFounderCountsAsPresence() public {
        NativeVotive votive = openDefault();
        vm.warp(block.timestamp + 100 days);

        vm.prank(founder);
        (bool ok,) = address(votive).call{value: 1 ether}("");
        assertTrue(ok);

        assertEq(votive.lastFounderSignal(), block.timestamp);
    }

    function test_offeringsAreRefusedOnceSettled() public {
        NativeVotive votive = openDefault();
        vm.prank(founder);
        votive.redirect(payee);

        vm.prank(stranger);
        (bool ok,) = address(votive).call{value: 1 ether}("");
        assertFalse(ok, "a settled votive takes nothing further");
    }

    // ---------------------------------------------------------------- top-up

    function test_topUpRaisesPrincipal() public {
        NativeVotive votive = openDefault();

        vm.prank(founder);
        votive.topUp{value: 40 ether}();

        assertEq(votive.principal(), 140 ether);
        assertEq(votive.parked(), 140 ether);
        assertEq(votive.offerings(), 0, "a top-up is never an offering");
    }

    function test_topUpSettlesTheOldBaseFirst() public {
        NativeVotive votive = openDefault();
        vm.warp(block.timestamp + 365 days);

        vm.prank(founder);
        votive.topUp{value: 100 ether}();

        // A year at 2 % on the original 100, and not a wei on the new money.
        assertEq(votive.streamAccrued(), 2 ether);
        assertEq(votive.principal(), 200 ether);

        vm.warp(block.timestamp + 365 days);
        // Second year: 2 % of the 200 now committed.
        assertEq(votive.pendingStream(), 4 ether);
    }

    function test_topUp_onlyFounder() public {
        NativeVotive votive = openDefault();
        vm.prank(stranger);
        vm.expectRevert(VotiveBase.NotFounder.selector);
        votive.topUp{value: 1 ether}();
    }

    function test_topUp_rejectsNothing() public {
        NativeVotive votive = openDefault();
        vm.prank(founder);
        vm.expectRevert(VotiveBase.ZeroFunding.selector);
        votive.topUp{value: 0}();
    }

    // -------------------------------------------------------------- attempts

    function test_attemptNeedsAnOpenCapability() public {
        NativeVotive votive = openDefault();

        vm.prank(executor);
        vm.expectRevert(VotiveBase.CapabilityNotOpen.selector);
        votive.beginAttempt();

        passCapability();
        vm.prank(executor);
        votive.beginAttempt();
        assertState(votive, VotiveState.Attempting);
        assertEq(votive.attemptStartedAt(), block.timestamp);
    }

    function test_beginAttempt_onlyExecutor() public {
        NativeVotive votive = openDefault();
        passCapability();

        vm.prank(stranger);
        vm.expectRevert(VotiveBase.NotExecutor.selector);
        votive.beginAttempt();
    }

    function test_beginAttempt_onlyFromWaiting() public {
        NativeVotive votive = openDefault();
        beginAttempt(votive);

        vm.prank(executor);
        vm.expectRevert(VotiveBase.WrongState.selector);
        votive.beginAttempt();
    }

    function test_executorMayStandDownAtWill() public {
        NativeVotive votive = openDefault();
        beginAttempt(votive);

        vm.prank(executor);
        votive.endAttempt();

        assertState(votive, VotiveState.Waiting);
        assertEq(votive.attemptStartedAt(), 0);
    }

    function test_aStalledAttemptIsResettableByAnyone() public {
        NativeVotive votive = openDefault();
        beginAttempt(votive);

        vm.prank(stranger);
        vm.expectRevert(VotiveBase.AttemptStillFresh.selector);
        votive.endAttempt();

        vm.warp(block.timestamp + 7 days);
        vm.prank(stranger);
        votive.endAttempt();
        assertState(votive, VotiveState.Waiting);
    }

    // ------------------------------------------------------------ fulfilment

    function test_fulfilPaysTheBeneficiary() public {
        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = payee;
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        readyToFulfil(votive);

        vm.prank(executor);
        votive.fulfil();

        assertState(votive, VotiveState.Fulfilled);
        assertEq(payee.balance, DEPOSIT, "no fee is due where nothing was gained");
        assertEq(address(votive).balance, 0);
        assertFalse(factory.isLive(address(votive)));
    }

    function test_fulfil_needsTheConditionAttested() public {
        NativeVotive votive = openDefault();
        beginAttempt(votive);

        vm.prank(executor);
        vm.expectRevert(VotiveBase.ConditionNotMet.selector);
        votive.fulfil();
    }

    function test_fulfil_respectsARetractedCondition() public {
        NativeVotive votive = openDefault();
        readyToFulfil(votive);

        vm.prank(attestor);
        registry.attestCondition(address(votive), CONDITION, false, EVIDENCE);

        vm.prank(executor);
        vm.expectRevert(VotiveBase.ConditionNotMet.selector);
        votive.fulfil();
    }

    function test_fulfil_onlyExecutor() public {
        NativeVotive votive = openDefault();
        readyToFulfil(votive);

        vm.prank(stranger);
        vm.expectRevert(VotiveBase.NotExecutor.selector);
        votive.fulfil();
    }

    function test_fulfil_onlyFromAttempting() public {
        NativeVotive votive = openDefault();
        meetCondition(address(votive));

        vm.prank(executor);
        vm.expectRevert(VotiveBase.WrongState.selector);
        votive.fulfil();
    }

    function test_fulfil_isTerminal() public {
        NativeVotive votive = openDefault();
        readyToFulfil(votive);

        vm.prank(executor);
        votive.fulfil();

        vm.prank(executor);
        vm.expectRevert(VotiveBase.WrongState.selector);
        votive.fulfil();
    }

    // --------------------------------------------------------- real-world task

    function test_realWorldTaskReimbursesTheExecutorFirst() public {
        Intent memory intent_ = defaultIntent();
        intent_.kind = VotiveKind.RealWorldTask;
        intent_.expenseBudget = 30 ether;
        intent_.beneficiary = payee;

        NativeVotive votive = openVotive(intent_, DEPOSIT);
        readyToFulfil(votive);

        vm.prank(executor);
        votive.fulfil();

        assertEq(executor.balance, 30 ether, "reimbursed to the ceiling agreed");
        assertEq(payee.balance, 70 ether, "and the rest goes where it was always going");
    }

    function test_realWorldTaskReimbursementIsCappedByWhatIsThere() public {
        Intent memory intent_ = defaultIntent();
        intent_.kind = VotiveKind.RealWorldTask;
        intent_.expenseBudget = 500 ether;

        NativeVotive votive = openVotive(intent_, DEPOSIT);
        readyToFulfil(votive);

        vm.prank(executor);
        votive.fulfil();

        assertEq(executor.balance, DEPOSIT);
        assertEq(address(votive).balance, 0);
    }

    function test_aBudgetOnlyMakesSenseForATask() public {
        Intent memory intent_ = defaultIntent();
        intent_.expenseBudget = 1 ether;

        vm.prank(founder);
        vm.expectRevert(VotiveBase.BadIntent.selector);
        factory.open{value: DEPOSIT}(intent_, noOverrides(), anyTerms());
    }
}
