// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NativeVotive} from "../src/NativeVotive.sol";
import {VotiveBase} from "../src/VotiveBase.sol";
import {Deadlines, Intent, VotiveState} from "../src/VotiveTypes.sol";
import {VotiveTest} from "./helpers/VotiveTest.sol";

/// @notice What happens to a wish nobody comes back for.
contract VotiveEscheatTest is VotiveTest {
    function withFallback() internal view returns (Intent memory intent_) {
        intent_ = defaultIntent();
        intent_.fallbackTo = charity;
    }

    function test_escheatNeedsRealSilence() public {
        NativeVotive votive = openDefault();

        vm.expectRevert(VotiveBase.SilenceTooShort.selector);
        votive.escheat();

        vm.warp(votive.escheatOpensAt() - 1);
        vm.expectRevert(VotiveBase.SilenceTooShort.selector);
        votive.escheat();

        vm.warp(votive.escheatOpensAt());
        votive.escheat();
        assertState(votive, VotiveState.Escheated);
    }

    function test_escheatIsPermissionless() public {
        NativeVotive votive = openVotive(withFallback(), DEPOSIT);
        vm.warp(votive.escheatOpensAt());

        vm.prank(stranger);
        votive.escheat();

        assertState(votive, VotiveState.Escheated);
        assertEq(stranger.balance, 1_000 ether, "the caller gets nothing for calling");
    }

    function test_escheatHonoursTheNamedDestination() public {
        NativeVotive votive = openVotive(withFallback(), DEPOSIT);
        vm.warp(votive.escheatOpensAt());
        votive.escheat();

        // Five years at 2 % is 10 % of principal; the treasury keeps only that.
        assertEq(treasury.balance, 10 ether);
        assertEq(charity.balance, 90 ether);
        assertEq(address(votive).balance, 0);
    }

    function test_withoutADestinationTheTreasuryIsTheBackstop() public {
        NativeVotive votive = openDefault();
        vm.warp(votive.escheatOpensAt());
        votive.escheat();

        assertEq(treasury.balance, DEPOSIT);
        assertEq(charity.balance, 0);
        assertEq(address(votive).balance, 0);
    }

    /// @dev Escheat pays the same schedule as every other route out. It used not
    ///      to, and that was a hole — see the arbitrage test below.
    function test_escheatChargesTheFullSchedule() public {
        NativeVotive votive = openVotive(withFallback(), DEPOSIT);

        vm.prank(stranger);
        (bool ok,) = address(votive).call{value: 100 ether}("");
        assertTrue(ok);

        vm.warp(votive.escheatOpensAt());
        votive.escheat();

        // Five years of streaming on the 100 committed, plus 8 % of the 100 that
        // arrived on top.
        assertEq(votive.performanceCharged(), 8 ether);
        assertEq(treasury.balance, 10 ether + 8 ether);
        assertEq(charity.balance, 182 ether);
        assertEq(address(votive).balance, 0);
    }

    /// @dev The hole this closes. A founder who names themselves as `fallbackTo`
    ///      and takes the minimum escheat clock used to get exactly what a redirect
    ///      would have given them — their money, where they wanted it — for no
    ///      performance fee at all, just by staying quiet. Waiting was strictly
    ///      cheaper than asking, which is not a fee schedule, it is a loophole.
    function test_waitingIsNotCheaperThanAsking() public {
        uint256 offering = 100 ether;
        vm.deal(stranger, offering * 2);

        Deadlines memory quick =
            Deadlines({guardianAfter: 7 days, escheatAfter: 90 days, attemptWindow: 1 days});

        Intent memory selfDealing = defaultIntent();
        selfDealing.fallbackTo = founder;

        // Route A: ask for it back.
        vm.prank(founder);
        NativeVotive asked =
            NativeVotive(payable(factory.open{value: DEPOSIT}(selfDealing, quick, anyTerms())));
        vm.prank(stranger);
        (bool okA,) = address(asked).call{value: offering}("");
        assertTrue(okA);
        vm.warp(block.timestamp + 90 days);
        uint256 treasuryBefore = treasury.balance;
        vm.prank(founder);
        asked.redirect(founder);
        uint256 costOfAsking = treasury.balance - treasuryBefore;

        // Route B: say nothing for ninety days and let it escheat to yourself.
        vm.prank(founder);
        NativeVotive waited =
            NativeVotive(payable(factory.open{value: DEPOSIT}(selfDealing, quick, anyTerms())));
        vm.prank(stranger);
        (bool okB,) = address(waited).call{value: offering}("");
        assertTrue(okB);
        vm.warp(waited.escheatOpensAt());
        treasuryBefore = treasury.balance;
        waited.escheat();
        uint256 costOfWaiting = treasury.balance - treasuryBefore;

        assertEq(costOfWaiting, costOfAsking, "silence must not be a discount");
        assertEq(waited.performanceCharged(), asked.performanceCharged());
        assertEq(waited.performanceCharged(), offering * 8 / 100);
    }

    function test_aHeartbeatPushesEscheatBack() public {
        NativeVotive votive = openDefault();

        vm.warp(block.timestamp + 4 * 365 days);
        vm.prank(founder);
        votive.heartbeat();

        vm.warp(block.timestamp + 4 * 365 days);
        vm.expectRevert(VotiveBase.SilenceTooShort.selector);
        votive.escheat();

        vm.warp(votive.escheatOpensAt());
        votive.escheat();
        assertState(votive, VotiveState.Escheated);
    }

    function test_anAttemptInFlightCannotBeEscheatedOutFromUnderIt() public {
        NativeVotive votive = openDefault();
        beginAttempt(votive);

        vm.warp(votive.escheatOpensAt());
        vm.expectRevert(VotiveBase.WrongState.selector);
        votive.escheat();

        // The attempt window is the release valve: once it lapses, anyone can
        // put the votive back to Waiting and then escheat it.
        votive.endAttempt();
        votive.escheat();
        assertState(votive, VotiveState.Escheated);
    }

    function test_escheatIsTerminal() public {
        NativeVotive votive = openDefault();
        vm.warp(votive.escheatOpensAt());
        votive.escheat();

        vm.expectRevert(VotiveBase.WrongState.selector);
        votive.escheat();

        vm.prank(founder);
        vm.expectRevert(VotiveBase.WrongState.selector);
        votive.redirect(payee);
    }

    function test_aCenturyOfSilenceEmptiesButDoesNotOverdraw() public {
        NativeVotive votive = openVotive(withFallback(), DEPOSIT);

        vm.warp(block.timestamp + 100 * 365 days);
        votive.escheat();

        assertEq(treasury.balance, DEPOSIT);
        assertEq(charity.balance, 0);
        assertEq(address(votive).balance, 0, "emptied exactly, never overdrawn");
    }
}
