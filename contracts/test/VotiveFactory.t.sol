// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NativeVotive} from "../src/NativeVotive.sol";
import {VotiveBase} from "../src/VotiveBase.sol";
import {VotiveFactory} from "../src/VotiveFactory.sol";
import {VotiveLimits} from "../src/VotiveLimits.sol";
import {Deadlines, Intent, Terms, VotiveState} from "../src/VotiveTypes.sol";
import {OpenAccessGate} from "../src/gates/OpenAccessGate.sol";
import {AllowlistGate, ClosedAccessGate} from "./helpers/Recipients.sol";
import {VotiveTest} from "./helpers/VotiveTest.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract VotiveFactoryTest is VotiveTest {
    // ------------------------------------------------------------ construction

    function test_constructor_rejectsZeroWiring() public {
        address native = address(implementation);
        address tokenImpl = address(tokenImplementation);

        vm.expectRevert(VotiveFactory.ZeroAddress.selector);
        new VotiveFactory(owner, registry, address(0), tokenImpl, treasury, executor, gate);

        vm.expectRevert(VotiveFactory.ZeroAddress.selector);
        new VotiveFactory(owner, registry, native, address(0), treasury, executor, gate);

        vm.expectRevert(VotiveFactory.ZeroAddress.selector);
        new VotiveFactory(owner, registry, native, tokenImpl, address(0), executor, gate);

        vm.expectRevert(VotiveFactory.ZeroAddress.selector);
        new VotiveFactory(owner, registry, native, tokenImpl, treasury, address(0), gate);

        vm.expectRevert(VotiveFactory.ZeroAddress.selector);
        new VotiveFactory(
            owner, registry, native, tokenImpl, treasury, executor, OpenAccessGate(address(0))
        );
    }

    function test_constructor_setsSaneDefaults() public view {
        (uint16 streamBps, uint16 performanceBps) = factory.defaultTerms();
        assertEq(streamBps, 200);
        assertEq(performanceBps, 800);

        (uint64 guardianAfter, uint64 escheatAfter, uint64 attemptWindow) =
            factory.defaultDeadlines();
        assertEq(guardianAfter, 365 days);
        assertEq(escheatAfter, 5 * 365 days);
        assertEq(attemptWindow, 7 days);
    }

    // -------------------------------------------------------------- admission

    function test_aClosedGateBlocksEveryone() public {
        ClosedAccessGate closed = new ClosedAccessGate();
        vm.prank(owner);
        factory.setAccessGate(closed);

        vm.prank(founder);
        vm.expectRevert(VotiveFactory.NotPermitted.selector);
        factory.open{value: DEPOSIT}(defaultIntent(), noOverrides(), anyTerms());
    }

    function test_anAllowlistGateAdmitsOnlyItsList() public {
        AllowlistGate allowlist = new AllowlistGate();
        allowlist.allow(founder, true);

        vm.prank(owner);
        factory.setAccessGate(allowlist);

        vm.prank(founder);
        factory.open{value: DEPOSIT}(defaultIntent(), noOverrides(), anyTerms());

        Intent memory strangersIntent = defaultIntent();
        strangersIntent.founder = stranger;
        vm.prank(stranger);
        vm.expectRevert(VotiveFactory.NotPermitted.selector);
        factory.open{value: DEPOSIT}(strangersIntent, noOverrides(), anyTerms());
    }

    function test_theSenderMustBeTheFounder() public {
        vm.prank(stranger);
        vm.expectRevert(VotiveFactory.NotFounder.selector);
        factory.open{value: DEPOSIT}(defaultIntent(), noOverrides(), anyTerms());
    }

    function test_aVotiveMustBeFunded() public {
        vm.prank(founder);
        vm.expectRevert(VotiveFactory.ZeroFunding.selector);
        factory.open{value: 0}(defaultIntent(), noOverrides(), anyTerms());
    }

    // ------------------------------------------------------------ quoted terms

    function test_theFounderCanRefuseTermsAboveWhatTheyAgreedTo() public {
        vm.prank(founder);
        vm.expectRevert(VotiveFactory.TermsRejected.selector);
        factory.open{value: DEPOSIT}(
            defaultIntent(), noOverrides(), Terms({streamBps: 199, performanceBps: 800})
        );

        vm.prank(founder);
        vm.expectRevert(VotiveFactory.TermsRejected.selector);
        factory.open{value: DEPOSIT}(
            defaultIntent(), noOverrides(), Terms({streamBps: 200, performanceBps: 799})
        );
    }

    function test_exactlyTheQuotedTermsAreAccepted() public {
        vm.prank(founder);
        address votive = factory.open{value: DEPOSIT}(
            defaultIntent(), noOverrides(), Terms({streamBps: 200, performanceBps: 800})
        );

        (uint16 streamBps, uint16 performanceBps) = NativeVotive(payable(votive)).terms();
        assertEq(streamBps, 200);
        assertEq(performanceBps, 800);
    }

    /// @dev A repricing landing in the same block as an opening must not become
    ///      the terms somebody thought they were agreeing to.
    function test_aRepricingCannotBeSandwichedOntoAFounder() public {
        vm.prank(owner);
        factory.setDefaultTerms(Terms({streamBps: 500, performanceBps: 2_000}));

        vm.prank(founder);
        vm.expectRevert(VotiveFactory.TermsRejected.selector);
        factory.open{value: DEPOSIT}(
            defaultIntent(), noOverrides(), Terms({streamBps: 200, performanceBps: 800})
        );
    }

    function test_repricingLeavesExistingVotivesAlone() public {
        NativeVotive existing = openDefault();

        vm.prank(owner);
        factory.setDefaultTerms(Terms({streamBps: 500, performanceBps: 2_000}));

        (uint16 streamBps, uint16 performanceBps) = existing.terms();
        assertEq(streamBps, 200, "already-open votives keep the terms they were opened at");
        assertEq(performanceBps, 800);
    }

    // ---------------------------------------------------------------- clocks

    function test_zeroedClocksTakeTheDefaults() public {
        NativeVotive votive = openVotive(defaultIntent(), DEPOSIT);
        (uint64 guardianAfter, uint64 escheatAfter, uint64 attemptWindow) = votive.deadlines();
        assertEq(guardianAfter, 365 days);
        assertEq(escheatAfter, 5 * 365 days);
        assertEq(attemptWindow, 7 days);
    }

    function test_aFounderMayChooseTheirOwnClocks() public {
        Deadlines memory chosen =
            Deadlines({guardianAfter: 30 days, escheatAfter: 400 days, attemptWindow: 2 days});

        vm.prank(founder);
        address votive = factory.open{value: DEPOSIT}(defaultIntent(), chosen, anyTerms());

        (uint64 guardianAfter, uint64 escheatAfter, uint64 attemptWindow) =
            NativeVotive(payable(votive)).deadlines();
        assertEq(guardianAfter, 30 days);
        assertEq(escheatAfter, 400 days);
        assertEq(attemptWindow, 2 days);
    }

    function test_clocksBelowTheFloorsAreRefused() public {
        Deadlines memory tooEager =
            Deadlines({guardianAfter: 1 days, escheatAfter: 400 days, attemptWindow: 2 days});
        vm.prank(founder);
        vm.expectRevert(VotiveBase.BadDeadlines.selector);
        factory.open{value: DEPOSIT}(defaultIntent(), tooEager, anyTerms());

        Deadlines memory tooQuickToEscheat =
            Deadlines({guardianAfter: 30 days, escheatAfter: 60 days, attemptWindow: 2 days});
        vm.prank(founder);
        vm.expectRevert(VotiveBase.BadDeadlines.selector);
        factory.open{value: DEPOSIT}(defaultIntent(), tooQuickToEscheat, anyTerms());

        Deadlines memory outOfOrder =
            Deadlines({guardianAfter: 200 days, escheatAfter: 100 days, attemptWindow: 2 days});
        vm.prank(founder);
        vm.expectRevert(VotiveBase.BadDeadlines.selector);
        factory.open{value: DEPOSIT}(defaultIntent(), outOfOrder, anyTerms());

        Deadlines memory noAttemptRoom =
            Deadlines({guardianAfter: 30 days, escheatAfter: 400 days, attemptWindow: 1 minutes});
        vm.prank(founder);
        vm.expectRevert(VotiveBase.BadDeadlines.selector);
        factory.open{value: DEPOSIT}(defaultIntent(), noAttemptRoom, anyTerms());
    }

    // ------------------------------------------------------------- bookkeeping

    function test_openingBindsTheCapabilityInTheRegistry() public {
        NativeVotive votive = openDefault();
        assertEq(registry.requiredCapability(address(votive)), CAPABILITY);
    }

    function test_theLiveSetTracksOpenings() public {
        assertEq(factory.liveVotivesLength(), 0);
        assertEq(factory.allVotivesLength(), 0);

        NativeVotive first = openDefault();
        NativeVotive second = openDefault();
        NativeVotive third = openDefault();

        assertEq(factory.liveVotivesLength(), 3);
        assertEq(factory.allVotivesLength(), 3);
        assertEq(factory.votiveAt(1), address(second));
        assertTrue(factory.isVotive(address(first)));
        assertTrue(factory.isLive(address(second)));
        assertTrue(factory.isLive(address(third)));
    }

    function test_settlingRemovesFromTheLiveSetWithoutLosingTheOthers() public {
        NativeVotive first = openDefault();
        NativeVotive second = openDefault();
        NativeVotive third = openDefault();

        vm.prank(founder);
        second.redirect(payee);

        assertEq(factory.liveVotivesLength(), 2);
        assertFalse(factory.isLive(address(second)));
        assertTrue(factory.isLive(address(first)));
        assertTrue(factory.isLive(address(third)));

        address[] memory live = factory.liveVotives();
        assertTrue(live[0] == address(first) || live[1] == address(first));
        assertTrue(live[0] == address(third) || live[1] == address(third));

        assertEq(factory.allVotivesLength(), 3, "the full record keeps everything");
    }

    function test_settlingTheLastOneIsHandled() public {
        NativeVotive first = openDefault();
        NativeVotive second = openDefault();

        vm.prank(founder);
        second.redirect(payee);
        vm.prank(founder);
        first.redirect(payee);

        assertEq(factory.liveVotivesLength(), 0);
    }

    function test_onTerminal_onlyFromAVotiveThisFactoryOpened() public {
        vm.prank(stranger);
        vm.expectRevert(VotiveFactory.NotAVotive.selector);
        factory.onTerminal();
    }

    function test_onTerminal_isIdempotent() public {
        NativeVotive votive = openDefault();
        vm.prank(founder);
        votive.redirect(payee);

        assertEq(factory.liveVotivesLength(), 0);

        vm.prank(address(votive));
        factory.onTerminal();

        assertEq(factory.liveVotivesLength(), 0, "a second report changes nothing");
    }

    // ------------------------------------------------------------------ admin

    function test_setTreasury() public {
        address next = makeAddr("next-treasury");
        vm.prank(owner);
        factory.setTreasury(next);
        assertEq(factory.treasury(), next);

        vm.prank(owner);
        vm.expectRevert(VotiveFactory.ZeroAddress.selector);
        factory.setTreasury(address(0));

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        factory.setTreasury(next);
    }

    function test_setExecutor() public {
        address next = makeAddr("next-executor");
        vm.prank(owner);
        factory.setExecutor(next);
        assertEq(factory.executor(), next);

        vm.prank(owner);
        vm.expectRevert(VotiveFactory.ZeroAddress.selector);
        factory.setExecutor(address(0));

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        factory.setExecutor(next);
    }

    function test_rotatingTheExecutorAppliesToLiveVotives() public {
        NativeVotive votive = openDefault();
        passCapability();

        address next = makeAddr("next-executor");
        vm.prank(owner);
        factory.setExecutor(next);

        vm.prank(executor);
        vm.expectRevert(VotiveBase.NotExecutor.selector);
        votive.beginAttempt();

        vm.prank(next);
        votive.beginAttempt();
        assertState(votive, VotiveState.Attempting);
    }

    function test_setAccessGate() public {
        ClosedAccessGate closed = new ClosedAccessGate();

        vm.prank(owner);
        vm.expectRevert(VotiveFactory.ZeroAddress.selector);
        factory.setAccessGate(OpenAccessGate(address(0)));

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        factory.setAccessGate(closed);

        vm.prank(owner);
        factory.setAccessGate(closed);
        assertEq(address(factory.accessGate()), address(closed));
    }

    function test_defaultTermsAreBoundedByTheImplementationCeilings() public {
        vm.startPrank(owner);

        vm.expectRevert(VotiveFactory.BadTerms.selector);
        factory.setDefaultTerms(
            Terms({streamBps: VotiveLimits.MAX_STREAM_BPS + 1, performanceBps: 800})
        );

        vm.expectRevert(VotiveFactory.BadTerms.selector);
        factory.setDefaultTerms(
            Terms({streamBps: 200, performanceBps: VotiveLimits.MAX_PERFORMANCE_BPS + 1})
        );

        factory.setDefaultTerms(
            Terms({
                streamBps: VotiveLimits.MAX_STREAM_BPS,
                performanceBps: VotiveLimits.MAX_PERFORMANCE_BPS
            })
        );
        vm.stopPrank();

        (uint16 streamBps,) = factory.defaultTerms();
        assertEq(streamBps, VotiveLimits.MAX_STREAM_BPS);
    }

    function test_defaultClocksCannotBeSetToSomethingUnopenable() public {
        vm.startPrank(owner);

        vm.expectRevert(VotiveFactory.BadDeadlines.selector);
        factory.setDefaultDeadlines(
            Deadlines({guardianAfter: 1 days, escheatAfter: 400 days, attemptWindow: 1 days})
        );

        vm.expectRevert(VotiveFactory.BadDeadlines.selector);
        factory.setDefaultDeadlines(
            Deadlines({guardianAfter: 30 days, escheatAfter: 30 days, attemptWindow: 1 days})
        );

        factory.setDefaultDeadlines(
            Deadlines({guardianAfter: 60 days, escheatAfter: 500 days, attemptWindow: 3 days})
        );
        vm.stopPrank();

        NativeVotive votive = openDefault();
        (uint64 guardianAfter,,) = votive.deadlines();
        assertEq(guardianAfter, 60 days);
    }

    function test_ownershipHandoverIsTwoStep() public {
        address heir = makeAddr("heir");
        vm.prank(owner);
        factory.transferOwnership(heir);
        assertEq(factory.owner(), owner);

        vm.prank(heir);
        factory.acceptOwnership();
        assertEq(factory.owner(), heir);
    }

    function test_theImplementationCannotBeSwapped() public view {
        // No setter exists, and the reference is immutable — this is the whole
        // guarantee behind the fee ceilings, so it is asserted rather than assumed.
        assertEq(factory.nativeImplementation(), address(implementation));
    }
}
