// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The two questions the protocol's attestation registry answers, as the
///         VM needs to ask them.
///
///         They are deliberately separate instructions rather than one combined
///         gate, because they are separate facts about the world: *can this be
///         done yet* is a statement about the frontier and is shared by every
///         votive naming the same capability; *has this been done* is a statement
///         about one votive. A position that conflated them could open early.
interface IVotiveAttestations {
    /// @dev True once some model has demonstrated the capability.
    function isCapabilityOpen(bytes32 capabilityId) external view returns (bool);

    /// @dev True once this specific votive's release condition is attested met.
    function isConditionMet(address votive, bytes32 conditionHash) external view returns (bool);
}

/// @notice The slice of a votive the VM reads. `state` is the lifecycle enum:
///         0 Nascent, 1 Waiting, 2 Attempting, and anything above that is
///         terminal — the votive has already settled and its position must not
///         be fillable.
interface IVotiveState {
    function state() external view returns (uint8);

    /// @dev What the founder committed. The natural threshold for a performance
    ///      fee: proceeds up to this are the founder's own money coming back.
    function principal() external view returns (uint256);
}
