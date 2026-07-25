// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VotiveLimits} from "./VotiveLimits.sol";
import {Deadlines, Intent, Terms, VotiveKind, VotiveState} from "./VotiveTypes.sol";
import {IAttestationRegistry} from "./interfaces/IAttestationRegistry.sol";
import {IVotiveFactory} from "./interfaces/IVotiveFactory.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {BitMaps} from "@openzeppelin/contracts/utils/structs/BitMaps.sol";

/// @title VotiveBase
/// @notice One wish, one contract, its own money. Everything that decides where
///         value can go lives here: the state machine, the fee schedule, the
///         redirect and escheat remedies, and the ledger of payouts that had to
///         be deferred.
///
///         The funding asset is left abstract. A subclass supplies four small
///         hooks — what the votive holds, how to push value optimistically, how
///         to move it in a way that may revert, and what the asset is — and
///         inherits the entire protocol unchanged. That is the point of the
///         split: there is exactly one implementation of the rules, so "native
///         ETH behaves differently from a token" cannot become true by accident.
///
/// @dev Deployed once as an implementation and cloned per wish (EIP-1167), so
///      opening a votive costs a proxy deployment rather than a full contract
///      deployment, and the factory's own bytecode never grows with the
///      protocol. Each clone has its own storage and its own balance; the shared
///      implementation is inert (its initialisers are disabled in the
///      constructor) and never holds anything.
///
///      Value leaves a votive through exactly five doors, and there is no sixth:
///
///        1. `settleStream` — accrued streaming fee, to the treasury.
///        2. settlement — fulfil, redirect or escheat, each paying the schedule
///           and then routing the residue per the intent.
///        3. `claimShare` / `sweepUnclaimedShares` — a recipient's slice of a
///           shared fulfilment, or whatever nobody came for, back to the founder.
///        4. `claimDeferred` — a payout that was already accounted for but whose
///           push failed, pulled by the address it was owed to.
///        5. `sweepStray` — value that arrived after the votive was already
///           terminal, returned to the founder.
abstract contract VotiveBase is Initializable, ReentrancyGuard, EIP712 {
    using BitMaps for BitMaps.BitMap;

    // -------------------------------------------------------------- constants

    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;

    bytes32 private constant REDIRECT_TYPEHASH =
        keccak256("Redirect(address to,uint256 nonce,uint256 deadline)");

    // ---------------------------------------------------------------- storage

    /// @notice The factory that opened this votive.
    IVotiveFactory public factory;
    /// @notice The attestation registry this votive reads, frozen at creation so
    ///         nobody can re-point a live votive at a friendlier oracle.
    IAttestationRegistry public registry;

    /// @notice The fee schedule this votive was opened under. Written once.
    Terms public terms;
    /// @notice The clocks this votive was opened under. Written once.
    Deadlines public deadlines;

    Intent internal _intent;

    /// @notice Current lifecycle position.
    VotiveState public state;

    /// @notice When the founder was last seen. Resets the guardian and escheat
    ///         clocks; a votive whose founder is present is never anyone else's.
    uint64 public lastFounderSignal;
    /// @notice When streaming fee was last brought up to date.
    uint64 public lastAccrual;
    /// @notice When the current attempt started, or zero.
    uint64 public attemptStartedAt;

    /// @notice What the founder committed: the opening deposit plus every
    ///         top-up. Never charged the performance fee.
    uint256 public principal;
    /// @notice Streaming fee accrued to date. Monotonic, and clamped so it can
    ///         never exceed principal — a votive left alone for a century is
    ///         emptied, but never streamed into debt.
    uint256 public streamAccrued;
    /// @notice Streaming fee actually paid out to date.
    uint256 public streamPaid;
    /// @notice Performance fee charged at settlement. Set once, at settlement.
    uint256 public performanceCharged;

    /// @notice Payouts that were accounted for but could not be pushed, pending
    ///         collection by the address they belong to.
    mapping(address account => uint256 amount) public deferred;
    /// @notice Sum of `deferred`. Reserved out of every balance computation, so
    ///         an unclaimed payout is never re-spent.
    uint256 public deferredTotal;

    /// @notice Nonce for signed redirects. The founder can burn it to void any
    ///         signature they have handed out but no longer stand behind.
    uint256 public redirectNonce;

    // ------------------------------------------------- shared settlement state

    /// @notice Merkle root over the recipients of a `ShareWithActive` fulfilment.
    ///         Zero until one is posted, and only ever set on that route.
    bytes32 public shareRoot;
    /// @notice The pot set aside for claimants, pinned at fulfilment and never
    ///         moved afterwards. Correcting an allocation changes who is owed
    ///         what, never how much there is.
    uint256 public shareTotal;
    /// @notice How much of the pot has been collected so far.
    uint256 public shareClaimed;
    /// @notice The sum of leaf weights the posted root commits to.
    uint256 public shareTotalWeight;
    /// @notice The block whose live set the allocation describes, so anybody can
    ///         reproduce it from chain history and check the executor's work.
    uint64 public shareSnapshotBlock;
    /// @notice Until here, the attestor may correct the allocation and nobody may
    ///         claim against it.
    uint64 public shareChallengeEndsAt;
    /// @notice After here, whatever was never collected goes back to the founder.
    uint64 public shareClaimEndsAt;

    BitMaps.BitMap private _shareClaimed;

    // ----------------------------------------------------------------- events

    event Opened(
        address indexed founder,
        VotiveKind kind,
        bytes32 indexed capabilityId,
        bytes32 conditionHash,
        bytes32 storyHash,
        uint256 principal
    );
    event Heartbeat(uint64 at);
    event Offered(address indexed from, uint256 amount);
    event ToppedUp(uint256 amount, uint256 newPrincipal);
    event AttemptBegun(uint64 at);
    event AttemptEnded(address indexed by, uint64 at);
    event StreamAccrued(uint256 amount, uint256 cumulative);
    event StreamSettled(uint256 amount, address indexed to);
    event PerformanceCharged(uint256 amount, address indexed to);
    event Fulfilled(address indexed to, uint256 amount);
    event Reimbursed(address indexed executor, uint256 amount);
    event RedirectedTo(address indexed by, address indexed to, uint256 amount);
    event EscheatedTo(address indexed to, uint256 amount);
    event PayoutDeferred(address indexed to, uint256 amount);
    event PayoutClaimed(address indexed to, uint256 amount);
    event SignaturesInvalidated(uint256 newNonce);
    event StraySwept(address indexed to, uint256 amount);
    event SharesPosted(
        bytes32 root, uint256 total, uint256 totalWeight, uint64 snapshotBlock, uint64 claimEndsAt
    );
    event SharesCorrected(bytes32 previousRoot, bytes32 newRoot, uint256 newTotalWeight);
    event ShareClaimed(uint256 indexed index, address indexed account, uint256 amount, bool pushed);
    event SharesSwept(address indexed to, uint256 amount);

    // ----------------------------------------------------------------- errors

    error NotExecutor();
    error NotFounder();
    error NotAuthorised();
    error WrongState();
    error ZeroFunding();
    error ZeroPayout();
    error BadIntent();
    error BadDeadlines();
    error BadTerms();
    error CapabilityNotOpen();
    error ConditionNotMet();
    error AttemptStillFresh();
    error SilenceTooShort();
    error IrrevocableVotive();
    error LockedDuringAttempt();
    error SignatureExpired();
    error BadSignature();
    error NothingDeferred();
    error NothingToSweep();
    error TransferFailed();
    error NotAttestor();
    error ShareRequired();
    error NotShared();
    error NoSharesPosted();
    error ChallengeWindowOpen();
    error ChallengeWindowClosed();
    error ClaimWindowOpen();
    error ClaimWindowClosed();
    error AlreadyClaimed();
    error BadProof();
    error BadRecipient();

    // -------------------------------------------------------------- modifiers

    /// @dev Waiting or Attempting: the votive is open and holding value.
    modifier onlyLive() {
        if (state != VotiveState.Waiting && state != VotiveState.Attempting) {
            revert WrongState();
        }
        _;
    }

    modifier onlyFounder() {
        if (msg.sender != _intent.founder) revert NotFounder();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != factory.executor()) revert NotExecutor();
        _;
    }

    // ------------------------------------------------------------ constructor

    /// @dev Runs on the implementation only. Disabling initialisers here is what
    ///      keeps the shared implementation permanently inert: it can never be
    ///      taken over, funded, or made to look like a real votive.
    constructor() EIP712("Votive", "1") {
        _disableInitializers();
    }

    // ---------------------------------------------------------- initialisation

    /// @dev Validate and record everything a votive is opened with, then go live.
    ///      Called by the concrete type's initialiser once it has taken custody
    ///      of the funding and can state the principal.
    function _open(
        Intent memory intent_,
        Deadlines memory deadlines_,
        Terms memory terms_,
        address registry_,
        uint256 principal_
    ) internal {
        if (principal_ == 0) revert ZeroFunding();
        if (registry_ == address(0)) revert BadIntent();

        _validateIntent(intent_);
        _validateDeadlines(deadlines_);
        if (
            terms_.streamBps > VotiveLimits.MAX_STREAM_BPS
                || terms_.performanceBps > VotiveLimits.MAX_PERFORMANCE_BPS
        ) revert BadTerms();

        factory = IVotiveFactory(msg.sender);
        registry = IAttestationRegistry(registry_);
        _intent = intent_;
        deadlines = deadlines_;
        terms = terms_;

        principal = principal_;
        state = VotiveState.Waiting;
        lastAccrual = uint64(block.timestamp);
        lastFounderSignal = uint64(block.timestamp);

        emit Opened(
            intent_.founder,
            intent_.kind,
            intent_.capabilityId,
            intent_.conditionHash,
            intent_.storyHash,
            principal_
        );
    }

    function _validateIntent(Intent memory intent_) private view {
        if (intent_.founder == address(0)) revert BadIntent();
        if (
            intent_.capabilityId == bytes32(0) || intent_.conditionHash == bytes32(0)
                || intent_.storyHash == bytes32(0)
        ) revert BadIntent();

        // A budget only means something for a task someone has to go and perform.
        if (intent_.kind != VotiveKind.RealWorldTask && intent_.expenseBudget != 0) {
            revert BadIntent();
        }
        // A guardian's only power is to redirect. On an irrevocable votive that
        // power does not exist, so naming one would be theatre.
        if (intent_.irrevocable && intent_.guardian != address(0)) revert BadIntent();
        // A shared wish has no single recipient, so a named one would be a field
        // the protocol quietly ignores — which is exactly how people end up
        // believing something about their money that is not true.
        if (intent_.kind == VotiveKind.ShareWithActive && intent_.beneficiary != address(0)) {
            revert BadIntent();
        }

        // Nothing may be addressed at the votive itself: value pushed there is
        // value nobody can ever pull back out.
        if (
            intent_.founder == address(this) || intent_.guardian == address(this)
                || intent_.beneficiary == address(this) || intent_.fallbackTo == address(this)
        ) revert BadIntent();
    }

    function _validateDeadlines(Deadlines memory deadlines_) private pure {
        if (deadlines_.guardianAfter < VotiveLimits.MIN_GUARDIAN_WINDOW) revert BadDeadlines();
        if (deadlines_.escheatAfter < VotiveLimits.MIN_ESCHEAT_WINDOW) revert BadDeadlines();
        // The reversible remedy has to be available before the terminal one.
        if (deadlines_.escheatAfter <= deadlines_.guardianAfter) revert BadDeadlines();
        if (deadlines_.attemptWindow < VotiveLimits.MIN_ATTEMPT_WINDOW) revert BadDeadlines();
    }

    // ------------------------------------------------------------ asset hooks

    /// @notice The funding asset: `address(0)` for native value, otherwise the
    ///         token contract.
    function asset() public view virtual returns (address);

    /// @dev Everything this votive holds, denominated in the funding asset.
    function _held() internal view virtual returns (uint256);

    /// @dev Move value optimistically, under a gas ceiling, and NEVER revert the
    ///      caller. Returning false is a normal outcome; the caller records the
    ///      amount as deferred and the recipient pulls it later. A settlement
    ///      must not be blockable by the person it is paying.
    function _pushValue(address to, uint256 amount) internal virtual returns (bool);

    /// @dev Move value with full gas, reverting on failure. Only used where a
    ///      revert is harmless because the caller can simply try again.
    function _moveValue(address to, uint256 amount) internal virtual;

    /// @dev Called at the top of every settlement, before any balance is read.
    ///      A no-op here; a subclass that has put parked value to work elsewhere
    ///      brings it home in this hook so the settlement sees liquid funds.
    function _beforeSettle() internal virtual {}

    // ------------------------------------------------------------------ views

    /// @notice The wish, as the protocol executes it.
    function intent() external view returns (Intent memory) {
        return _intent;
    }

    /// @notice Principal still parked, net of streaming fee accrued against it.
    function parked() public view returns (uint256) {
        return principal - streamAccrued;
    }

    /// @notice Streaming fee accrued but not yet paid to the treasury.
    function unpaidStream() public view returns (uint256) {
        return streamAccrued - streamPaid;
    }

    /// @notice Streaming fee that would accrue if the clock were brought up to
    ///         date right now. Zero once the votive is no longer live — a
    ///         settled votive stops charging rent.
    ///
    /// @dev Charged against committed `principal`, not against principal net of
    ///      fee already taken. That choice makes the total path-independent: the
    ///      fee for a given stretch of time is the same whether `accrue` was
    ///      called once at the end or a thousand times along the way. Charging
    ///      the declining balance instead would mean the bill depended on how
    ///      often somebody happened to poke the contract, which is not a property
    ///      a fee schedule should have. What is left is at most a wei of
    ///      truncation per accrual, and it always rounds towards the founder.
    ///      `headroom` caps the lifetime total at the principal itself, so a
    ///      votive left alone for a century is emptied, never overdrawn.
    function pendingStream() public view returns (uint256) {
        if (state != VotiveState.Waiting && state != VotiveState.Attempting) return 0;
        uint256 headroom = principal - streamAccrued;
        if (headroom == 0) return 0;
        uint256 fee = (principal * terms.streamBps * (block.timestamp - lastAccrual)) / (BPS * YEAR);
        return fee > headroom ? headroom : fee;
    }

    /// @notice Value held above principal and the treasury's unpaid stream:
    ///         gifts, returns, anything anyone sent that the founder did not
    ///         commit. This, and only this, is what the performance fee applies
    ///         to at settlement.
    function offerings() public view returns (uint256) {
        uint256 reserved = parked() + unpaidStream() + deferredTotal;
        uint256 held = _held();
        return held > reserved ? held - reserved : 0;
    }

    /// @notice Who a fulfilment pays: the named beneficiary, or the founder.
    function beneficiary() public view returns (address) {
        address named = _intent.beneficiary;
        return named == address(0) ? _intent.founder : named;
    }

    /// @notice When the guardian's power to redirect opens.
    function guardianOpensAt() public view returns (uint256) {
        return uint256(lastFounderSignal) + deadlines.guardianAfter;
    }

    /// @notice When escheat becomes available to anyone.
    function escheatOpensAt() public view returns (uint256) {
        return uint256(lastFounderSignal) + deadlines.escheatAfter;
    }

    // ------------------------------------------------------------ founder ops

    /// @notice The founder says they are still here, resetting both silence
    ///         clocks. The cheapest and most important call in the protocol: it
    ///         is what separates a wish somebody is still tending from one that
    ///         has been abandoned.
    function heartbeat() external onlyLive onlyFounder {
        lastFounderSignal = uint64(block.timestamp);
        emit Heartbeat(uint64(block.timestamp));
    }

    /// @notice Void every redirect signature issued so far.
    function invalidateSignatures() external onlyLive onlyFounder {
        redirectNonce += 1;
        lastFounderSignal = uint64(block.timestamp);
        emit SignaturesInvalidated(redirectNonce);
    }

    /// @dev Shared top-up mechanics. Streaming fee on the old base is brought up
    ///      to date first, so new principal is only ever charged from the moment
    ///      it actually arrives. A top-up raises principal and is therefore never
    ///      touched by the performance fee — unlike an offering, which is.
    function _applyTopUp(uint256 amount) internal {
        accrue();
        principal += amount;
        lastFounderSignal = uint64(block.timestamp);
        emit ToppedUp(amount, principal);
    }

    // ----------------------------------------------------------- streaming fee

    /// @notice Bring the streaming fee up to date. Callable by anyone, and called
    ///         internally before anything that changes the base it is charged on.
    function accrue() public {
        if (state != VotiveState.Waiting && state != VotiveState.Attempting) return;
        uint256 fee = pendingStream();
        lastAccrual = uint64(block.timestamp);
        if (fee == 0) return;
        streamAccrued += fee;
        emit StreamAccrued(fee, streamAccrued);
    }

    /// @notice Pay the treasury whatever streaming fee has accrued but not yet
    ///         been collected. Permissionless, because the destination is not a
    ///         parameter — it is whatever the factory currently says it is.
    function settleStream() external nonReentrant {
        accrue();
        uint256 amount = unpaidStream();
        if (amount == 0) return;
        streamPaid += amount;
        address to = factory.treasury();
        _moveValue(to, amount);
        emit StreamSettled(amount, to);
    }

    // -------------------------------------------------------------- attempting

    /// @notice The executor takes the votive up, once some model has shown the
    ///         wish is within reach.
    function beginAttempt() external onlyExecutor {
        if (state != VotiveState.Waiting) revert WrongState();
        if (!registry.isCapabilityOpen(_intent.capabilityId)) revert CapabilityNotOpen();
        accrue();
        state = VotiveState.Attempting;
        attemptStartedAt = uint64(block.timestamp);
        emit AttemptBegun(uint64(block.timestamp));
    }

    /// @notice Put the votive back to `Waiting`. The executor may do this at any
    ///         time; anyone may do it once the attempt window has run out, so a
    ///         runtime that dies mid-attempt cannot strand the wish.
    function endAttempt() external {
        if (state != VotiveState.Attempting) revert WrongState();
        if (msg.sender != factory.executor()) {
            if (block.timestamp < uint256(attemptStartedAt) + deadlines.attemptWindow) {
                revert AttemptStillFresh();
            }
        }
        accrue();
        state = VotiveState.Waiting;
        attemptStartedAt = 0;
        emit AttemptEnded(msg.sender, uint64(block.timestamp));
    }

    // -------------------------------------------------------------- fulfilment

    /// @notice The wish came true. Pay the schedule, then route what is left
    ///         where the intent says it goes.
    function fulfil() external nonReentrant onlyExecutor {
        if (state != VotiveState.Attempting) revert WrongState();
        if (_intent.kind == VotiveKind.ShareWithActive) revert ShareRequired();
        if (!registry.isConditionMet(address(this), _intent.conditionHash)) {
            revert ConditionNotMet();
        }

        (address treasury, uint256 platformDue, uint256 residue) = _computeSettlement(true);
        address executor = msg.sender;

        state = VotiveState.Fulfilled;
        factory.onTerminal();

        _pay(treasury, platformDue);

        if (_intent.kind == VotiveKind.RealWorldTask) {
            // Somebody spent real money making this happen; they are made whole
            // first, up to the ceiling the founder agreed to and no further.
            uint256 budget = _intent.expenseBudget;
            uint256 reimbursement = budget > residue ? residue : budget;
            if (reimbursement > 0) {
                _pay(executor, reimbursement);
                emit Reimbursed(executor, reimbursement);
            }
            residue -= reimbursement;
        }

        address to = beneficiary();
        _pay(to, residue);
        emit Fulfilled(to, residue);
    }

    // ------------------------------------------------------- shared fulfilment

    /// @notice Fulfil a `ShareWithActive` votive: the wish was for everyone still
    ///         waiting, so instead of paying one address the executor posts a
    ///         Merkle root over the votives that were open at `snapshotBlock`,
    ///         weighted by what each had parked, and each recipient pulls its own
    ///         slice.
    ///
    /// @dev The ordering here is the entire security argument, so it is worth
    ///      being explicit about.
    ///
    ///      **Fees settle on chain, first.** The schedule is applied and paid out
    ///      before the root is so much as recorded. Whatever the executor posts,
    ///      it is an allocation of the fee-net residue and nothing else. A wrong
    ///      root can therefore mis-address value; it cannot overcharge, cannot
    ///      touch principal accounting, and cannot make the votive insolvent.
    ///
    ///      **The pot is fixed, the allocation is not.** `shareTotal` is pinned
    ///      here and never moves. Inside the challenge window the attestor may
    ///      correct the root and the total weight — the same key that says
    ///      whether a condition is met is the one that says whether a snapshot
    ///      was computed correctly — and no claim is possible until that window
    ///      closes.
    ///
    ///      **Every claim is clamped.** A slice can never exceed what is left in
    ///      the pot, so even a root asserting weights that do not sum to
    ///      `totalWeight` cannot overdraw. The failure mode of a bad root is that
    ///      somebody is short-changed and the remainder eventually goes back to
    ///      the founder — never that the votive pays out money it does not have.
    ///
    /// @param root Merkle root; leaf = keccak256(keccak256(abi.encode(index, account, weight))).
    /// @param totalWeight Sum of the leaf weights the root commits to.
    /// @param snapshotBlock The block whose live set the root describes, so the
    ///        allocation is reproducible by anyone from chain history.
    function fulfilBySharing(bytes32 root, uint256 totalWeight, uint64 snapshotBlock)
        external
        nonReentrant
        onlyExecutor
    {
        if (state != VotiveState.Attempting) revert WrongState();
        if (_intent.kind != VotiveKind.ShareWithActive) revert NotShared();
        if (!registry.isConditionMet(address(this), _intent.conditionHash)) {
            revert ConditionNotMet();
        }

        (address treasury, uint256 platformDue, uint256 residue) = _computeSettlement(true);

        state = VotiveState.Fulfilled;
        factory.onTerminal();
        _pay(treasury, platformDue);

        if (root == bytes32(0) || totalWeight == 0 || residue == 0) {
            // Nobody left to share with, or nothing left to share. The founder
            // gets their own wish back rather than the value sitting in a pot
            // with no claimants.
            address to = _intent.founder;
            _pay(to, residue);
            emit Fulfilled(to, residue);
            return;
        }

        shareRoot = root;
        shareTotal = residue;
        shareTotalWeight = totalWeight;
        shareSnapshotBlock = snapshotBlock;
        shareChallengeEndsAt = uint64(block.timestamp) + VotiveLimits.SHARE_CHALLENGE_WINDOW;
        shareClaimEndsAt = uint64(block.timestamp) + VotiveLimits.SHARE_CLAIM_WINDOW;

        emit SharesPosted(root, residue, totalWeight, snapshotBlock, shareClaimEndsAt);
        emit Fulfilled(address(this), residue);
    }

    /// @notice Pull one recipient's slice of a posted allocation. Permissionless:
    ///         the proof names the account, so anyone may push a claim through on
    ///         somebody else's behalf, and the value still goes to them.
    function claimShare(uint256 index, address account, uint256 weight, bytes32[] calldata proof)
        external
        nonReentrant
    {
        if (shareRoot == bytes32(0)) revert NoSharesPosted();
        if (block.timestamp <= shareChallengeEndsAt) revert ChallengeWindowOpen();
        if (block.timestamp > shareClaimEndsAt) revert ClaimWindowClosed();
        if (_shareClaimed.get(index)) revert AlreadyClaimed();
        // Two recipients an allocation must never be paid out to, because paying
        // them is worse than not paying at all. A transfer to the zero address
        // succeeds at the EVM level, so it would drain the slice into nothing with
        // no revert, no deferral and no event saying anything had gone wrong. A
        // transfer to the votive itself fails, lands in `deferred[address(this)]`,
        // and can never be claimed — the votive cannot call `claimDeferred` on its
        // own behalf. Refusing leaves the slice in the pot, where a corrected
        // allocation can still reach it and the claim window's end returns it to
        // the founder.
        if (account == address(0) || account == address(this)) revert BadRecipient();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, weight))));
        if (!MerkleProof.verify(proof, shareRoot, leaf)) revert BadProof();

        _shareClaimed.set(index);

        uint256 slice = (shareTotal * weight) / shareTotalWeight;
        uint256 remaining = shareTotal - shareClaimed;
        if (slice > remaining) slice = remaining;
        shareClaimed += slice;

        bool pushed = _pay(account, slice);
        emit ShareClaimed(index, account, slice, pushed);
    }

    /// @notice Correct an allocation that was computed wrong, before any of it can
    ///         be claimed. The pot is untouched; only who is owed what changes.
    function correctShares(bytes32 newRoot, uint256 newTotalWeight) external {
        if (msg.sender != registry.attestor()) revert NotAttestor();
        if (shareRoot == bytes32(0)) revert NoSharesPosted();
        if (block.timestamp > shareChallengeEndsAt) revert ChallengeWindowClosed();
        if (newRoot == bytes32(0) || newTotalWeight == 0) revert BadProof();

        emit SharesCorrected(shareRoot, newRoot, newTotalWeight);
        shareRoot = newRoot;
        shareTotalWeight = newTotalWeight;
    }

    /// @notice Once the claim window has closed, return whatever was never
    ///         collected to the founder who put it up.
    function sweepUnclaimedShares() external nonReentrant {
        if (shareRoot == bytes32(0)) revert NoSharesPosted();
        if (block.timestamp <= shareClaimEndsAt) revert ClaimWindowOpen();

        uint256 leftover = shareTotal - shareClaimed;
        if (leftover == 0) revert NothingToSweep();
        shareClaimed = shareTotal;

        address to = _intent.founder;
        _pay(to, leftover);
        emit SharesSwept(to, leftover);
    }

    /// @notice What is still held for claimants (zero once collected or swept).
    function unclaimedShares() public view returns (uint256) {
        if (shareRoot == bytes32(0)) return 0;
        return shareTotal - shareClaimed;
    }

    /// @notice Whether a leaf index has already been collected.
    function hasClaimedShare(uint256 index) external view returns (bool) {
        return _shareClaimed.get(index);
    }

    // ---------------------------------------------------------------- redirect

    /// @notice Send the votive somewhere else. The founder may do this whenever
    ///         they like; a named guardian may do it once the founder has been
    ///         silent past `guardianAfter`. Terminal either way.
    ///
    ///         This is the remedy for a wish that has outlived its point — the
    ///         cause folded, the person it was for is gone, the founder simply
    ///         changed their mind. A votive that could never be redirected would
    ///         only ever be a way to lose money slowly.
    function redirect(address to) external nonReentrant onlyLive {
        _requireRedirectable();
        bool isFounder = msg.sender == _intent.founder;
        bool isGuardian = _intent.guardian != address(0) && msg.sender == _intent.guardian
            && block.timestamp >= guardianOpensAt();
        if (!isFounder && !isGuardian) revert NotAuthorised();
        _redirect(to, msg.sender);
    }

    /// @notice A redirect the founder signed rather than sent, so somebody else
    ///         can pay the gas. Accepts contract signatures (ERC-1271) as well as
    ///         plain keys, because plenty of founders are multisigs.
    function redirectBySignature(address to, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        onlyLive
    {
        _requireRedirectable();
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(REDIRECT_TYPEHASH, to, redirectNonce, deadline)));
        if (!SignatureChecker.isValidSignatureNow(_intent.founder, digest, signature)) {
            revert BadSignature();
        }
        redirectNonce += 1;
        _redirect(to, _intent.founder);
    }

    /// @dev The two reasons a redirect is off the table, checked before anyone's
    ///      authority is even considered so the revert says what is actually
    ///      wrong.
    function _requireRedirectable() private view {
        // An irrevocable votive means it: not the founder, not the guardian,
        // not a signature, not ever.
        if (_intent.irrevocable) revert IrrevocableVotive();
        // Once an executor is out in the world spending money on a real-world
        // task, the funds behind it stop being clawable until that attempt has
        // run its course. The attempt window bounds the freeze.
        if (state == VotiveState.Attempting && _intent.kind == VotiveKind.RealWorldTask) {
            revert LockedDuringAttempt();
        }
    }

    function _redirect(address to, address by) private {
        if (to == address(0) || to == address(this)) revert ZeroPayout();

        lastFounderSignal = uint64(block.timestamp);
        (address treasury, uint256 platformDue, uint256 residue) = _computeSettlement(true);

        state = VotiveState.Redirected;
        factory.onTerminal();

        _pay(treasury, platformDue);
        _pay(to, residue);
        emit RedirectedTo(by, to, residue);
    }

    // ----------------------------------------------------------------- escheat

    /// @notice After a very long silence, anyone may close the votive out to the
    ///         destination its founder named — or, absent one, to the treasury as
    ///         a backstop. Permissionless on purpose: a protocol full of
    ///         permanently dormant votives is a protocol nobody can reason about.
    ///
    ///         Only from `Waiting`. An attempt already in flight is not
    ///         front-runnable by an escheat, and a stalled one falls back to
    ///         `Waiting` on its own once the attempt window elapses.
    ///
    ///         No performance fee is charged here. The fee is for delivering a
    ///         wish, and an escheat delivers nothing; the treasury still collects
    ///         the streaming fee it has already earned.
    function escheat() external nonReentrant {
        if (state != VotiveState.Waiting) revert WrongState();
        if (block.timestamp < escheatOpensAt()) revert SilenceTooShort();

        (address treasury, uint256 platformDue, uint256 residue) = _computeSettlement(false);

        state = VotiveState.Escheated;
        factory.onTerminal();

        address named = _intent.fallbackTo;
        address to = named == address(0) ? treasury : named;

        _pay(treasury, platformDue);
        _pay(to, residue);
        emit EscheatedTo(to, residue);
    }

    // ---------------------------------------------------------- deferred / stray

    /// @notice Collect a payout that was accounted for but could not be pushed.
    function claimDeferred() external nonReentrant {
        uint256 amount = deferred[msg.sender];
        if (amount == 0) revert NothingDeferred();
        deferred[msg.sender] = 0;
        deferredTotal -= amount;
        _moveValue(msg.sender, amount);
        emit PayoutClaimed(msg.sender, amount);
    }

    /// @notice Return value that arrived after the votive was already settled to
    ///         the founder. Anyone may call it; the destination is not theirs to
    ///         choose. Deferred payouts and an open share pot are both reserved,
    ///         so this can never reach into money somebody is still owed.
    function sweepStray() external nonReentrant {
        if (
            state == VotiveState.Nascent || state == VotiveState.Waiting
                || state == VotiveState.Attempting
        ) {
            revert WrongState();
        }
        uint256 stray = _held() - deferredTotal - unclaimedShares();
        if (stray == 0) revert NothingToSweep();
        address to = _intent.founder;
        _pay(to, stray);
        emit StraySwept(to, stray);
    }

    // -------------------------------------------------------------- settlement

    /// @dev The whole fee schedule, applied once, in one place.
    ///
    ///      Ordering matters: offerings are measured before `streamPaid` moves,
    ///      or the streaming fee about to be paid would be counted as a gain and
    ///      charged the performance fee on its way out.
    ///
    ///      Nothing is transferred here. Callers move to a terminal state first
    ///      and pay afterwards, so a recipient that calls back in finds a votive
    ///      that has already finished deciding.
    /// @param chargePerformance False on escheat, where nothing was delivered.
    function _computeSettlement(bool chargePerformance)
        private
        returns (address treasury, uint256 platformDue, uint256 residue)
    {
        _beforeSettle();
        accrue();

        uint256 stream = unpaidStream();
        uint256 gain = offerings();
        uint256 performance = chargePerformance ? (gain * terms.performanceBps) / BPS : 0;

        streamPaid += stream;
        performanceCharged = performance;

        treasury = factory.treasury();
        platformDue = stream + performance;
        residue = _held() - deferredTotal - platformDue;

        if (stream > 0) emit StreamSettled(stream, treasury);
        if (performance > 0) emit PerformanceCharged(performance, treasury);
    }

    /// @dev Push value; on failure, record it as owed and carry on. Returns
    ///      whether the push landed, for callers that care.
    function _pay(address to, uint256 amount) internal returns (bool pushed) {
        if (amount == 0) return true;
        pushed = _pushValue(to, amount);
        if (!pushed) {
            deferred[to] += amount;
            deferredTotal += amount;
            emit PayoutDeferred(to, amount);
        }
    }
}
