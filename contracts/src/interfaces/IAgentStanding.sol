// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IAgentStanding
/// @notice The narrow surface a payment rail needs in order to care who it is
///         paying: may this agent take work, and here is how the work turned out.
///
/// @dev Deliberately expressed in terms of an agent's *wallet*. The rail should not
///      have to know that standing is keyed to a human, that one human may hold
///      several wallets, or how a bar is represented — it asks about the address in
///      front of it and an adapter resolves the rest. Keeping the rail ignorant of
///      the identity model is what lets the identity model change without a
///      redeployment of anything holding escrow.
interface IAgentStanding {
    /// @return Whether this agent may take on new work.
    function mayWork(address agent) external view returns (bool);

    /// @notice Record that this agent delivered and was paid.
    function noteFulfilment(address agent) external;

    /// @notice Record that this agent took work on and did not deliver.
    function noteFailure(address agent) external;
}
