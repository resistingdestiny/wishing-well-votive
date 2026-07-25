// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NativeVotive} from "./NativeVotive.sol";
import {VotiveBase} from "./VotiveBase.sol";
import {VotiveLimits} from "./VotiveLimits.sol";
import {Deadlines, Intent, Terms, VotiveState} from "./VotiveTypes.sol";
import {IAccessGate} from "./gates/IAccessGate.sol";
import {IAttestationRegistry} from "./interfaces/IAttestationRegistry.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

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
    // ---------------------------------------------------------------- storage

    /// @notice The attestation registry every votive opened here will read.
    IAttestationRegistry public immutable registry;

    /// @notice The implementation votives are cloned from.
    address public immutable nativeImplementation;

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

    // ----------------------------------------------------------------- errors

    error ZeroAddress();
    error ZeroFunding();
    error NotPermitted();
    error NotFounder();
    error NotAVotive();
    error TermsRejected();
    error BadTerms();
    error BadDeadlines();

    // ------------------------------------------------------------ constructor

    constructor(
        address initialOwner,
        IAttestationRegistry registry_,
        address nativeImplementation_,
        address treasury_,
        address executor_,
        IAccessGate accessGate_
    ) Ownable(initialOwner) {
        if (
            address(registry_) == address(0) || nativeImplementation_ == address(0)
                || treasury_ == address(0) || executor_ == address(0)
                || address(accessGate_) == address(0)
        ) revert ZeroAddress();

        registry = registry_;
        nativeImplementation = nativeImplementation_;
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
        if (!accessGate.isPermitted(msg.sender)) revert NotPermitted();
        if (msg.sender != intent_.founder) revert NotFounder();
        if (msg.value == 0) revert ZeroFunding();

        Terms memory quoted = defaultTerms;
        if (
            quoted.streamBps > maxTerms.streamBps || quoted.performanceBps > maxTerms.performanceBps
        ) revert TermsRejected();

        Deadlines memory clocks = _withDefaults(deadlineOverrides);

        votive = Clones.clone(nativeImplementation);
        _record(votive, intent_.capabilityId);
        NativeVotive(payable(votive)).initialize{value: msg.value}(
            intent_, clocks, quoted, address(registry)
        );

        emit VotiveOpened(votive, msg.sender, intent_.capabilityId, address(0), msg.value);
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
