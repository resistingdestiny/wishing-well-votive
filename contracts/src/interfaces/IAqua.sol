// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IAqua
/// @notice The slice of 1inch Aqua a votive needs in order to be a position.
///
/// @dev Declared here rather than imported because Aqua is built against a newer
///      Solidity than this project pins, and a votive needs exactly two functions
///      from it. Importing the package would drag a compiler-version bump through
///      every contract that custodies money, to gain nothing.
///
///      **Aqua custodies nothing.** This is the fact the whole design rests on and
///      it is easy to get wrong: `ship` writes an accounting entry and moves no
///      tokens, and a fill later does `transferFrom(maker, taker, …)` against the
///      maker's allowance. Verified on Base Sepolia — a strategy declaring 146
///      tokens sat alongside an Aqua contract holding zero of them.
///
///      So a votive that ships a strategy is still the custodian of its own
///      principal. It has not moved the money anywhere; it has said what the money
///      is available for, and granted an allowance that only the router can spend
///      and only by running a program the votive chose.
interface IAqua {
    /// @notice Declare `amounts` of `tokens` available to a strategy on `app`.
    /// @param app The SwapVM router that may spend against this strategy.
    /// @param strategy ABI-encoded order; its hash becomes the strategy id.
    /// @return strategyHash The id Aqua keys the balances under.
    function ship(
        address app,
        bytes calldata strategy,
        address[] calldata tokens,
        uint256[] calldata amounts
    ) external returns (bytes32 strategyHash);

    /// @notice What a strategy currently declares for a pair.
    function safeBalances(
        address maker,
        address app,
        bytes32 strategyHash,
        address tokenA,
        address tokenB
    ) external view returns (uint256 balanceA, uint256 balanceB);

    /// @notice Close a strategy, so nothing further can be spent against it.
    function dock(address app, bytes32 strategyHash, address[] calldata tokens) external;
}
