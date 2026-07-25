// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Where a votive is in its life.
///
/// `Nascent` is the zero value and means *not yet initialised* — a freshly
/// deployed clone, or the implementation contract itself, which never leaves it.
/// `Waiting` and `Attempting` are the two live states; everything after them is
/// terminal. There is no path back from a terminal state.
///
/// New values are only ever appended, never inserted, so the numeric ordinal of
/// every existing state stays stable for indexers and clients reading it raw.
enum VotiveState {
    Nascent,
    Waiting,
    Attempting,
    Fulfilled,
    Redirected,
    Escheated
}

/// @notice What kind of wish this is, which decides where value goes when the
///         release condition is finally attested.
///
/// - `ReleaseOnCondition` — pay the named beneficiary (the founder, if none was
///   named). The plain case: *hold this until X is true, then give it to Y*.
/// - `RealWorldTask` — someone has to go and do something that costs money.
///   The executor is reimbursed up to the intent's `expenseBudget` out of the
///   settled value, and whatever is left over goes where a `ReleaseOnCondition`
///   would have sent it.
/// - `ShareWithActive` — the wish is for everyone still waiting. On fulfilment
///   the settled value is not paid to one address at all; it is set aside for
///   the votives that were still open at a snapshot block, in proportion to what
///   each of them had parked, and each one pulls its own slice.
enum VotiveKind {
    ReleaseOnCondition,
    RealWorldTask,
    ShareWithActive
}

/// @notice The machine-readable form of a wish, fixed at creation.
///
/// A wish arrives as prose. The prose is parsed once, into this, and from then
/// on the protocol executes the struct and never the prose — `storyHash` binds
/// the two together so anyone can check that the words on a screen are the words
/// this votive was actually built from. The prose itself stays off chain.
struct Intent {
    /// @dev What kind of wish this is; decides the settlement route.
    VotiveKind kind;
    /// @dev Who made the vow. Holds redirect authority and the liveness clock.
    address founder;
    /// @dev May redirect the votive once the founder has been silent for
    ///      `guardianAfter`. `address(0)` for none.
    address guardian;
    /// @dev Where value goes on fulfilment. `address(0)` means the founder.
    address beneficiary;
    /// @dev Where value goes on escheat — a charity, an heir, a successor.
    ///      `address(0)` falls back to the protocol treasury.
    address fallbackTo;
    /// @dev The capability check that must be passed by some model before anyone
    ///      may attempt this wish.
    bytes32 capabilityId;
    /// @dev The release condition: what has to be attested true before this
    ///      votive can be fulfilled.
    bytes32 conditionHash;
    /// @dev keccak256 of the prose this intent was parsed from.
    bytes32 storyHash;
    /// @dev `RealWorldTask` only: the ceiling on what the executor may be
    ///      reimbursed at fulfilment. Must be zero for every other kind.
    uint256 expenseBudget;
    /// @dev An irrevocable votive can never be redirected, by anyone, ever. It
    ///      can only be fulfilled or — after very long silence — escheat to the
    ///      destination the founder named. Forbids a guardian, whose only power
    ///      would be a redirect it can never perform.
    bool irrevocable;
}

/// @notice The clocks. All are durations in seconds, not timestamps, and all are
///         measured from the founder's last sign of life (or, for
///         `attemptWindow`, from the start of the current attempt).
///
/// Any field left zero at creation is filled from the factory's defaults. Floors
/// are enforced by the votive itself, so a hand-crafted intent cannot make its
/// own funds redirectable or escheatable a block after it opens.
struct Deadlines {
    /// @dev Founder silence after which the guardian may redirect.
    uint64 guardianAfter;
    /// @dev Founder silence after which anyone may escheat. Must exceed
    ///      `guardianAfter` — the gentler remedy has to come first.
    uint64 escheatAfter;
    /// @dev How long an attempt may sit before anyone may reset it, so a stalled
    ///      executor cannot hold a votive hostage in `Attempting`.
    uint64 attemptWindow;
}

/// @notice The fee schedule, quoted by the factory and frozen into the votive at
///         creation. Two rates and nothing else — there is no third fee, no
///         withdrawal penalty, and no path that moves value out of a votive
///         outside this schedule.
struct Terms {
    /// @dev Per annum, accrued continuously against parked principal.
    uint16 streamBps;
    /// @dev Charged once, at settlement, on offerings above principal.
    uint16 performanceBps;
}
