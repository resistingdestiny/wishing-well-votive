// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAttestationRegistry} from "../interfaces/IAttestationRegistry.sol";

/// @title AgentBountyRail
/// @notice Escrow for paying an agent to go and do something, released in
///         increments as the work is attested rather than in one lump at the end.
///
///         Some wishes cannot be settled by a contract at all. Somebody has to
///         file the document, book the appointment, buy the compute. The protocol
///         can hold value against that job, but it cannot do the job — so it needs
///         a way to pay whoever does, without either side having to trust the
///         other first.
///
///         The shape here is: a funder escrows the reward, an agent claims the
///         task exclusively for a window, and each milestone the attestor confirms
///         releases its slice. If the agent stops halfway, it keeps what it earned
///         and the rest goes back. If nobody claims, the funder gets everything
///         back. Nobody is ever asked to pay first and hope.
///
/// @dev Two decisions worth stating.
///
///      **Payouts are credited, not pushed.** An agent doing many small tasks
///      wants one withdrawal, not fifty transfers, and a push to a contract agent
///      whose fallback reverts must never be able to block a milestone release for
///      everybody else. So `release` moves numbers and `withdraw` moves value, and
///      the two cannot interfere.
///
///      **This contract is not a source of truth.** Whether a milestone is done is
///      exactly the kind of question the attestation registry already answers, so
///      it answers it here too — `release` reads the registry and does no judging
///      of its own. Adding a second oracle would mean two things that could
///      disagree about the same fact.
///
///      Written for a chain where fees are small enough that paying an agent in
///      five increments instead of one is a reasonable thing to do. On a chain
///      where each release costs more than a milestone is worth, the same contract
///      still works — you would simply use one milestone.
contract AgentBountyRail {
    // ------------------------------------------------------------------- types

    struct Bounty {
        /// @dev Who escrowed the reward and gets the remainder back.
        address funder;
        /// @dev The agent currently holding the exclusive claim, or zero.
        address agent;
        /// @dev Optional: the votive this task serves, for anyone tracing why the
        ///      work was commissioned. Zero for a standalone bounty.
        address votive;
        /// @dev Commitment to the task description, which lives off chain.
        bytes32 taskHash;
        /// @dev The capability an agent must have demonstrated before it may
        ///      claim. Stops a bounty being locked up by an agent that provably
        ///      cannot do the work yet.
        bytes32 capabilityId;
        /// @dev Total escrowed.
        uint256 total;
        /// @dev Released to the agent so far.
        uint256 paid;
        /// @dev The claim lapses at this point and anyone may free the bounty.
        uint64 claimExpiresAt;
        /// @dev After this the funder may reclaim whatever was never earned.
        uint64 refundableAt;
        bool closed;
    }

    // ----------------------------------------------------------------- storage

    IAttestationRegistry public immutable registry;

    /// @notice Shortest claim window an agent can be given. A window measured in
    ///         seconds would let a bystander free the claim before the agent had
    ///         finished the first thing it started.
    uint64 public constant MIN_CLAIM_WINDOW = 1 hours;
    /// @notice A bounty must stay open for at least this long before its funder
    ///         can pull the reward back, so posting one and immediately reclaiming
    ///         it cannot be used to waste agents' time.
    uint64 public constant MIN_LIFETIME = 1 days;

    uint256 public bountyCount;
    mapping(uint256 id => Bounty) private _bounties;

    /// @notice Where an agent is paid. Registering is how an agent says "this
    ///         address is me", and lets the address earning be different from the
    ///         address working — a hot key can do the work while a cold one holds
    ///         the money.
    mapping(address agent => address payout) public payoutOf;

    /// @notice Withdrawable balance, by payout address.
    mapping(address payout => uint256 amount) public credited;
    /// @notice Sum of `credited`, so the contract can tell escrow from earnings.
    uint256 public creditedTotal;

    /// @notice Lifetime totals per agent — the public record of who actually
    ///         delivers, which is the thing worth having in the open.
    mapping(address agent => uint256 amount) public earned;
    mapping(address agent => uint256 count) public milestonesDelivered;

    // ------------------------------------------------------------------ events

    event AgentRegistered(address indexed agent, address indexed payout);
    event BountyPosted(
        uint256 indexed id,
        address indexed funder,
        address indexed votive,
        bytes32 taskHash,
        bytes32 capabilityId,
        uint256 total,
        uint64 refundableAt
    );
    event BountyClaimed(uint256 indexed id, address indexed agent, uint64 claimExpiresAt);
    event ClaimReleased(uint256 indexed id, address indexed agent, address indexed by);
    event MilestoneReleased(
        uint256 indexed id,
        address indexed agent,
        bytes32 indexed milestoneHash,
        uint256 amount,
        uint256 paidToDate
    );
    event BountyClosed(uint256 indexed id, uint256 paid, uint256 refunded);
    event Credited(address indexed payout, uint256 amount);
    event Withdrawn(address indexed payout, uint256 amount);

    // ------------------------------------------------------------------ errors

    error ZeroAddress();
    error ZeroReward();
    error NoSuchBounty();
    error AlreadyClaimed();
    error NotTheAgent();
    error NotTheFunder();
    error NotRegistered();
    error CapabilityNotOpen();
    error ClaimStillHeld();
    error BountyIsClosed();
    error NothingClaimed();
    error MilestoneNotAttested();
    error MilestoneAlreadyReleased();
    error ExceedsRemaining();
    error TooSoonToRefund();
    error WindowTooShort();
    error LifetimeTooShort();
    error NothingCredited();
    error TransferFailed();

    /// @dev Each milestone may only pay once, keyed by (bounty, milestone).
    mapping(uint256 id => mapping(bytes32 milestoneHash => bool)) public milestoneReleased;

    constructor(IAttestationRegistry registry_) {
        if (address(registry_) == address(0)) revert ZeroAddress();
        registry = registry_;
    }

    // ------------------------------------------------------------------ agents

    /// @notice Declare where this agent is paid. Callable again to rotate the
    ///         payout address; already-credited balances are unaffected, because
    ///         they belong to the address that earned them.
    function registerAgent(address payout) external {
        if (payout == address(0) || payout == address(this)) revert ZeroAddress();
        payoutOf[msg.sender] = payout;
        emit AgentRegistered(msg.sender, payout);
    }

    // ---------------------------------------------------------------- posting

    /// @notice Escrow a reward for a task.
    /// @param votive The votive this serves, or zero for a standalone bounty.
    /// @param taskHash Commitment to the task description held off chain.
    /// @param capabilityId What an agent must have demonstrated before claiming.
    /// @param claimWindow How long a claiming agent gets before the claim lapses.
    /// @param lifetime How long before the funder may reclaim what was not earned.
    function postBounty(
        address votive,
        bytes32 taskHash,
        bytes32 capabilityId,
        uint64 claimWindow,
        uint64 lifetime
    ) external payable returns (uint256 id) {
        if (msg.value == 0) revert ZeroReward();
        if (claimWindow < MIN_CLAIM_WINDOW) revert WindowTooShort();
        if (lifetime < MIN_LIFETIME) revert LifetimeTooShort();

        id = ++bountyCount;
        _bounties[id] = Bounty({
            funder: msg.sender,
            agent: address(0),
            votive: votive,
            taskHash: taskHash,
            capabilityId: capabilityId,
            total: msg.value,
            paid: 0,
            // Set when an agent actually claims; `claimWindow` is remembered by
            // being folded into the claim at that point.
            claimExpiresAt: claimWindow,
            refundableAt: uint64(block.timestamp) + lifetime,
            closed: false
        });

        emit BountyPosted(
            id, msg.sender, votive, taskHash, capabilityId, msg.value, _bounties[id].refundableAt
        );
    }

    // ---------------------------------------------------------------- claiming

    /// @notice Take exclusive responsibility for a task. Exclusive so two agents
    ///         do not both spend real money on the same job and then argue about
    ///         who gets paid; time-limited so one that goes quiet cannot sit on it.
    function claim(uint256 id) external {
        Bounty storage bounty = _live(id);
        if (bounty.agent != address(0)) revert AlreadyClaimed();
        if (payoutOf[msg.sender] == address(0)) revert NotRegistered();
        if (!registry.isCapabilityOpen(bounty.capabilityId)) revert CapabilityNotOpen();

        uint64 window = bounty.claimExpiresAt; // still the raw window until now
        bounty.agent = msg.sender;
        bounty.claimExpiresAt = uint64(block.timestamp) + window;

        emit BountyClaimed(id, msg.sender, bounty.claimExpiresAt);
    }

    /// @notice Give up a claim, or take it off an agent whose window has run out.
    ///         Whatever that agent already earned stays earned — this frees the
    ///         task, it does not claw anything back.
    function releaseClaim(uint256 id) external {
        Bounty storage bounty = _live(id);
        address agent = bounty.agent;
        if (agent == address(0)) revert NothingClaimed();
        if (msg.sender != agent && block.timestamp < bounty.claimExpiresAt) {
            revert ClaimStillHeld();
        }

        bounty.agent = address(0);
        bounty.claimExpiresAt = MIN_CLAIM_WINDOW;
        emit ClaimReleased(id, agent, msg.sender);
    }

    // --------------------------------------------------------------- releasing

    /// @notice Release one milestone's slice to the claiming agent.
    ///
    /// @dev Permissionless to call, because it decides nothing: the amount is the
    ///      caller's to propose but the *authority* is the registry's, and the
    ///      registry has to have attested this exact milestone for this exact
    ///      bounty. A caller can only ever move money the attestor has already
    ///      approved, to an agent the bounty already named.
    ///
    ///      The milestone hash is bound to the bounty id by the caller of
    ///      `attestCondition`, and recorded here so the same attestation cannot be
    ///      spent twice.
    function release(uint256 id, bytes32 milestoneHash, uint256 amount) external {
        Bounty storage bounty = _live(id);
        address agent = bounty.agent;
        if (agent == address(0)) revert NothingClaimed();
        if (milestoneReleased[id][milestoneHash]) revert MilestoneAlreadyReleased();
        if (amount == 0) revert ZeroReward();
        if (amount > bounty.total - bounty.paid) revert ExceedsRemaining();
        if (!registry.isConditionMet(address(this), milestoneHash)) revert MilestoneNotAttested();

        milestoneReleased[id][milestoneHash] = true;
        bounty.paid += amount;

        address payout = payoutOf[agent];
        earned[agent] += amount;
        milestonesDelivered[agent] += 1;
        _credit(payout, amount);

        emit MilestoneReleased(id, agent, milestoneHash, amount, bounty.paid);

        // Fully paid is fully done; nothing is left to argue about.
        if (bounty.paid == bounty.total) {
            bounty.closed = true;
            emit BountyClosed(id, bounty.paid, 0);
        }
    }

    /// @notice The funder reclaims whatever was never earned, once the bounty has
    ///         had its full lifetime to be delivered. Deliberately not available
    ///         while an agent still holds a live claim — pulling the reward out
    ///         from under an agent mid-task is the one thing that would make this
    ///         rail not worth working for.
    function refund(uint256 id) external {
        Bounty storage bounty = _live(id);
        if (msg.sender != bounty.funder) revert NotTheFunder();
        if (block.timestamp < bounty.refundableAt) revert TooSoonToRefund();
        if (bounty.agent != address(0) && block.timestamp < bounty.claimExpiresAt) {
            revert ClaimStillHeld();
        }

        uint256 remainder = bounty.total - bounty.paid;
        bounty.closed = true;
        if (remainder > 0) _credit(bounty.funder, remainder);
        emit BountyClosed(id, bounty.paid, remainder);
    }

    // -------------------------------------------------------------- withdrawal

    /// @notice Take out everything credited to you. One call however many
    ///         milestones it came from, which is the point of crediting rather
    ///         than pushing.
    function withdraw() external returns (uint256 amount) {
        amount = credited[msg.sender];
        if (amount == 0) revert NothingCredited();

        credited[msg.sender] = 0;
        creditedTotal -= amount;

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------- views

    function bountyOf(uint256 id) external view returns (Bounty memory) {
        if (id == 0 || id > bountyCount) revert NoSuchBounty();
        return _bounties[id];
    }

    /// @notice What is still escrowed against a bounty and not yet earned.
    function remaining(uint256 id) external view returns (uint256) {
        Bounty storage b = _bounties[id];
        if (b.closed) return 0;
        return b.total - b.paid;
    }

    /// @notice Value held for bounties still in flight, as opposed to earnings
    ///         waiting to be withdrawn. The two must add up to the balance.
    function escrowed() public view returns (uint256) {
        return address(this).balance - creditedTotal;
    }

    // --------------------------------------------------------------- internals

    function _live(uint256 id) private view returns (Bounty storage bounty_) {
        if (id == 0 || id > bountyCount) revert NoSuchBounty();
        bounty_ = _bounties[id];
        if (bounty_.closed) revert BountyIsClosed();
    }

    function _credit(address payout, uint256 amount) private {
        credited[payout] += amount;
        creditedTotal += amount;
        emit Credited(payout, amount);
    }
}
