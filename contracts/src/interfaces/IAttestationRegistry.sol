// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The slice of the attestation registry a votive reads: one question
///         before an attempt may start, one before it may settle.
interface IAttestationRegistry {
    /// @dev True while at least one model stands as having passed the check.
    function isCapabilityOpen(bytes32 capabilityId) external view returns (bool);

    /// @dev True if this specific votive's release condition is attested met.
    function isConditionMet(address votive, bytes32 conditionHash) external view returns (bool);

    /// @dev Bind a votive to the capability it requires. Factory-only, once.
    function registerVotive(address votive, bytes32 capabilityId) external;
}
