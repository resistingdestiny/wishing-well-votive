// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AttestationRegistry} from "../../src/AttestationRegistry.sol";
import {NativeVotive} from "../../src/NativeVotive.sol";
import {TokenVotive} from "../../src/TokenVotive.sol";
import {VotiveFactory} from "../../src/VotiveFactory.sol";
import {VotiveState} from "../../src/VotiveTypes.sol";
import {OpenAccessGate} from "../../src/gates/OpenAccessGate.sol";
import {VotiveHandler} from "./VotiveHandler.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The three invariants the protocol exists to hold, asserted against
///         arbitrary sequences of everything a participant can do.
///
///         These are not extra tests. They are the properties the unit tests are
///         trying to be evidence for, stated once and then checked against
///         histories nobody wrote by hand.
contract VotiveInvariantsTest is Test {
    AttestationRegistry internal registry;
    OpenAccessGate internal gate;
    NativeVotive internal nativeImplementation;
    TokenVotive internal tokenImplementation;
    VotiveFactory internal factory;
    VotiveHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal attestor = makeAddr("attestor");
    address internal executor = makeAddr("executor");
    address internal treasury = makeAddr("treasury");

    uint256 internal constant BPS = 10_000;
    uint256 internal constant ACTOR_FUNDS = 500 ether;

    /// @notice Every wei in the system at the start. Nothing is minted or burned
    ///         after this, so the total can only be redistributed.
    uint256 internal initialTotal;

    function setUp() public {
        vm.warp(1_800_000_000);

        registry = new AttestationRegistry(owner, attestor);
        gate = new OpenAccessGate();
        nativeImplementation = new NativeVotive();
        tokenImplementation = new TokenVotive();
        factory = new VotiveFactory(
            owner,
            registry,
            address(nativeImplementation),
            address(tokenImplementation),
            treasury,
            executor,
            gate
        );

        vm.prank(owner);
        registry.setFactory(address(factory));

        address[] memory actors = new address[](5);
        for (uint256 i = 0; i < actors.length; i++) {
            actors[i] = makeAddr(string(abi.encodePacked("actor", i)));
            vm.deal(actors[i], ACTOR_FUNDS);
        }

        handler = new VotiveHandler(factory, registry, executor, attestor, treasury, actors);

        uint256 count = handler.accountedCount();
        for (uint256 i = 0; i < count; i++) {
            initialTotal += handler.accounted(i).balance;
        }

        targetContract(address(handler));
    }

    // ------------------------------------------------------------ segregation

    /// @notice A votive can only ever hold value that was sent to *it*. If this
    ///         ever fails, funds have moved between votives, which is the one
    ///         thing the whole design is arranged to prevent.
    function invariant_aVotiveHoldsOnlyItsOwnMoney() public view {
        uint256 count = handler.votiveCount();
        for (uint256 i = 0; i < count; i++) {
            NativeVotive votive = handler.votives(i);
            assertLe(
                address(votive).balance,
                handler.sentIn(address(votive)),
                "a votive holds more than was ever sent to it"
            );
        }
    }

    /// @notice Whatever a votive still owes — deferred payouts, an open share pot
    ///         — it can actually pay.
    function invariant_everyObligationIsCovered() public view {
        uint256 count = handler.votiveCount();
        for (uint256 i = 0; i < count; i++) {
            NativeVotive votive = handler.votives(i);
            assertGe(
                address(votive).balance,
                votive.deferredTotal() + votive.unclaimedShares(),
                "a votive owes more than it holds"
            );
        }
    }

    /// @notice Not a wei appears or disappears; it only ever moves.
    function invariant_valueIsConserved() public view {
        uint256 total;
        uint256 count = handler.accountedCount();
        for (uint256 i = 0; i < count; i++) {
            total += handler.accounted(i).balance;
        }
        assertEq(total, initialTotal, "value was created or destroyed");
    }

    /// @notice The infrastructure never custodies anything.
    function invariant_theProtocolItselfHoldsNothing() public view {
        assertEq(address(factory).balance, 0, "the factory is not a vault");
        assertEq(address(registry).balance, 0);
        assertEq(address(gate).balance, 0);
        assertEq(address(nativeImplementation).balance, 0, "the implementation is inert");
        assertEq(address(tokenImplementation).balance, 0);
    }

    // ------------------------------------------------------- fee transparency

    /// @notice The streaming fee can consume the principal but never exceed it —
    ///         a votive left alone is emptied, not overdrawn.
    function invariant_streamNeverExceedsPrincipal() public view {
        uint256 count = handler.votiveCount();
        for (uint256 i = 0; i < count; i++) {
            NativeVotive votive = handler.votives(i);
            assertLe(votive.streamAccrued(), votive.principal(), "streamed past the principal");
            assertLe(votive.streamPaid(), votive.streamAccrued(), "paid fee never accrued");
        }
    }

    /// @notice The performance fee is charged on offerings above principal and on
    ///         nothing else, at the rate the votive was opened at.
    function invariant_performanceFeeStaysWithinTheSchedule() public view {
        uint256 count = handler.votiveCount();
        for (uint256 i = 0; i < count; i++) {
            NativeVotive votive = handler.votives(i);
            uint256 charged = votive.performanceCharged();
            if (charged == 0) continue;

            uint256 inflow = handler.sentIn(address(votive));
            uint256 committed = votive.principal();
            uint256 offerings = inflow > committed ? inflow - committed : 0;

            (, uint16 performanceBps) = votive.terms();
            assertLe(
                charged * BPS,
                offerings * performanceBps,
                "performance fee exceeded the quoted rate on offerings"
            );
        }
    }

    /// @notice Nobody is quoted terms above the ceilings compiled into the
    ///         implementation, whatever the factory owner does in between.
    function invariant_quotedTermsRespectTheCeilings() public view {
        uint256 count = handler.votiveCount();
        for (uint256 i = 0; i < count; i++) {
            (uint16 streamBps, uint16 performanceBps) = handler.votives(i).terms();
            assertLe(streamBps, 500);
            assertLe(performanceBps, 2_000);
        }
    }

    // --------------------------------------------------------- the state machine

    /// @notice A terminal votive is out of the live set, and a live one is in it.
    ///         The factory's view of the world and the votives' own agree.
    function invariant_theLiveSetTellsTheTruth() public view {
        uint256 count = handler.votiveCount();
        for (uint256 i = 0; i < count; i++) {
            NativeVotive votive = handler.votives(i);
            VotiveState state = votive.state();
            bool live = state == VotiveState.Waiting || state == VotiveState.Attempting;
            assertEq(factory.isLive(address(votive)), live, "the live set disagrees with a votive");
        }
    }

    /// @notice A votive is never in the pre-initialised state once it exists, and
    ///         an attempt in flight always has a start time.
    function invariant_stateIsInternallyConsistent() public view {
        uint256 count = handler.votiveCount();
        for (uint256 i = 0; i < count; i++) {
            NativeVotive votive = handler.votives(i);
            VotiveState state = votive.state();
            assertTrue(state != VotiveState.Nascent, "an opened votive is never nascent");
            if (state == VotiveState.Attempting) {
                assertGt(votive.attemptStartedAt(), 0, "attempting with no attempt");
            }
            assertGt(votive.principal(), 0, "an opened votive always has principal");
        }
    }

    /// @notice A share pot is only ever a fraction of the pot that was posted.
    function invariant_sharePotIsNeverOverdrawn() public view {
        uint256 count = handler.votiveCount();
        for (uint256 i = 0; i < count; i++) {
            NativeVotive votive = handler.votives(i);
            assertLe(votive.shareClaimed(), votive.shareTotal(), "share pot overdrawn");
        }
    }
}
