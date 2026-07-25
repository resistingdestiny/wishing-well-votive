// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IAccessGate
/// @notice Consulted once, at creation, to decide whether an address may open a
///         votive. Deliberately the narrowest possible surface: one view, one
///         boolean, no state of its own that the protocol depends on.
/// @dev Kept as an interface so a jurisdiction-specific implementation can be
///      swapped in later without touching a line of protocol code. Nothing in
///      the protocol re-consults the gate after creation — a votive that exists
///      is never frozen by a gate change, which keeps the gate an admission
///      policy rather than a censorship lever over funds already committed.
interface IAccessGate {
    /// @param account The address attempting to open a votive.
    /// @return permitted True if the address may proceed.
    function isPermitted(address account) external view returns (bool permitted);
}
