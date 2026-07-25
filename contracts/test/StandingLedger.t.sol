// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StandingLedger} from "../src/world/StandingLedger.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

contract StandingLedgerTest is Test {
    StandingLedger internal ledger;

    address internal owner = makeAddr("owner");
    address internal rail = makeAddr("rail");
    address internal reviewer = makeAddr("reviewer");
    address internal stranger = makeAddr("stranger");

    bytes32 internal alice = keccak256("human:alice");
    bytes32 internal mallory = keccak256("human:mallory");
    bytes32 internal evidence = keccak256("evidence");

    function setUp() public {
        ledger = new StandingLedger(owner);
        vm.startPrank(owner);
        ledger.setRecorder(rail, true);
        ledger.setReviewer(reviewer, true);
        vm.stopPrank();
    }

    function _fulfil(bytes32 humanId, uint256 times) internal {
        vm.startPrank(rail);
        for (uint256 i = 0; i < times; i++) {
            ledger.recordFulfilment(humanId);
        }
        vm.stopPrank();
    }

    function _fail(bytes32 humanId, uint256 times) internal {
        vm.startPrank(rail);
        for (uint256 i = 0; i < times; i++) {
            ledger.recordFailure(humanId);
        }
        vm.stopPrank();
    }

    function _report(bytes32 humanId, StandingLedger.Category c, StandingLedger.Severity s)
        internal
    {
        vm.prank(reviewer);
        ledger.reportConduct(humanId, c, s, evidence);
    }

    // -------------------------------------------------------------- multiplier

    /// A human nobody has recorded anything about draws the base allowance. A brand
    /// new operator should be neither boosted nor throttled.
    function test_anUnknownHumanSitsAtParity() public view {
        assertEq(ledger.multiplierBpsOf(alice), ledger.BASE_BPS());
        assertFalse(ledger.isBarred(alice));
    }

    function test_fulfilmentsRaiseTheMultiplier() public {
        _fulfil(alice, 3);
        assertEq(
            ledger.multiplierBpsOf(alice), ledger.BASE_BPS() + 3 * ledger.FULFILMENT_STEP_BPS()
        );
    }

    function test_failuresLowerItWithoutRetiringTheAgent() public {
        _fail(alice, 2);
        assertEq(ledger.multiplierBpsOf(alice), ledger.BASE_BPS() - 2 * ledger.FAILURE_STEP_BPS());
    }

    /// Failing at hard things is the normal shape of the work, so it throttles but
    /// never zeroes: an agent in poor standing keeps a floor to climb back from.
    function test_aLongRunOfFailuresStopsAtTheFloor() public {
        _fail(alice, 50);
        assertEq(ledger.multiplierBpsOf(alice), ledger.MIN_BPS());
        assertFalse(ledger.isBarred(alice), "failure is not misconduct");
    }

    /// Earned trust is capped. An unbounded multiplier would make the commons
    /// drainable by whoever farmed the most cheap fulfilments.
    function test_earnedTrustIsCapped() public {
        _fulfil(alice, 500);
        assertEq(ledger.multiplierBpsOf(alice), ledger.MAX_BPS());
    }

    function test_fulfilmentsOffsetFailures() public {
        _fulfil(alice, 4);
        _fail(alice, 2);
        uint256 expected =
            ledger.BASE_BPS() + 4 * ledger.FULFILMENT_STEP_BPS() - 2 * ledger.FAILURE_STEP_BPS();
        assertEq(ledger.multiplierBpsOf(alice), expected);
    }

    // ------------------------------------------------------------- the barring

    /// The headline case. A wish asking for somebody to be hurt bars the operator
    /// outright, and the multiplier goes to zero rather than merely shrinking.
    function test_aWishForViolenceBarsTheOperatorPermanently() public {
        _fulfil(alice, 20); // a long good record beforehand

        _report(
            alice, StandingLedger.Category.ViolenceAgainstPeople, StandingLedger.Severity.Critical
        );

        assertTrue(ledger.isBarred(alice));
        assertEq(ledger.multiplierBpsOf(alice), 0);

        // Still barred a very long time later.
        vm.warp(block.timestamp + 3650 days);
        assertTrue(ledger.isBarred(alice), "a permanent bar expired");
    }

    /// The severity floor. A reviewer who grades a request for someone's death as
    /// `Minor` has made a mistake, and the safe reading of that mistake is the
    /// category — otherwise one under-filing leaves the operator drawing next block.
    function test_aViolentCategoryCannotBeFiledAwayAsMinor() public {
        _report(alice, StandingLedger.Category.ViolenceAgainstPeople, StandingLedger.Severity.Minor);

        assertTrue(ledger.isBarred(alice), "the floor did not apply");
        assertEq(ledger.multiplierBpsOf(alice), 0);
        assertEq(
            uint8(ledger.standingOf(alice).worstSeverity), uint8(StandingLedger.Severity.Critical)
        );
    }

    function test_theFloorAppliesToEveryHarmCategory() public view {
        StandingLedger.Category[3] memory critical = [
            StandingLedger.Category.ViolenceAgainstPeople,
            StandingLedger.Category.Exploitation,
            StandingLedger.Category.WeaponsOrMassHarm
        ];
        for (uint256 i = 0; i < critical.length; i++) {
            assertEq(
                uint8(ledger.severityFloor(critical[i])),
                uint8(StandingLedger.Severity.Critical),
                "a harm category was not critical"
            );
        }

        assertEq(
            uint8(ledger.severityFloor(StandingLedger.Category.Fraud)),
            uint8(StandingLedger.Severity.Serious)
        );
        assertEq(
            uint8(ledger.severityFloor(StandingLedger.Category.Spam)),
            uint8(StandingLedger.Severity.Minor)
        );
    }

    /// No amount of good behaviour buys past a bar. This is why the multiplier and
    /// the bar are kept as separate questions.
    function test_goodStandingDoesNotBuyPastABar() public {
        _report(alice, StandingLedger.Category.Exploitation, StandingLedger.Severity.Critical);
        _fulfil(alice, 500);

        assertTrue(ledger.isBarred(alice));
        assertEq(ledger.multiplierBpsOf(alice), 0, "fulfilments bought their way out");
    }

    function test_aSeriousReportSuspendsAndThenLapses() public {
        _report(alice, StandingLedger.Category.Fraud, StandingLedger.Severity.Serious);
        assertTrue(ledger.isBarred(alice));

        vm.warp(block.timestamp + ledger.SERIOUS_SUSPENSION() + 1);

        assertFalse(ledger.isBarred(alice), "a suspension became permanent");
        // The standing penalty outlives the suspension — the record is not wiped.
        assertLt(ledger.multiplierBpsOf(alice), ledger.BASE_BPS());
    }

    /// A later, lighter report must not shorten a bar already in force.
    function test_aLighterReportCannotShortenAnExistingBar() public {
        _report(
            alice, StandingLedger.Category.ViolenceAgainstPeople, StandingLedger.Severity.Critical
        );
        _report(alice, StandingLedger.Category.Spam, StandingLedger.Severity.Minor);

        vm.warp(block.timestamp + 3650 days);
        assertTrue(ledger.isBarred(alice), "a minor report unlocked a permanent bar");
    }

    function test_aMinorReportCostsStandingButBarsNothing() public {
        _report(alice, StandingLedger.Category.Spam, StandingLedger.Severity.Minor);

        assertFalse(ledger.isBarred(alice));
        assertEq(ledger.multiplierBpsOf(alice), ledger.BASE_BPS() - ledger.PENALTY_MINOR_BPS());
    }

    // ----------------------------------------------------------------- pardon

    function test_onlyTheOwnerCanPardonAndItIsAnnounced() public {
        _report(
            alice, StandingLedger.Category.ViolenceAgainstPeople, StandingLedger.Severity.Critical
        );

        vm.prank(reviewer);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, reviewer)
        );
        ledger.pardon(alice);

        vm.expectEmit(true, false, false, true, address(ledger));
        emit StandingLedger.Pardoned(alice, owner);
        vm.prank(owner);
        ledger.pardon(alice);

        assertFalse(ledger.isBarred(alice));
    }

    function test_pardoningSomebodyWhoIsNotBarredIsAnError() public {
        vm.prank(owner);
        vm.expectRevert(StandingLedger.NotBarred.selector);
        ledger.pardon(alice);
    }

    // ------------------------------------------------------------ authorisation

    function test_onlyARecorderRecordsOutcomes() public {
        vm.startPrank(stranger);
        vm.expectRevert(StandingLedger.NotRecorder.selector);
        ledger.recordFulfilment(alice);
        vm.expectRevert(StandingLedger.NotRecorder.selector);
        ledger.recordFailure(alice);
        vm.stopPrank();
    }

    /// A recorder can say what happened; it cannot bar anybody.
    function test_aRecorderCannotFileConduct() public {
        vm.prank(rail);
        vm.expectRevert(StandingLedger.NotReviewer.selector);
        ledger.reportConduct(
            alice, StandingLedger.Category.Fraud, StandingLedger.Severity.Serious, evidence
        );
    }

    /// And a reviewer cannot mint standing for itself.
    function test_aReviewerCannotRecordFulfilments() public {
        vm.prank(reviewer);
        vm.expectRevert(StandingLedger.NotRecorder.selector);
        ledger.recordFulfilment(alice);
    }

    function test_revokingARoleTakesEffect() public {
        vm.prank(owner);
        ledger.setRecorder(rail, false);

        vm.prank(rail);
        vm.expectRevert(StandingLedger.NotRecorder.selector);
        ledger.recordFulfilment(alice);
    }

    function test_aReportNeedsASeverity() public {
        vm.prank(reviewer);
        vm.expectRevert(StandingLedger.NoSeverity.selector);
        ledger.reportConduct(
            alice, StandingLedger.Category.Spam, StandingLedger.Severity.None, evidence
        );
    }

    function test_nobodyIsTheZeroHuman() public {
        vm.prank(rail);
        vm.expectRevert(StandingLedger.ZeroHumanId.selector);
        ledger.recordFulfilment(bytes32(0));

        vm.prank(reviewer);
        vm.expectRevert(StandingLedger.ZeroHumanId.selector);
        ledger.reportConduct(
            bytes32(0), StandingLedger.Category.Spam, StandingLedger.Severity.Minor, evidence
        );
    }

    // ------------------------------------------------------------------- scope

    /// One operator's disgrace is not another's. Barring is per human, and that has
    /// to cut both ways to be worth anything.
    function test_barringOneOperatorLeavesEverybodyElseAlone() public {
        _report(
            mallory, StandingLedger.Category.ViolenceAgainstPeople, StandingLedger.Severity.Critical
        );

        assertTrue(ledger.isBarred(mallory));
        assertFalse(ledger.isBarred(alice));
        assertEq(ledger.multiplierBpsOf(alice), ledger.BASE_BPS());
    }

    // ------------------------------------------------------------------- fuzz

    /// However outcomes and reports are interleaved, the multiplier stays inside its
    /// band — or is exactly zero while barred. Nothing overflows, nothing reverts.
    function testFuzz_theMultiplierIsAlwaysBoundedOrZero(
        uint8 fulfilments,
        uint8 failures,
        uint8 reports,
        uint8 severitySeed
    ) public {
        _fulfil(alice, bound(fulfilments, 0, 40));
        _fail(alice, bound(failures, 0, 40));

        uint256 count = bound(reports, 0, 6);
        for (uint256 i = 0; i < count; i++) {
            // Minor or Serious only: Critical is covered by the barred branch below
            // and would make every later assertion trivially about zero.
            StandingLedger.Severity s = (severitySeed + i) % 2 == 0
                ? StandingLedger.Severity.Minor
                : StandingLedger.Severity.Serious;
            StandingLedger.Category c = s == StandingLedger.Severity.Minor
                ? StandingLedger.Category.Spam
                : StandingLedger.Category.Fraud;
            _report(alice, c, s);
        }

        uint256 m = ledger.multiplierBpsOf(alice);
        if (ledger.isBarred(alice)) {
            assertEq(m, 0, "a barred human had an allowance");
        } else {
            assertGe(m, ledger.MIN_BPS());
            assertLe(m, ledger.MAX_BPS());
        }
    }
}
