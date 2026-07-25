// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IStanding
/// @notice What a human's track record is worth, and whether they are allowed to
///         act at all.
///
/// @dev Two questions, deliberately separate. `multiplierBpsOf` is economic — it
///      scales how much of the commons an operator may draw. `isBarred` is not
///      economic at all; it is a gate, and no amount of good standing reopens it.
///      Keeping them apart is what stops "has fulfilled many wishes" from ever
///      buying its way past "has been barred for conduct".
interface IStanding {
    /// @return Basis points applied to the base allowance for `humanId`, where
    ///         10_000 is parity. Zero for a barred human.
    function multiplierBpsOf(bytes32 humanId) external view returns (uint256);

    /// @return Whether `humanId` is currently barred from drawing or settling.
    function isBarred(bytes32 humanId) external view returns (bool);
}
