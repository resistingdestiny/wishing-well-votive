// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NativeVotive} from "../src/NativeVotive.sol";
import {VotiveBase} from "../src/VotiveBase.sol";
import {Intent, VotiveState} from "../src/VotiveTypes.sol";
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

    /// @dev An escheat delivered nothing, so it earns nothing beyond the rent
    ///      already accrued.
    function test_escheatChargesNoPerformanceFee() public {
        NativeVotive votive = openVotive(withFallback(), DEPOSIT);

        vm.prank(stranger);
        (bool ok,) = address(votive).call{value: 100 ether}("");
        assertTrue(ok);

        vm.warp(votive.escheatOpensAt());
        votive.escheat();

        assertEq(votive.performanceCharged(), 0);
        assertEq(treasury.balance, 10 ether, "streaming fee only");
        assertEq(charity.balance, 190 ether);
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
