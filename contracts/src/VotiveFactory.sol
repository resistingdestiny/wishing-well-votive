// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NativeVotive} from "./NativeVotive.sol";
import {TokenVotive} from "./TokenVotive.sol";
import {VotiveBase} from "./VotiveBase.sol";
import {VotiveLimits} from "./VotiveLimits.sol";
import {Deadlines, Intent, Terms, VotiveState} from "./VotiveTypes.sol";
import {IAccessGate} from "./gates/IAccessGate.sol";
import {IAttestationRegistry} from "./interfaces/IAttestationRegistry.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title VotiveFactory
/// @notice Opens votives, keeps the list of which ones are still live, and holds
///         the handful of settings that are genuinely protocol-wide: where fees
///         go, who may execute, who may open a votive at all, and what terms and
///         clocks a votive gets when its founder does not name their own.
///
/// @dev Votives are EIP-1167 clones of a single immutable implementation. Three
///      things follow from that, all of them load-bearing:
///
///      - **Opening a wish is cheap.** A clone is a few hundred bytes of proxy,
///        not a redeployment of the protocol, so small votives are viable.
///      - **The factory never grows.** However large the votive implementation
///        becomes, the factory's own bytecode does not move, so the contract
///        limit stops being an architectural constraint on the protocol.
///      - **The implementation cannot be swapped.** It is immutable here on
///        purpose. A settable implementation would mean the fee ceilings and
///        clock floors compiled into it were only as durable as the owner's
///        key; making it immutable means a new implementation requires a new
///        factory, in public, and leaves every existing votive untouched.
contract VotiveFactory is Ownable2Step {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- storage

    /// @notice The attestation registry every votive opened here will read.
    IAttestationRegistry public immutable registry;

    /// @notice The implementation native-asset votives are cloned from.
    address public immutable nativeImplementation;

    /// @notice The implementation token-funded votives are cloned from.
    address public immutable tokenImplementation;

    /// @notice Where protocol fees are sent.
    address public treasury;

    /// @notice The runtime allowed to attempt and fulfil votives.
    address public executor;

    /// @notice Consulted once per votive, at the moment it is opened.
    IAccessGate public accessGate;

    /// @notice Terms quoted to a votive opened right now.
    Terms public defaultTerms;

    /// @notice Clocks a votive gets for any window its founder leaves at zero.
    Deadlines public defaultDeadlines;

    address[] private _all;
    address[] private _live;
    /// @dev Position in `_live`, offset by one so that zero means "not live".
    mapping(address votive => uint256 indexPlusOne) private _livePosition;

    /// @notice Whether an address is a votive this factory opened.
    mapping(address account => bool) public isVotive;

    /// @notice ERC-20s a votive may currently be funded in.
    /// @dev Checked only at creation. A votive captures its funding token
    ///      immutably and never re-reads this map, so de-listing a token blocks
    ///      new votives and cannot strand a single existing one.
    mapping(address token => bool) public allowedToken;

    // ----------------------------------------------------------------- events

    event VotiveOpened(
        address indexed votive,
        address indexed founder,
        bytes32 indexed capabilityId,
        address asset,
        uint256 principal
    );
    event VotiveSettled(address indexed votive, VotiveState finalState);
    event TreasuryChanged(address indexed previous, address indexed current);
    event ExecutorChanged(address indexed previous, address indexed current);
    event AccessGateChanged(address indexed previous, address indexed current);
    event DefaultTermsChanged(Terms terms);
    event DefaultDeadlinesChanged(Deadlines deadlines);
    event TokenAllowed(address indexed token, bool allowed);

    // ----------------------------------------------------------------- errors

    error ZeroAddress();
    error ZeroFunding();
    error NotPermitted();
    error NotFounder();
    error NotAVotive();
    error TermsRejected();
    error TokenNotAllowed();
    error BadTerms();
    error BadDeadlines();

    // ------------------------------------------------------------ constructor

    constructor(
        address initialOwner,
        IAttestationRegistry registry_,
        address nativeImplementation_,
        address tokenImplementation_,
        address treasury_,
        address executor_,
        IAccessGate accessGate_
    ) Ownable(initialOwner) {
        if (
            address(registry_) == address(0) || nativeImplementation_ == address(0)
                || tokenImplementation_ == address(0) || treasury_ == address(0)
                || executor_ == address(0) || address(accessGate_) == address(0)
        ) revert ZeroAddress();

        registry = registry_;
        nativeImplementation = nativeImplementation_;
        tokenImplementation = tokenImplementation_;
        treasury = treasury_;
        executor = executor_;
        accessGate = accessGate_;

        // 2 % per annum on parked principal, 8 % of offerings above it.
        defaultTerms = Terms({streamBps: 200, performanceBps: 800});
        // A guardian waits a year, escheat waits five, an attempt gets a week.
        defaultDeadlines =
            Deadlines({guardianAfter: 365 days, escheatAfter: 5 * 365 days, attemptWindow: 7 days});

        emit TreasuryChanged(address(0), treasury_);
        emit ExecutorChanged(address(0), executor_);
        emit AccessGateChanged(address(0), address(accessGate_));
        emit DefaultTermsChanged(defaultTerms);
        emit DefaultDeadlinesChanged(defaultDeadlines);
    }

    // ------------------------------------------------------------------- open

    /// @notice Open and fund a votive in the native asset.
    ///
    ///         The founder sends this transaction themselves — that is what makes
    ///         the intent theirs, with no separate signing step to get wrong.
    ///         Any deadline left at zero is filled from the factory defaults.
    ///
    /// @param intent_ The wish, already parsed into its machine-readable form.
    /// @param deadlineOverrides Per-votive clocks; zero fields take the defaults.
    /// @param maxTerms The worst fee schedule the founder is willing to accept.
    ///        The factory applies its *current* terms and reverts if they are
    ///        above this, so a repricing that lands in the same block as an
    ///        opening cannot quietly become the terms somebody agreed to.
    /// @return votive The address of the newly opened votive.
    function open(
        Intent calldata intent_,
        Deadlines calldata deadlineOverrides,
        Terms calldata maxTerms
    ) external payable returns (address votive) {
        if (msg.value == 0) revert ZeroFunding();
        (Terms memory quoted, Deadlines memory clocks) =
            _admit(intent_, deadlineOverrides, maxTerms);

        votive = Clones.clone(nativeImplementation);
        _record(votive, intent_.capabilityId);
        NativeVotive(payable(votive)).initialize{value: msg.value}(
            intent_, clocks, quoted, address(registry)
        );

        emit VotiveOpened(votive, msg.sender, intent_.capabilityId, address(0), msg.value);
    }

    /// @notice Open and fund a votive in an allowlisted ERC-20. The founder must
    ///         approve this factory for `amount` first.
    ///
    /// @dev The tokens go straight from the founder into the freshly cloned
    ///      votive — the factory is never, at any point in the transaction, the
    ///      holder of anybody's funds. The votive then adopts whatever actually
    ///      landed as its principal, so a token that skims on transfer credits
    ///      what arrived rather than what was asked for.
    /// @param token The funding token, which must currently be allowlisted. The
    ///        votive captures it immutably, so de-listing later blocks new
    ///        votives without disturbing existing ones.
    /// @param amount How much to move in.
    function openWithToken(
        Intent calldata intent_,
        Deadlines calldata deadlineOverrides,
        Terms calldata maxTerms,
        IERC20 token,
        uint256 amount
    ) external returns (address votive) {
        if (!allowedToken[address(token)]) revert TokenNotAllowed();
        if (amount == 0) revert ZeroFunding();
        (Terms memory quoted, Deadlines memory clocks) =
            _admit(intent_, deadlineOverrides, maxTerms);

        votive = Clones.clone(tokenImplementation);
        _record(votive, intent_.capabilityId);
        token.safeTransferFrom(msg.sender, votive, amount);
        TokenVotive(votive).initialize(intent_, clocks, quoted, address(registry), token);

        emit VotiveOpened(
            votive,
            msg.sender,
            intent_.capabilityId,
            address(token),
            TokenVotive(votive).principal()
        );
    }

    /// @dev The checks and quotes shared by every way of opening a votive.
    function _admit(
        Intent calldata intent_,
        Deadlines calldata deadlineOverrides,
        Terms calldata maxTerms
    ) private view returns (Terms memory quoted, Deadlines memory clocks) {
        if (!accessGate.isPermitted(msg.sender)) revert NotPermitted();
        if (msg.sender != intent_.founder) revert NotFounder();

        quoted = defaultTerms;
        if (
            quoted.streamBps > maxTerms.streamBps || quoted.performanceBps > maxTerms.performanceBps
        ) revert TermsRejected();

        clocks = _withDefaults(deadlineOverrides);
    }

    /// @dev Fill any zeroed clock from the platform defaults. Validation of the
    ///      result is the votive's job, so there is one place that decides what a
    ///      legal set of deadlines is.
    function _withDefaults(Deadlines calldata overrides)
        private
        view
        returns (Deadlines memory clocks)
    {
        Deadlines memory fallbacks = defaultDeadlines;
        clocks.guardianAfter =
            overrides.guardianAfter == 0 ? fallbacks.guardianAfter : overrides.guardianAfter;
        clocks.escheatAfter =
            overrides.escheatAfter == 0 ? fallbacks.escheatAfter : overrides.escheatAfter;
        clocks.attemptWindow =
            overrides.attemptWindow == 0 ? fallbacks.attemptWindow : overrides.attemptWindow;
    }

    /// @dev Book a freshly cloned votive: remember it, add it to the live set,
    ///      and bind it to its capability in the registry.
    function _record(address votive, bytes32 capabilityId) private {
        _all.push(votive);
        isVotive[votive] = true;
        _live.push(votive);
        _livePosition[votive] = _live.length;
        registry.registerVotive(votive, capabilityId);
    }

    // -------------------------------------------------------------- lifecycle

    /// @notice A votive reports that it has settled. Drops it from the live set.
    /// @dev Idempotent, and only ever callable by a votive this factory opened.
    ///      Swap-and-pop rather than a linear scan: the live set is walked by
    ///      off-chain readers and by multi-party settlement, so removal has to
    ///      stay constant-cost no matter how many votives exist.
    function onTerminal() external {
        if (!isVotive[msg.sender]) revert NotAVotive();

        uint256 position = _livePosition[msg.sender];
        if (position == 0) return;

        uint256 index = position - 1;
        uint256 lastIndex = _live.length - 1;
        if (index != lastIndex) {
            address moved = _live[lastIndex];
            _live[index] = moved;
            _livePosition[moved] = index + 1;
        }
        _live.pop();
        _livePosition[msg.sender] = 0;

        emit VotiveSettled(msg.sender, VotiveBase(payable(msg.sender)).state());
    }

    // ------------------------------------------------------------------ views

    /// @notice Every votive ever opened here, oldest first.
    function allVotives() external view returns (address[] memory) {
        return _all;
    }

    function allVotivesLength() external view returns (uint256) {
        return _all.length;
    }

    function votiveAt(uint256 index) external view returns (address) {
        return _all[index];
    }

    /// @notice Votives that have not settled yet, in no particular order.
    function liveVotives() external view returns (address[] memory) {
        return _live;
    }

    function liveVotivesLength() external view returns (uint256) {
        return _live.length;
    }

    /// @notice Whether a votive is currently in the live set.
    function isLive(address votive) external view returns (bool) {
        return _livePosition[votive] != 0;
    }

    /// @notice The recipients and weights of a `ShareWithActive` fulfilment: every
    ///         live votive funded in `asset_`, paired with what it currently has
    ///         parked. This is what the executor reads at a snapshot block to
    ///         build the Merkle allocation, and what anybody else reads at the
    ///         same block to check the executor's arithmetic.
    ///
    /// @dev Filtered by asset because weights only mean anything inside one
    ///      denomination: a shared ETH wish splits ETH among the ETH votives, a
    ///      shared USDC wish splits USDC among the USDC ones, and the two never
    ///      mix. Weighting by parked balance rather than by headcount is what
    ///      makes flooding the protocol with dust votives pointless.
    ///
    ///      A view over the whole live set, so it is meant for `eth_call` and for
    ///      off-chain snapshotting — never for use inside a transaction.
    /// @param asset_ `address(0)` for the native asset, otherwise the token.
    /// @param exclude A votive to leave out — normally the one doing the sharing,
    ///        since a wish for everyone still waiting is not a wish for itself.
    ///        Pass `address(0)` to include everything.
    function liveShares(address asset_, address exclude)
        external
        view
        returns (address[] memory recipients, uint256[] memory weights, uint256 totalWeight)
    {
        uint256 length = _live.length;

        uint256 matching;
        for (uint256 i = 0; i < length; i++) {
            address candidate = _live[i];
            if (candidate == exclude) continue;
            if (VotiveBase(payable(candidate)).asset() == asset_) matching++;
        }

        recipients = new address[](matching);
        weights = new uint256[](matching);

        uint256 next;
        for (uint256 i = 0; i < length; i++) {
            address candidate = _live[i];
            if (candidate == exclude) continue;
            VotiveBase votive = VotiveBase(payable(candidate));
            if (votive.asset() != asset_) continue;
            uint256 weight = votive.parked();
            recipients[next] = votive.beneficiary();
            weights[next] = weight;
            totalWeight += weight;
            next++;
        }
    }

    // ------------------------------------------------------------------ admin

    /// @notice Move the fee destination. Only where fees go — never how much they
    ///         are, which is frozen into each votive at the moment it opens.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryChanged(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setExecutor(address newExecutor) external onlyOwner {
        if (newExecutor == address(0)) revert ZeroAddress();
        emit ExecutorChanged(executor, newExecutor);
        executor = newExecutor;
    }

    /// @notice Add or remove an ERC-20 from the set a votive may be funded in.
    /// @dev De-listing only closes the door to new votives. Existing ones hold
    ///      their token immutably and are untouched, which is the point: an
    ///      admin decision about what to accept tomorrow must never become a
    ///      decision about somebody's money today.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function setAccessGate(IAccessGate newGate) external onlyOwner {
        if (address(newGate) == address(0)) revert ZeroAddress();
        emit AccessGateChanged(address(accessGate), address(newGate));
        accessGate = newGate;
    }

    /// @notice Reprice future votives. Existing ones are unaffected — they hold
    ///         their own terms and there is no code path that rewrites them.
    function setDefaultTerms(Terms calldata newTerms) external onlyOwner {
        if (
            newTerms.streamBps > VotiveLimits.MAX_STREAM_BPS
                || newTerms.performanceBps > VotiveLimits.MAX_PERFORMANCE_BPS
        ) revert BadTerms();
        defaultTerms = newTerms;
        emit DefaultTermsChanged(newTerms);
    }

    /// @notice Change the clocks future votives get by default. Validated against
    ///         the same floors the votive enforces, so a default can never be set
    ///         to something that would make every unopinionated opening revert.
    function setDefaultDeadlines(Deadlines calldata newDeadlines) external onlyOwner {
        if (
            newDeadlines.guardianAfter < VotiveLimits.MIN_GUARDIAN_WINDOW
                || newDeadlines.escheatAfter < VotiveLimits.MIN_ESCHEAT_WINDOW
                || newDeadlines.escheatAfter <= newDeadlines.guardianAfter
                || newDeadlines.attemptWindow < VotiveLimits.MIN_ATTEMPT_WINDOW
        ) revert BadDeadlines();
        defaultDeadlines = newDeadlines;
        emit DefaultDeadlinesChanged(newDeadlines);
    }
}
