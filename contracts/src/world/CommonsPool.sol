// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IHumanBacking} from "../interfaces/IHumanBacking.sol";
import {IStanding} from "../interfaces/IStanding.sol";
import {AssuranceTiers} from "./AssuranceTiers.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CommonsPool
/// @notice Shared working capital that agents draw on to get wishes done — paying
///         for an API call, a dataset, a compute run, another agent's time.
///
///         The allowance is metered per *human*, per epoch. Running ten agents
///         gets an operator no more than running one, because all ten resolve to
///         the same identifier and spend from the same headroom. That is the only
///         property that makes a shared pot survive contact with anonymous agents:
///         without it the correct strategy is always to register more wallets.
///
///         Within that, how much an operator may take is the product of two things
///         they earn separately — how strongly their humanity is evidenced, and
///         what their track record is worth. Neither substitutes for the other. The
///         strongest evidence with a bad record draws little; a spotless record on
///         a device-only signal also draws little. And above a step-up threshold,
///         no record at all is enough without the strongest evidence, because past
///         performance is not proof that a person is still on the other end.
///
/// @dev Ordering is checks-effects-interactions throughout: the epoch's drawn
///      total is written before any value leaves, so a payee that calls back in
///      finds its headroom already spent. The reentrancy guard is belt as well as
///      braces.
contract CommonsPool is Ownable2Step, ReentrancyGuard {
    // ------------------------------------------------------------------ types

    /// @notice Why a draw would be refused. Returned by {quote} so a caller can
    ///         explain itself to an operator instead of just reverting at them.
    enum Refusal {
        None,
        /// @notice No live humanity backing on the calling wallet.
        NotHumanBacked,
        /// @notice The human is barred or suspended for conduct.
        Barred,
        /// @notice Evidence is weaker than this deployment accepts at all.
        BelowMinimumAssurance,
        /// @notice Over the step-up threshold without the strongest evidence.
        StepUpRequired,
        /// @notice The human's epoch allowance is used up.
        NoHeadroom,
        /// @notice The pool itself is short of funds.
        PoolTooLow,
        /// @notice Zero, or a payee that cannot be paid.
        BadRequest
    }

    // ------------------------------------------------------------- immutables

    /// @notice How long an allowance window lasts.
    /// @dev Immutable on purpose. A settable epoch length would silently re-map
    ///      every historical `drawn` bucket the moment it changed, so an operator's
    ///      spent total could jump to zero — or to another operator's — without a
    ///      single draw happening. Not worth the flexibility.
    uint64 public immutable epochLength;

    IHumanBacking public immutable backing;
    IStanding public immutable standing;

    // ----------------------------------------------------------------- state

    /// @notice Allowance a human at parity on both axes may draw per epoch.
    uint256 public baseAllowance;
    /// @notice Draws above this need the strongest assurance tier. Zero disables it.
    uint256 public stepUpAmount;
    /// @notice Weakest tier allowed to touch the commons at all.
    uint8 public minAssurance;

    /// @dev Drawn per human, per epoch.
    mapping(bytes32 humanId => mapping(uint256 epoch => uint256 drawn)) private _drawn;

    // ---------------------------------------------------------------- events

    event Funded(address indexed from, uint256 amount);
    event Drawn(
        bytes32 indexed humanId,
        address indexed wallet,
        address indexed payee,
        uint256 amount,
        uint256 ceiling,
        uint256 remaining
    );
    event Returned(bytes32 indexed humanId, address indexed from, uint256 amount);
    event ParametersChanged(uint256 baseAllowance, uint256 stepUpAmount, uint8 minAssurance);
    event Swept(address indexed to, uint256 amount);

    // ---------------------------------------------------------------- errors

    error Refused(Refusal reason);
    error NothingToFund();
    error TransferFailed();
    error ZeroAddress();

    // ----------------------------------------------------------- construction

    constructor(
        address initialOwner,
        IHumanBacking backingRegistry,
        IStanding standingLedger,
        uint64 epochLength_,
        uint256 baseAllowance_,
        uint256 stepUpAmount_,
        uint8 minAssurance_
    ) Ownable(initialOwner) {
        if (address(backingRegistry) == address(0) || address(standingLedger) == address(0)) {
            revert ZeroAddress();
        }
        if (epochLength_ == 0) revert Refused(Refusal.BadRequest);
        if (!AssuranceTiers.isKnown(minAssurance_)) revert Refused(Refusal.BadRequest);

        backing = backingRegistry;
        standing = standingLedger;
        epochLength = epochLength_;
        baseAllowance = baseAllowance_;
        stepUpAmount = stepUpAmount_;
        minAssurance = minAssurance_;
        emit ParametersChanged(baseAllowance_, stepUpAmount_, minAssurance_);
    }

    // ----------------------------------------------------------------- admin

    function setParameters(uint256 baseAllowance_, uint256 stepUpAmount_, uint8 minAssurance_)
        external
        onlyOwner
    {
        if (!AssuranceTiers.isKnown(minAssurance_)) revert Refused(Refusal.BadRequest);
        baseAllowance = baseAllowance_;
        stepUpAmount = stepUpAmount_;
        minAssurance = minAssurance_;
        emit ParametersChanged(baseAllowance_, stepUpAmount_, minAssurance_);
    }

    /// @notice Recover pool funds to a destination the owner names.
    /// @dev Deliberately does not touch any `drawn` accounting. Sweeping is an
    ///      operational escape hatch for winding a deployment down, not a way to
    ///      reset anybody's spent allowance.
    function sweep(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > address(this).balance) revert Refused(Refusal.PoolTooLow);
        emit Swept(to, amount);
        _send(to, amount);
    }

    // ---------------------------------------------------------------- funding

    /// @notice Add working capital to the commons. Open to anyone.
    function fund() external payable {
        if (msg.value == 0) revert NothingToFund();
        emit Funded(msg.sender, msg.value);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Hand unspent capital back and free the epoch headroom it used.
    /// @dev The counterpart to a draw, and the reason an honest agent is not
    ///      punished for over-estimating: quote high, return the remainder, keep
    ///      the allowance. Credited against the *current* epoch, so it cannot be
    ///      used to reopen a window that has already closed.
    function refund() external payable {
        if (msg.value == 0) revert NothingToFund();
        bytes32 humanId = backing.humanOf(msg.sender);
        if (humanId == bytes32(0)) revert Refused(Refusal.NotHumanBacked);

        uint256 epoch = currentEpoch();
        uint256 spent = _drawn[humanId][epoch];
        // Saturating: returning more than was drawn this epoch is a donation, not a
        // negative balance that would underflow or bank credit for later.
        _drawn[humanId][epoch] = msg.value >= spent ? 0 : spent - msg.value;

        emit Returned(humanId, msg.sender, msg.value);
    }

    // ------------------------------------------------------------------- draw

    /// @notice Draw `amount` from the commons and send it to `payee`.
    /// @dev The caller is the agent wallet; the human it resolves to is who pays.
    ///      `payee` is separate so an agent can settle a supplier directly rather
    ///      than routing money through its own balance first.
    function draw(uint256 amount, address payee) external nonReentrant returns (bytes32 humanId) {
        (bool allowed, Refusal reason, uint256 ceiling,) = quote(msg.sender, amount, payee);
        if (!allowed) revert Refused(reason);

        humanId = backing.humanOf(msg.sender);
        uint256 epoch = currentEpoch();

        // Effects before interaction: a payee that calls back finds this spent.
        uint256 spent = _drawn[humanId][epoch] + amount;
        _drawn[humanId][epoch] = spent;

        emit Drawn(humanId, msg.sender, payee, amount, ceiling, ceiling - spent);
        _send(payee, amount);
    }

    // ----------------------------------------------------------------- views

    function currentEpoch() public view returns (uint256) {
        return block.timestamp / epochLength;
    }

    /// @notice What `wallet`'s human may draw per epoch, all in.
    /// @dev The product of the two things earned separately — evidence weight and
    ///      track record — against the base allowance. Zero for anyone unbacked or
    ///      barred, since `multiplierBpsOf` is zero while barred.
    function ceilingOf(address wallet) public view returns (uint256) {
        bytes32 humanId = backing.humanOf(wallet);
        if (humanId == bytes32(0)) return 0;

        uint8 tier = backing.assuranceOf(wallet);
        if (tier < minAssurance || !AssuranceTiers.isKnown(tier)) return 0;

        uint256 weighted = (baseAllowance * AssuranceTiers.weight(tier)) / AssuranceTiers.BPS;
        return (weighted * standing.multiplierBpsOf(humanId)) / AssuranceTiers.BPS;
    }

    /// @notice What is left of this epoch's allowance for `wallet`'s human.
    function remainingOf(address wallet) public view returns (uint256) {
        uint256 ceiling = ceilingOf(wallet);
        bytes32 humanId = backing.humanOf(wallet);
        if (humanId == bytes32(0)) return 0;

        uint256 spent = _drawn[humanId][currentEpoch()];
        // Saturating, because lowering `baseAllowance` mid-epoch can legitimately
        // leave an operator already over the new ceiling.
        return spent >= ceiling ? 0 : ceiling - spent;
    }

    function drawnBy(bytes32 humanId, uint256 epoch) external view returns (uint256) {
        return _drawn[humanId][epoch];
    }

    /// @notice Would this draw be allowed, and if not, why?
    /// @dev Exists so callers can explain a refusal rather than surfacing a bare
    ///      revert. `draw` runs exactly this, so the two cannot disagree.
    function quote(address wallet, uint256 amount, address payee)
        public
        view
        returns (bool allowed, Refusal reason, uint256 ceiling, uint256 remaining)
    {
        if (amount == 0 || payee == address(0) || payee == address(this)) {
            return (false, Refusal.BadRequest, 0, 0);
        }

        bytes32 humanId = backing.humanOf(wallet);
        if (humanId == bytes32(0)) return (false, Refusal.NotHumanBacked, 0, 0);
        if (standing.isBarred(humanId)) return (false, Refusal.Barred, 0, 0);

        uint8 tier = backing.assuranceOf(wallet);
        if (tier < minAssurance) return (false, Refusal.BelowMinimumAssurance, 0, 0);

        // The step-up is tested against the epoch's *running total*, not this one
        // draw. Checking a single draw in isolation would make the threshold
        // meaningless: an operator wanting twice it would simply ask twice, and the
        // requirement for stronger evidence would amount to a nuisance rather than
        // a control. Cumulative also means it cannot be dodged across the several
        // wallets of one human, since the total is theirs, not the wallet's.
        uint256 runningTotal = _drawn[humanId][currentEpoch()] + amount;
        if (!AssuranceTiers.meetsStepUp(tier, runningTotal, stepUpAmount)) {
            return (false, Refusal.StepUpRequired, 0, 0);
        }

        ceiling = ceilingOf(wallet);
        remaining = remainingOf(wallet);
        if (amount > remaining) return (false, Refusal.NoHeadroom, ceiling, remaining);
        if (amount > address(this).balance) return (false, Refusal.PoolTooLow, ceiling, remaining);

        return (true, Refusal.None, ceiling, remaining);
    }

    // --------------------------------------------------------------- internal

    function _send(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
