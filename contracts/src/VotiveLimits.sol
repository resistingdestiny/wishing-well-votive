// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title VotiveLimits
/// @notice The outer bounds of what a votive may ever be opened with, in one
///         place so the factory that quotes them and the votive that enforces
///         them can never drift apart.
///
///         These are not defaults — the factory holds those, and they are much
///         gentler. These are the walls. A factory owner who has lost control of
///         their key still cannot price a new votive above the fee ceilings, and
///         still cannot open one whose guardian or escheat clock fires early
///         enough to be a taking.
library VotiveLimits {
    /// @notice Most streaming fee a votive may ever be opened at: 5 % per annum.
    uint16 internal constant MAX_STREAM_BPS = 500;

    /// @notice Most performance fee a votive may ever be opened at: 20 % of
    ///         offerings above principal.
    uint16 internal constant MAX_PERFORMANCE_BPS = 2_000;

    /// @notice A guardian may never be given power over a votive whose founder
    ///         has been quiet for less than a week.
    uint64 internal constant MIN_GUARDIAN_WINDOW = 7 days;

    /// @notice Nothing may escheat on less than a quarter of silence.
    uint64 internal constant MIN_ESCHEAT_WINDOW = 90 days;

    /// @notice An attempt must be allowed to run for at least an hour before a
    ///         bystander can reset it out from under the executor.
    uint64 internal constant MIN_ATTEMPT_WINDOW = 1 hours;
}
