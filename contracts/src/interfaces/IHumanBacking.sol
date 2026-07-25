// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IHumanBacking
/// @notice Resolves an agent's wallet to the anonymous, one-way identifier of the
///         unique human operating it.
///
///         The identifier is deliberately not an address, a name, or anything a
///         person could be recovered from. It is a commitment produced once per
///         human by an off-chain proof of humanity, with the single property this
///         protocol actually needs: **one human yields one identifier, however
///         many agent wallets they register.** Everything downstream — how much
///         of the commons an agent may draw, whether it may settle a payment at
///         all — keys off that identifier rather than off the wallet, which is
///         what stops a new keypair from being a fresh start.
///
/// @dev Any contract wanting to gate on "a real, unique human stands behind this"
///      depends only on this interface. The concrete registry stays swappable, in
///      the same way the attestation oracle does.
interface IHumanBacking {
    /// @return The anonymous human identifier bound to `wallet`, or `bytes32(0)`
    ///         when the wallet carries no live backing.
    function humanOf(address wallet) external view returns (bytes32);

    /// @return The assurance tier recorded for `wallet` — how strongly the
    ///         humanity claim is evidenced. `0` when unbacked.
    function assuranceOf(address wallet) external view returns (uint8);

    /// @return Whether `wallet` currently resolves to a human at all.
    function isHumanBacked(address wallet) external view returns (bool);

    /// @return How many wallets currently resolve to `humanId`. This is the Sybil
    ///         surface of one operator, and the reason ceilings are aggregated per
    ///         human instead of per wallet.
    function walletCount(bytes32 humanId) external view returns (uint256);
}
