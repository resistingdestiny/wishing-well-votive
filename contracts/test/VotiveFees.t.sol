// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NativeVotive} from "../src/NativeVotive.sol";
import {VotiveBase} from "../src/VotiveBase.sol";
import {Intent, VotiveState} from "../src/VotiveTypes.sol";
import {VotiveTest} from "./helpers/VotiveTest.sol";

/// @notice The second invariant, exercised: fees only ever follow the schedule
///         each votive was opened under, and there is no path out that is not
///         one of them.
contract VotiveFeesTest is VotiveTest {
    uint256 internal constant STREAM_BPS = 200;
    uint256 internal constant PERFORMANCE_BPS = 800;

    function offer(NativeVotive votive, uint256 amount) internal {
        vm.prank(stranger);
        (bool ok,) = address(votive).call{value: amount}("");
        assertTrue(ok);
    }

    // -------------------------------------------------------- streaming fee

    function test_streamAccruesAtTheQuotedRate() public {
        NativeVotive votive = openDefault();
        assertEq(votive.pendingStream(), 0);

        vm.warp(block.timestamp + 365 days);
        assertEq(votive.pendingStream(), 2 ether, "2 % of 100 over a year");

        votive.accrue();
        assertEq(votive.streamAccrued(), 2 ether);
        assertEq(votive.parked(), 98 ether);
        assertEq(votive.unpaidStream(), 2 ether);
        assertEq(votive.pendingStream(), 0, "and the clock resets");
    }

    function test_streamIsProRata() public {
        NativeVotive votive = openDefault();
        vm.warp(block.timestamp + 73 days); // one fifth of a year
        assertEq(votive.pendingStream(), 0.4 ether);
    }

    /// @dev The bill for a stretch of time must not depend on how often somebody
    ///      happened to poke the contract during it.
    function test_streamIsPathIndependent() public {
        NativeVotive pokedOften = openDefault();
        NativeVotive leftAlone = openDefault();

        uint256 start = block.timestamp;
        for (uint256 i = 1; i <= 12; i++) {
            vm.warp(start + (365 days * i) / 12);
            pokedOften.accrue();
        }
        vm.warp(start + 365 days);
        pokedOften.accrue();
        leftAlone.accrue();

        assertEq(leftAlone.streamAccrued(), 2 ether);
        assertLe(
            pokedOften.streamAccrued(),
            leftAlone.streamAccrued(),
            "poking the contract can never cost the founder more"
        );
        assertApproxEqAbs(
            pokedOften.streamAccrued(),
            leftAlone.streamAccrued(),
            13,
            "and never less than a wei of rounding per accrual"
        );
    }

    function test_streamCanNeverExceedPrincipal() public {
        NativeVotive votive = openDefault();

        vm.warp(block.timestamp + 200 * 365 days);
        votive.accrue();

        assertEq(votive.streamAccrued(), DEPOSIT, "clamped, not compounded into debt");
        assertEq(votive.parked(), 0);
    }

    function testFuzz_streamNeverExceedsPrincipal(uint256 elapsed) public {
        elapsed = bound(elapsed, 0, 1_000 * 365 days);
        NativeVotive votive = openDefault();

        vm.warp(block.timestamp + elapsed);
        votive.accrue();

        assertLe(votive.streamAccrued(), votive.principal());
        assertLe(votive.streamAccrued(), DEPOSIT * STREAM_BPS * elapsed / (10_000 * 365 days) + 1);
    }

    function test_streamStopsOnceSettled() public {
        NativeVotive votive = openDefault();
        vm.warp(block.timestamp + 365 days);

        vm.prank(founder);
        votive.redirect(payee);

        uint256 accrued = votive.streamAccrued();
        vm.warp(block.timestamp + 365 days);
        votive.accrue();

        assertEq(votive.streamAccrued(), accrued, "a settled votive stops charging rent");
        assertEq(votive.pendingStream(), 0);
    }

    function test_settleStreamPaysTheTreasuryAndIsPermissionless() public {
        NativeVotive votive = openDefault();
        vm.warp(block.timestamp + 365 days);

        vm.prank(stranger);
        votive.settleStream();

        assertEq(treasury.balance, 2 ether);
        assertEq(votive.streamPaid(), 2 ether);
        assertEq(votive.unpaidStream(), 0);
        assertEq(address(votive).balance, 98 ether);
    }

    function test_settleStreamIsANoOpWhenNothingIsDue() public {
        NativeVotive votive = openDefault();
        votive.settleStream();
        assertEq(treasury.balance, 0);
    }

    function test_settleStreamFollowsTheTreasuryAddress() public {
        NativeVotive votive = openDefault();
        address moved = makeAddr("moved-treasury");

        vm.prank(owner);
        factory.setTreasury(moved);

        vm.warp(block.timestamp + 365 days);
        votive.settleStream();

        assertEq(moved.balance, 2 ether);
        assertEq(treasury.balance, 0);
    }

    // ------------------------------------------------------ performance fee

    function test_performanceFeeAppliesOnlyToOfferings() public {
        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = payee;
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        offer(votive, 50 ether);
        vm.warp(block.timestamp + 365 days);
        readyToFulfil(votive);

        vm.prank(executor);
        votive.fulfil();

        // 2 % of 100 parked for a year, plus 8 % of the 50 that arrived on top.
        assertEq(treasury.balance, 2 ether + 4 ether);
        assertEq(payee.balance, 98 ether + 46 ether);
        assertEq(address(votive).balance, 0);
        assertEq(votive.performanceCharged(), 4 ether);
    }

    function test_noOfferingsMeansNoPerformanceFee() public {
        NativeVotive votive = openDefault();
        readyToFulfil(votive);

        vm.prank(executor);
        votive.fulfil();

        assertEq(votive.performanceCharged(), 0);
        assertEq(treasury.balance, 0);
        assertEq(founder.balance, 1_000 ether, "back to whole, having spent nothing");
    }

    function test_topUpsAreNeverPerformanceCharged() public {
        NativeVotive votive = openDefault();

        vm.prank(founder);
        votive.topUp{value: 100 ether}();

        readyToFulfil(votive);
        vm.prank(executor);
        votive.fulfil();

        assertEq(votive.performanceCharged(), 0);
        assertEq(treasury.balance, 0);
    }

    function test_alreadySettledStreamIsNotChargedTwice() public {
        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = payee;
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        vm.warp(block.timestamp + 365 days);
        votive.settleStream();
        assertEq(treasury.balance, 2 ether);

        readyToFulfil(votive);
        vm.prank(executor);
        votive.fulfil();

        assertEq(treasury.balance, 2 ether, "the stream fee was already taken");
        assertEq(payee.balance, 98 ether);
    }

    /// @dev The streaming fee about to be paid out must not be mistaken for a
    ///      gain and charged the performance fee on its way to the treasury.
    function test_unpaidStreamIsNotCountedAsAGain() public {
        NativeVotive votive = openDefault();
        vm.warp(block.timestamp + 365 days);

        assertEq(votive.offerings(), 0, "rent owed is not a gain");

        readyToFulfil(votive);
        vm.prank(executor);
        votive.fulfil();

        assertEq(votive.performanceCharged(), 0);
        assertEq(treasury.balance, 2 ether);
    }

    // --------------------------------------------------------------- ceiling

    function testFuzz_theTreasuryNeverTakesMoreThanTheSchedule(
        uint96 deposit,
        uint96 offering,
        uint32 elapsed
    ) public {
        deposit = uint96(bound(deposit, 1, 10_000 ether));
        offering = uint96(bound(offering, 0, 10_000 ether));

        vm.deal(founder, deposit);
        vm.deal(stranger, offering);

        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = payee;
        NativeVotive votive = openVotive(intent_, deposit);

        if (offering > 0) offer(votive, offering);
        vm.warp(block.timestamp + elapsed);

        readyToFulfil(votive);
        vm.prank(executor);
        votive.fulfil();

        uint256 maxStream = uint256(deposit) * STREAM_BPS * elapsed / (10_000 * 365 days);
        if (maxStream > deposit) maxStream = deposit;
        uint256 maxPerformance = uint256(offering) * PERFORMANCE_BPS / 10_000;

        assertLe(treasury.balance, maxStream + maxPerformance + 1, "fee schedule is a ceiling");
        assertEq(
            treasury.balance + payee.balance,
            uint256(deposit) + uint256(offering),
            "and everything else belongs to the wish"
        );
    }

    function testFuzz_valueIsConservedAcrossEveryRoute(uint8 route, uint96 offering) public {
        offering = uint96(bound(offering, 0, 1_000 ether));
        vm.deal(stranger, offering);

        Intent memory intent_ = defaultIntent();
        intent_.beneficiary = payee;
        intent_.fallbackTo = charity;
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        if (offering > 0) offer(votive, offering);
        vm.warp(block.timestamp + 400 days);

        uint256 total = DEPOSIT + offering;

        if (route % 3 == 0) {
            readyToFulfil(votive);
            vm.prank(executor);
            votive.fulfil();
        } else if (route % 3 == 1) {
            vm.prank(founder);
            votive.redirect(payee);
        } else {
            vm.warp(block.timestamp + 5 * 365 days);
            votive.escheat();
        }

        assertEq(address(votive).balance, 0, "nothing is left behind");
        assertEq(
            treasury.balance + payee.balance + charity.balance + founder.balance,
            1_000 ether - DEPOSIT + total,
            "value is conserved whichever way it ends"
        );
    }
}
