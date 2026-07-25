// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The protocol's human-backing registry, as the VM needs to read it.
///
///         The identifier is one-way and per person: the same human always
///         resolves to the same word however many agent wallets they run. That is
///         what lets a position price a *filler* rather than an address.
interface IVotiveHumanBacking {
    function humanOf(address wallet) external view returns (bytes32);
    function assuranceOf(address wallet) external view returns (uint8);
}

/// @notice The protocol's standing ledger.
interface IVotiveStanding {
    /// @dev True while the human is barred or suspended for conduct.
    function isBarred(bytes32 humanId) external view returns (bool);

    /// @dev Basis points against parity, where 10_000 is neutral and 0 is barred.
    function multiplierBpsOf(bytes32 humanId) external view returns (uint256);
}
