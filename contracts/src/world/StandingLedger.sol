// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IStanding} from "../interfaces/IStanding.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title StandingLedger
/// @notice A human's track record, and the bar that no track record overrides.
///
///         Standing is kept per *human*, never per wallet. That is the entire
///         design: an operator who is barred cannot generate a new keypair and
///         start clean, and an operator who has built up trust does not lose it by
///         rotating an agent. Both directions follow from the same choice.
///
/// @dev The ledger holds two independent things and refuses to let them interact.
///
///      **The multiplier** is economic. Fulfilments raise it, failures lower it,
///      and it is clamped into a band, so a long-running agent earns a larger draw
///      against the commons without ever earning an unbounded one.
///
///      **The bar** is not economic. A barred human draws nothing and settles
///      nothing, and no quantity of fulfilments shortens it. Wiring reputation into
///      the bar — "enough good behaviour offsets a report" — would mean an operator
///      could pre-purchase impunity by farming easy wishes, which is precisely the
///      failure this is meant to prevent.
///
///      **A category sets a floor on severity.** A reviewer files a category and a
///      severity, but the categories that describe harm to people carry a minimum
///      severity the reviewer cannot file below. Without that floor, the honesty of
///      the whole mechanism would rest on a reviewer never mis-grading a wish that
///      asked for somebody to be hurt, and a single under-filing would leave the
///      operator drawing from the commons the next block.
contract StandingLedger is IStanding, Ownable2Step {
    // ------------------------------------------------------------------ types

    /// @notice How badly a report reflects on the operator.
    enum Severity {
        None,
        /// @notice Sloppiness. Costs standing, bars nothing.
        Minor,
        /// @notice Abuse. Costs standing heavily and suspends for a fixed window.
        Serious,
        /// @notice Conduct there is no coming back from. Bars permanently.
        Critical
    }

    /// @notice What the report is about. Recorded so the bar is auditable and so
    ///         the severity floor has something to key off.
    enum Category {
        Unspecified,
        /// @notice Wishing harm on a person: injury, death, violence, coercion.
        ViolenceAgainstPeople,
        /// @notice Sexual exploitation, or abuse of anyone unable to consent.
        Exploitation,
        /// @notice Weapons, or anything whose purpose is mass harm.
        WeaponsOrMassHarm,
        /// @notice Targeting a named private individual: stalking, doxxing.
        TargetedHarassment,
        /// @notice Deceiving a funder about what was done, or who did it.
        Fraud,
        /// @notice Flooding the protocol with junk to capture allowance.
        Spam
    }

    struct Standing {
        uint32 fulfilments;
        uint32 failures;
        /// @notice Accumulated basis points of penalty from conduct reports.
        uint96 penaltyBps;
        uint32 reports;
        /// @notice Barred until this timestamp. `type(uint64).max` is permanent.
        uint64 barredUntil;
        Severity worstSeverity;
    }

    // ------------------------------------------------------------- parameters

    uint256 public constant BASE_BPS = 10_000;
    /// @notice Floor for an operator in poor standing but not barred. Deliberately
    ///         not zero: a bad run should throttle an agent, not silently retire it.
    uint256 public constant MIN_BPS = 2_500;
    /// @notice Ceiling on earned trust. An unbounded multiplier would make the
    ///         commons drainable by whoever farmed the most cheap fulfilments.
    uint256 public constant MAX_BPS = 30_000;

    uint256 public constant FULFILMENT_STEP_BPS = 1_000;
    uint256 public constant FAILURE_STEP_BPS = 1_500;
    /// @notice Credit stops accruing here, so the ceiling is reachable but the
    ///         counter cannot be farmed indefinitely for headroom.
    uint256 public constant MAX_CREDIT_BPS = 20_000;

    /// @dev Typed `uint96` to match the accumulator they feed, so applying a
    ///      penalty never narrows a wider type on the way in.
    uint96 public constant PENALTY_MINOR_BPS = 2_500;
    uint96 public constant PENALTY_SERIOUS_BPS = 10_000;

    /// @notice How long a serious report suspends an operator. Long enough to
    ///         matter, short enough that it is not a permanent bar by the back door.
    uint64 public constant SERIOUS_SUSPENSION = 30 days;
    uint64 internal constant PERMANENT = type(uint64).max;

    // ----------------------------------------------------------------- state

    /// @notice Contracts permitted to record outcomes — the bounty rail, a votive.
    mapping(address recorder => bool) public isRecorder;
    /// @notice Keys permitted to file conduct reports.
    mapping(address reviewer => bool) public isReviewer;

    mapping(bytes32 humanId => Standing) private _standing;

    // ---------------------------------------------------------------- events

    event RecorderSet(address indexed recorder, bool allowed);
    event ReviewerSet(address indexed reviewer, bool allowed);

    event FulfilmentRecorded(bytes32 indexed humanId, uint32 total);
    event FailureRecorded(bytes32 indexed humanId, uint32 total);

    event ConductReported(
        bytes32 indexed humanId,
        Category indexed category,
        Severity severity,
        uint256 penaltyBps,
        bytes32 evidenceHash,
        address reviewer
    );
    event Barred(bytes32 indexed humanId, uint64 until, Severity severity);
    event Pardoned(bytes32 indexed humanId, address by);

    // ---------------------------------------------------------------- errors

    error NotRecorder();
    error NotReviewer();
    error ZeroHumanId();
    error NoSeverity();
    /// @notice The category carries a higher minimum severity than was filed.
    error SeverityBelowCategoryFloor(Severity filed, Severity floor);
    error NotBarred();
    /// @notice A permanent bar is not the reviewer's to undo, and a critical report
    ///         is not undone by time.
    error PermanentBarNeedsOwner();

    // ----------------------------------------------------------- construction

    constructor(address initialOwner) Ownable(initialOwner) {}

    modifier onlyRecorder() {
        if (!isRecorder[msg.sender]) revert NotRecorder();
        _;
    }

    modifier onlyReviewer() {
        if (!isReviewer[msg.sender]) revert NotReviewer();
        _;
    }

    // ----------------------------------------------------------------- admin

    function setRecorder(address recorder, bool allowed) external onlyOwner {
        isRecorder[recorder] = allowed;
        emit RecorderSet(recorder, allowed);
    }

    function setReviewer(address reviewer, bool allowed) external onlyOwner {
        isReviewer[reviewer] = allowed;
        emit ReviewerSet(reviewer, allowed);
    }

    // --------------------------------------------------------------- outcomes

    /// @notice A wish this operator worked on was fulfilled and paid.
    function recordFulfilment(bytes32 humanId) external onlyRecorder {
        if (humanId == bytes32(0)) revert ZeroHumanId();
        Standing storage s = _standing[humanId];
        s.fulfilments += 1;
        emit FulfilmentRecorded(humanId, s.fulfilments);
    }

    /// @notice This operator claimed a wish and did not deliver. Not misconduct —
    ///         attempting hard things and failing is the normal shape of the work —
    ///         but it is information, and it costs a little headroom.
    function recordFailure(bytes32 humanId) external onlyRecorder {
        if (humanId == bytes32(0)) revert ZeroHumanId();
        Standing storage s = _standing[humanId];
        s.failures += 1;
        emit FailureRecorded(humanId, s.failures);
    }

    // --------------------------------------------------------------- conduct

    /// @notice File a conduct report against the human behind an agent.
    /// @dev The filed severity is raised to the category's floor rather than
    ///      rejected outright when it is too low — except that filing `None` is
    ///      always an error. A reviewer grading a wish for somebody's death as
    ///      `Minor` has made a mistake; the safe reading of that mistake is the
    ///      category, not the grade.
    function reportConduct(
        bytes32 humanId,
        Category category,
        Severity severity,
        bytes32 evidenceHash
    ) external onlyReviewer {
        if (humanId == bytes32(0)) revert ZeroHumanId();
        if (severity == Severity.None) revert NoSeverity();

        Severity floor = severityFloor(category);
        Severity effective = severity < floor ? floor : severity;

        Standing storage s = _standing[humanId];
        s.reports += 1;
        if (effective > s.worstSeverity) s.worstSeverity = effective;

        uint96 penalty = _penaltyFor(effective);
        if (penalty != 0) s.penaltyBps += penalty;

        emit ConductReported(humanId, category, effective, penalty, evidenceHash, msg.sender);

        if (effective == Severity.Critical) {
            s.barredUntil = PERMANENT;
            emit Barred(humanId, PERMANENT, effective);
        } else if (effective == Severity.Serious) {
            uint64 until = uint64(block.timestamp) + SERIOUS_SUSPENSION;
            // Never shorten a bar already in force, including a permanent one.
            if (until > s.barredUntil) {
                s.barredUntil = until;
                emit Barred(humanId, until, effective);
            }
        }
    }

    /// @notice The minimum severity a category may be filed at.
    /// @dev Harm to people is never a minor matter, and a wish asking for it is not
    ///      something an operator should be able to settle up for and continue.
    function severityFloor(Category category) public pure returns (Severity) {
        if (
            category == Category.ViolenceAgainstPeople || category == Category.Exploitation
                || category == Category.WeaponsOrMassHarm
        ) {
            return Severity.Critical;
        }
        if (category == Category.TargetedHarassment || category == Category.Fraud) {
            return Severity.Serious;
        }
        return Severity.Minor;
    }

    /// @dev Returns `uint96` so the accumulator can add it without a narrowing
    ///      cast. Every branch is a compile-time constant well inside the type.
    function _penaltyFor(Severity severity) internal pure returns (uint96) {
        if (severity == Severity.Minor) return PENALTY_MINOR_BPS;
        if (severity == Severity.Serious) return PENALTY_SERIOUS_BPS;
        // A critical report bars outright, so a standing penalty on top would be
        // arithmetic nobody reads — the multiplier is already zero while barred.
        return 0;
    }

    /// @notice Lift a bar. Only the owner, always evented.
    /// @dev There is no automatic path out of a critical bar and no reviewer-side
    ///      undo. Reversing one should require the party that can change the rules,
    ///      and should be as visible in the log as the bar itself.
    function pardon(bytes32 humanId) external onlyOwner {
        Standing storage s = _standing[humanId];
        if (s.barredUntil == 0) revert NotBarred();
        s.barredUntil = 0;
        s.worstSeverity = Severity.None;
        emit Pardoned(humanId, msg.sender);
    }

    // ----------------------------------------------------------------- views

    function standingOf(bytes32 humanId) external view returns (Standing memory) {
        return _standing[humanId];
    }

    /// @inheritdoc IStanding
    function isBarred(bytes32 humanId) public view returns (bool) {
        return _standing[humanId].barredUntil > block.timestamp;
    }

    /// @inheritdoc IStanding
    /// @dev Bounded by construction: credit is capped before it is added and the
    ///      result is clamped both ways, so no sequence of recorded outcomes moves
    ///      this outside `[MIN_BPS, MAX_BPS]` — or zero, while barred.
    function multiplierBpsOf(bytes32 humanId) public view returns (uint256) {
        if (isBarred(humanId)) return 0;

        Standing memory s = _standing[humanId];

        uint256 credit = uint256(s.fulfilments) * FULFILMENT_STEP_BPS;
        if (credit > MAX_CREDIT_BPS) credit = MAX_CREDIT_BPS;

        uint256 debit = uint256(s.failures) * FAILURE_STEP_BPS + s.penaltyBps;

        if (credit >= debit) {
            uint256 raised = BASE_BPS + (credit - debit);
            return raised > MAX_BPS ? MAX_BPS : raised;
        }

        uint256 shortfall = debit - credit;
        if (shortfall >= BASE_BPS - MIN_BPS) return MIN_BPS;
        return BASE_BPS - shortfall;
    }
}
