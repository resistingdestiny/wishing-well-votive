// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The protocol's attestation registry, reduced to the two reads the VM
///         makes, so the opcode mechanics can be exercised in isolation from the
///         protocol's own build.
contract AttestationsMock {
    mapping(bytes32 => bool) public capabilityOpen;
    mapping(address => mapping(bytes32 => bool)) public conditionMet;

    function setCapabilityOpen(bytes32 capabilityId, bool value) external {
        capabilityOpen[capabilityId] = value;
    }

    function setConditionMet(address votive, bytes32 conditionHash, bool value) external {
        conditionMet[votive][conditionHash] = value;
    }

    function isCapabilityOpen(bytes32 capabilityId) external view returns (bool) {
        return capabilityOpen[capabilityId];
    }

    function isConditionMet(address votive, bytes32 conditionHash) external view returns (bool) {
        return conditionMet[votive][conditionHash];
    }
}

/// @notice A votive, reduced to what the lifecycle gate reads. States mirror the
///         protocol's enum: 0 Nascent, 1 Waiting, 2 Attempting, 3+ terminal.
contract VotiveMock {
    uint8 public state = 1;
    uint256 public principal;

    constructor(uint256 principal_) {
        principal = principal_;
    }

    function setState(uint8 value) external {
        state = value;
    }
}
