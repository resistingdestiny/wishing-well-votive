// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAgentStanding} from "../interfaces/IAgentStanding.sol";
import {IHumanBacking} from "../interfaces/IHumanBacking.sol";
import {StandingLedger} from "./StandingLedger.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title AgentStandingAdapter
/// @notice Translates between a payment rail, which knows about wallets, and the
///         standing ledger, which knows about humans.
///
/// @dev Two jobs, both small. It resolves an agent's wallet to the human behind it,
///      and it is the only party the ledger accepts outcome records from on the
///      rail's behalf — so a rail never needs the ledger's recorder role directly,
///      and swapping a rail does not mean handing a new contract write access to
///      everybody's reputation.
///
///      **An unbacked agent is refused, not ignored.** `mayWork` returns false for a
///      wallet with no human behind it, which is the point: work that pays from the
///      commons should be done by somebody who can be held to it. But outcome
///      recording tolerates an unbacked wallet silently instead of reverting, and
///      that asymmetry is deliberate — a backing revoked between claiming a task and
///      delivering it must not leave the payment itself unable to settle. Refusing
///      new work is a policy; blocking a payment already earned is a bug.
contract AgentStandingAdapter is IAgentStanding, Ownable2Step {
    IHumanBacking public immutable backing;
    StandingLedger public immutable ledger;

    /// @notice Rails permitted to record outcomes through this adapter.
    mapping(address rail => bool) public isRail;

    event RailSet(address indexed rail, bool allowed);

    error ZeroAddress();
    error NotARail();

    constructor(address initialOwner, IHumanBacking backing_, StandingLedger ledger_)
        Ownable(initialOwner)
    {
        if (address(backing_) == address(0) || address(ledger_) == address(0)) {
            revert ZeroAddress();
        }
        backing = backing_;
        ledger = ledger_;
    }

    function setRail(address rail, bool allowed) external onlyOwner {
        isRail[rail] = allowed;
        emit RailSet(rail, allowed);
    }

    modifier onlyRail() {
        if (!isRail[msg.sender]) revert NotARail();
        _;
    }

    /// @inheritdoc IAgentStanding
    function mayWork(address agent) external view returns (bool) {
        bytes32 humanId = backing.humanOf(agent);
        if (humanId == bytes32(0)) return false;
        return !ledger.isBarred(humanId);
    }

    /// @inheritdoc IAgentStanding
    function noteFulfilment(address agent) external onlyRail {
        bytes32 humanId = backing.humanOf(agent);
        if (humanId == bytes32(0)) return; // see the note on asymmetry
        ledger.recordFulfilment(humanId);
    }

    /// @inheritdoc IAgentStanding
    function noteFailure(address agent) external onlyRail {
        bytes32 humanId = backing.humanOf(agent);
        if (humanId == bytes32(0)) return;
        ledger.recordFailure(humanId);
    }

    /// @notice The human behind `agent`, for callers that want to show it.
    function humanOf(address agent) external view returns (bytes32) {
        return backing.humanOf(agent);
    }
}
