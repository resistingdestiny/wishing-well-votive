// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAttestationRegistry} from "./interfaces/IAttestationRegistry.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title AttestationRegistry
/// @notice The protocol's record of what has been demonstrated and what has come
///         true. It answers exactly two questions for a votive:
///
///         1. **Can this be done yet?** — has any model passed the capability
///            check the votive named? (`isCapabilityOpen`)
///         2. **Has this been done?** — is the votive's release condition met?
///            (`isConditionMet`)
///
///         Both are attested by a single `attestor` key behind a swappable
///         address. Decentralising that key is future work; isolating it in one
///         small contract, with no custody of funds and no authority over any
///         votive's payout destination, is what makes that future work possible.
///
/// @dev Two deliberate properties, both of which cost storage and are worth it:
///
///      **Per-model results, not one global flag.** A capability is stored as a
///      set of (model, verdict) records plus a count of models whose *latest*
///      verdict is a pass. The gate is `count > 0`. Storing a single boolean
///      would mean a newly released, weaker model failing an eval could slam
///      shut a gate a stronger model had already opened — the votives behind it
///      would go from executable to stuck for no reason connected to their wish.
///
///      **Failures are written down.** A failing attestation is not a no-op; it
///      is the observation that this model, on this date, could not do it. That
///      series is the point of the project as much as the successes are, so it
///      is emitted and stored rather than discarded.
contract AttestationRegistry is IAttestationRegistry, Ownable2Step {
    // ------------------------------------------------------------------ types

    /// @notice One attestation. `evidence` is a content hash of the off-chain run
    ///         log that justifies the verdict — the chain stores the commitment,
    ///         not the transcript.
    struct Record {
        bool exists;
        bool verdict;
        uint64 at;
        bytes32 evidence;
    }

    // ---------------------------------------------------------------- storage

    /// @notice The key permitted to post attestations.
    address public attestor;

    /// @notice The factory permitted to bind a votive to its capability.
    address public factory;

    /// @dev Latest verdict per (capability, model).
    mapping(bytes32 capabilityId => mapping(bytes32 modelId => Record)) private _capability;

    /// @dev Latest attestation on a votive's release condition. Keyed by votive
    ///      as well as condition hash: the same condition text asked of two
    ///      different votives is two independent questions.
    mapping(address votive => mapping(bytes32 conditionHash => Record)) private _condition;

    /// @notice Number of distinct models whose latest verdict for a capability is
    ///         a pass. The capability gate is open while this is non-zero.
    mapping(bytes32 capabilityId => uint256 count) public demonstratedBy;

    /// @notice The model that first opened a capability's gate. Sticky: whoever
    ///         proves it first keeps the credit, even if the record is later
    ///         retracted or a dozen other models follow.
    mapping(bytes32 capabilityId => bytes32 modelId) public pioneer;

    /// @notice The capability a votive requires before it may be attempted.
    ///         Written once, by the factory, at creation.
    mapping(address votive => bytes32 capabilityId) public requiredCapability;

    // ----------------------------------------------------------------- events

    event AttestorChanged(address indexed previous, address indexed current);
    event FactoryChanged(address indexed previous, address indexed current);
    event VotiveRegistered(address indexed votive, bytes32 indexed capabilityId);
    event CapabilityAttested(
        bytes32 indexed capabilityId, bytes32 indexed modelId, bool verdict, bytes32 evidence
    );
    event CapabilityOpened(bytes32 indexed capabilityId, bytes32 indexed modelId);
    event CapabilityClosed(bytes32 indexed capabilityId);
    event ConditionAttested(
        address indexed votive, bytes32 indexed conditionHash, bool verdict, bytes32 evidence
    );

    // ----------------------------------------------------------------- errors

    error NotAttestor();
    error NotFactory();
    error ZeroAddress();
    error ZeroIdentifier();
    error AlreadyRegistered();

    // -------------------------------------------------------------- modifiers

    modifier onlyAttestor() {
        if (msg.sender != attestor) revert NotAttestor();
        _;
    }

    // ------------------------------------------------------------ constructor

    /// @param initialOwner Administrator: may rotate the attestor and the factory.
    /// @param initialAttestor The key that posts attestations from the start.
    constructor(address initialOwner, address initialAttestor) Ownable(initialOwner) {
        if (initialAttestor == address(0)) revert ZeroAddress();
        attestor = initialAttestor;
        emit AttestorChanged(address(0), initialAttestor);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Rotate the attesting key. The attestor can never move funds; the
    ///         worst a compromised key does is open a gate early or refuse to
    ///         confirm a condition, both of which are visible on chain.
    function setAttestor(address newAttestor) external onlyOwner {
        if (newAttestor == address(0)) revert ZeroAddress();
        emit AttestorChanged(attestor, newAttestor);
        attestor = newAttestor;
    }

    /// @notice Point the registry at the factory allowed to register votives.
    /// @dev Set after deployment because the factory needs this registry's address
    ///      in its own constructor — the two reference each other. Remains
    ///      owner-replaceable so a factory can be superseded without redeploying
    ///      the attestation history, which is the asset worth keeping.
    function setFactory(address newFactory) external onlyOwner {
        if (newFactory == address(0)) revert ZeroAddress();
        emit FactoryChanged(factory, newFactory);
        factory = newFactory;
    }

    // --------------------------------------------------------- registration

    /// @notice Bind a votive to the capability it requires. Factory-only, once.
    /// @dev Immutable after the fact by design: the capability gate is part of
    ///      what the founder agreed to, so nothing — not the owner, not the
    ///      factory — may re-point an existing votive at an easier check.
    function registerVotive(address votive, bytes32 capabilityId) external {
        if (msg.sender != factory) revert NotFactory();
        if (votive == address(0)) revert ZeroAddress();
        if (capabilityId == bytes32(0)) revert ZeroIdentifier();
        if (requiredCapability[votive] != bytes32(0)) revert AlreadyRegistered();
        requiredCapability[votive] = capabilityId;
        emit VotiveRegistered(votive, capabilityId);
    }

    // ----------------------------------------------------------- attestations

    /// @notice Record the outcome of running a capability check against one model.
    /// @param capabilityId Identifier of the check.
    /// @param modelId Identifier of the model the check was run against.
    /// @param verdict True if the model passed.
    /// @param evidence Content hash of the run log behind the verdict.
    function attestCapability(bytes32 capabilityId, bytes32 modelId, bool verdict, bytes32 evidence)
        external
        onlyAttestor
    {
        if (capabilityId == bytes32(0) || modelId == bytes32(0)) revert ZeroIdentifier();

        Record storage previous = _capability[capabilityId][modelId];
        bool wasPassing = previous.exists && previous.verdict;

        if (verdict && !wasPassing) {
            uint256 count = demonstratedBy[capabilityId] + 1;
            demonstratedBy[capabilityId] = count;
            if (pioneer[capabilityId] == bytes32(0)) {
                pioneer[capabilityId] = modelId;
            }
            if (count == 1) emit CapabilityOpened(capabilityId, modelId);
        } else if (!verdict && wasPassing) {
            uint256 count = demonstratedBy[capabilityId] - 1;
            demonstratedBy[capabilityId] = count;
            if (count == 0) emit CapabilityClosed(capabilityId);
        }

        previous.exists = true;
        previous.verdict = verdict;
        previous.at = uint64(block.timestamp);
        previous.evidence = evidence;

        emit CapabilityAttested(capabilityId, modelId, verdict, evidence);
    }

    /// @notice Record whether a specific votive's release condition is met.
    /// @dev Latest-wins, including true → false, so a mistaken confirmation can be
    ///      retracted right up until the moment a votive settles on it.
    function attestCondition(address votive, bytes32 conditionHash, bool verdict, bytes32 evidence)
        external
        onlyAttestor
    {
        if (votive == address(0)) revert ZeroAddress();
        if (conditionHash == bytes32(0)) revert ZeroIdentifier();

        _condition[votive][conditionHash] = Record({
            exists: true, verdict: verdict, at: uint64(block.timestamp), evidence: evidence
        });

        emit ConditionAttested(votive, conditionHash, verdict, evidence);
    }

    // ------------------------------------------------------------------ views

    /// @notice True while at least one model's latest verdict for the capability
    ///         is a pass.
    function isCapabilityOpen(bytes32 capabilityId) external view returns (bool) {
        return demonstratedBy[capabilityId] > 0;
    }

    /// @notice True if the votive's release condition currently stands attested.
    ///         Absent an attestation this is false — the protocol never treats
    ///         silence as confirmation.
    function isConditionMet(address votive, bytes32 conditionHash) external view returns (bool) {
        Record storage record = _condition[votive][conditionHash];
        return record.exists && record.verdict;
    }

    /// @notice The full latest record for a (capability, model) pair.
    function capabilityRecord(bytes32 capabilityId, bytes32 modelId)
        external
        view
        returns (Record memory)
    {
        return _capability[capabilityId][modelId];
    }

    /// @notice The full latest record for a votive's release condition.
    function conditionRecord(address votive, bytes32 conditionHash)
        external
        view
        returns (Record memory)
    {
        return _condition[votive][conditionHash];
    }
}
