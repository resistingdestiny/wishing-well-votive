// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AttestationRegistry} from "../../src/AttestationRegistry.sol";
import {NativeVotive} from "../../src/NativeVotive.sol";
import {VotiveFactory} from "../../src/VotiveFactory.sol";
import {Deadlines, Intent, Terms, VotiveKind, VotiveState} from "../../src/VotiveTypes.sol";
import {Merkle} from "../helpers/Merkle.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

/// @notice Drives a small protocol deployment through arbitrary sequences of
///         everything a real participant can do, and keeps the ghost accounting
///         the invariants are checked against.
///
/// @dev Every action is written to be *attemptable* in any state — the invariant
///      profile tolerates reverts, so the handler does not need to know which
///      moves are currently legal. That is deliberate: the point is to find out
///      what happens when somebody tries something at the wrong moment, not to
///      politely avoid doing so.
contract VotiveHandler is CommonBase, StdCheats, StdUtils {
    VotiveFactory public immutable factory;
    AttestationRegistry public immutable registry;
    address public immutable executor;
    address public immutable attestor;
    address public immutable treasury;

    bytes32 public constant CAPABILITY = keccak256("capability");
    bytes32 public constant CONDITION = keccak256("condition");
    bytes32 public constant MODEL = keccak256("model");

    NativeVotive[] public votives;
    address[] public actors;

    /// @notice Everything ever sent into each votive, by any route.
    mapping(address votive => uint256) public sentIn;
    /// @notice Every address whose balance is part of the closed system.
    address[] public accounted;

    uint256 public callCount;

    constructor(
        VotiveFactory factory_,
        AttestationRegistry registry_,
        address executor_,
        address attestor_,
        address treasury_,
        address[] memory actors_
    ) {
        factory = factory_;
        registry = registry_;
        executor = executor_;
        attestor = attestor_;
        treasury = treasury_;
        actors = actors_;

        for (uint256 i = 0; i < actors_.length; i++) {
            accounted.push(actors_[i]);
        }
        accounted.push(treasury_);
        accounted.push(executor_);
        accounted.push(address(this));
    }

    // --------------------------------------------------------------- helpers

    function votiveCount() external view returns (uint256) {
        return votives.length;
    }

    function accountedCount() external view returns (uint256) {
        return accounted.length;
    }

    function actorAt(uint256 seed) public view returns (address) {
        return actors[seed % actors.length];
    }

    function _votive(uint256 seed) private view returns (NativeVotive) {
        return votives[seed % votives.length];
    }

    function _track() private {
        callCount++;
    }

    // ---------------------------------------------------------------- actions

    /// @notice Somebody opens a new wish.
    function openVotive(uint256 founderSeed, uint256 amount, uint256 kindSeed) external {
        _track();
        if (votives.length >= 6) return;

        address founder = actorAt(founderSeed);
        amount = bound(amount, 1 wei, 50 ether);
        if (founder.balance < amount) return;

        VotiveKind kind = VotiveKind(kindSeed % 3);

        Intent memory intent_ = Intent({
            kind: kind,
            founder: founder,
            guardian: actorAt(founderSeed + 1),
            beneficiary: address(0),
            fallbackTo: address(0),
            capabilityId: CAPABILITY,
            conditionHash: CONDITION,
            storyHash: keccak256(abi.encode(votives.length)),
            expenseBudget: kind == VotiveKind.RealWorldTask ? amount / 4 : 0,
            irrevocable: false
        });

        vm.prank(founder);
        address opened = factory.open{value: amount}(
            intent_,
            Deadlines({guardianAfter: 0, escheatAfter: 0, attemptWindow: 0}),
            Terms({streamBps: type(uint16).max, performanceBps: type(uint16).max})
        );

        votives.push(NativeVotive(payable(opened)));
        sentIn[opened] += amount;
        accounted.push(opened);
    }

    /// @notice Somebody backs a wish that is not theirs.
    function offer(uint256 votiveSeed, uint256 actorSeed, uint256 amount) external {
        _track();
        if (votives.length == 0) return;

        NativeVotive votive = _votive(votiveSeed);
        address actor = actorAt(actorSeed);
        amount = bound(amount, 1 wei, 10 ether);
        if (actor.balance < amount) return;

        vm.prank(actor);
        (bool ok,) = address(votive).call{value: amount}("");
        if (ok) sentIn[address(votive)] += amount;
    }

    function topUp(uint256 votiveSeed, uint256 amount) external {
        _track();
        if (votives.length == 0) return;

        NativeVotive votive = _votive(votiveSeed);
        address founder = votive.intent().founder;
        amount = bound(amount, 1 wei, 10 ether);
        if (founder.balance < amount) return;

        vm.prank(founder);
        try votive.topUp{value: amount}() {
            sentIn[address(votive)] += amount;
        } catch {}
    }

    function heartbeat(uint256 votiveSeed) external {
        _track();
        if (votives.length == 0) return;
        NativeVotive votive = _votive(votiveSeed);
        vm.prank(votive.intent().founder);
        try votive.heartbeat() {} catch {}
    }

    function accrue(uint256 votiveSeed) external {
        _track();
        if (votives.length == 0) return;
        _votive(votiveSeed).accrue();
    }

    function settleStream(uint256 votiveSeed) external {
        _track();
        if (votives.length == 0) return;
        try _votive(votiveSeed).settleStream() {} catch {}
    }

    function passCapability() external {
        _track();
        vm.prank(attestor);
        registry.attestCapability(CAPABILITY, MODEL, true, bytes32(0));
    }

    function retractCapability() external {
        _track();
        vm.prank(attestor);
        registry.attestCapability(CAPABILITY, MODEL, false, bytes32(0));
    }

    function attestCondition(uint256 votiveSeed, bool met) external {
        _track();
        if (votives.length == 0) return;
        vm.prank(attestor);
        registry.attestCondition(address(_votive(votiveSeed)), CONDITION, met, bytes32(0));
    }

    function beginAttempt(uint256 votiveSeed) external {
        _track();
        if (votives.length == 0) return;
        vm.prank(executor);
        try _votive(votiveSeed).beginAttempt() {} catch {}
    }

    function endAttempt(uint256 votiveSeed, uint256 actorSeed) external {
        _track();
        if (votives.length == 0) return;
        vm.prank(actorSeed % 2 == 0 ? executor : actorAt(actorSeed));
        try _votive(votiveSeed).endAttempt() {} catch {}
    }

    function fulfil(uint256 votiveSeed) external {
        _track();
        if (votives.length == 0) return;
        vm.prank(executor);
        try _votive(votiveSeed).fulfil() {} catch {}
    }

    /// @notice Settle a shared wish to a single-leaf allocation, so the pot
    ///         machinery is exercised without the handler having to build trees.
    function fulfilBySharing(uint256 votiveSeed, uint256 actorSeed, uint256 weight) external {
        _track();
        if (votives.length == 0) return;

        NativeVotive votive = _votive(votiveSeed);
        address recipient = actorAt(actorSeed);
        weight = bound(weight, 1, 1e24);

        bytes32 root = Merkle.leafOf(0, recipient, weight);
        vm.prank(executor);
        try votive.fulfilBySharing(root, weight, uint64(block.number)) {} catch {}
    }

    function claimShare(uint256 votiveSeed, uint256 actorSeed, uint256 weight) external {
        _track();
        if (votives.length == 0) return;

        NativeVotive votive = _votive(votiveSeed);
        address recipient = actorAt(actorSeed);
        weight = bound(weight, 1, 1e24);

        try votive.claimShare(0, recipient, weight, new bytes32[](0)) {} catch {}
    }

    function sweepUnclaimedShares(uint256 votiveSeed) external {
        _track();
        if (votives.length == 0) return;
        try _votive(votiveSeed).sweepUnclaimedShares() {} catch {}
    }

    function redirect(uint256 votiveSeed, uint256 callerSeed, uint256 targetSeed) external {
        _track();
        if (votives.length == 0) return;

        NativeVotive votive = _votive(votiveSeed);
        address caller = callerSeed % 3 == 0 ? votive.intent().founder : actorAt(callerSeed);
        vm.prank(caller);
        try votive.redirect(actorAt(targetSeed)) {} catch {}
    }

    function escheat(uint256 votiveSeed) external {
        _track();
        if (votives.length == 0) return;
        try _votive(votiveSeed).escheat() {} catch {}
    }

    function claimDeferred(uint256 votiveSeed, uint256 actorSeed) external {
        _track();
        if (votives.length == 0) return;
        vm.prank(actorAt(actorSeed));
        try _votive(votiveSeed).claimDeferred() {} catch {}
    }

    function sweepStray(uint256 votiveSeed) external {
        _track();
        if (votives.length == 0) return;
        try _votive(votiveSeed).sweepStray() {} catch {}
    }

    function rotateTreasury(uint256 seed) external {
        _track();
        // Rotating to another accounted address keeps the closed system closed
        // while still exercising the fact that the destination is read live.
        vm.prank(factory.owner());
        try factory.setTreasury(actorAt(seed)) {} catch {}
    }

    /// @notice Let time pass. The clocks are what most of the protocol turns on,
    ///         so an invariant run that never advances is barely a run at all.
    function warp(uint256 seconds_) external {
        _track();
        vm.warp(block.timestamp + bound(seconds_, 1 hours, 400 days));
    }
}
