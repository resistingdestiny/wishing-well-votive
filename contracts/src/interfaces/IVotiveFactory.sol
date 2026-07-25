// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The slice of the factory a votive depends on — deliberately three
///         functions, so the coupling between the factory and the contracts
///         holding people's money stays something you can hold in your head.
interface IVotiveFactory {
    /// @dev Where protocol fees go. Read live rather than frozen so the platform
    ///      can rotate a compromised or superseded address without touching a
    ///      single votive. The *amounts* are frozen; only the destination moves.
    function treasury() external view returns (address);

    /// @dev The runtime allowed to attempt and fulfil votives.
    function executor() external view returns (address);

    /// @dev Reported by a votive as it goes terminal, so the factory can drop it
    ///      from the live set.
    function onTerminal() external;
}
