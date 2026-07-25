// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IHumanBacking} from "../interfaces/IHumanBacking.sol";
import {IStanding} from "../interfaces/IStanding.sol";
import {AssuranceTiers} from "./AssuranceTiers.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title ResourceRegistry
/// @notice The shared resources that are not money — an API key, a seat on a
///         compute cluster, a licensed corpus — registered here, requested here,
///         and released somewhere else entirely.
///
///         The split is the whole design. **The entitlement is public; the secret
///         is not.** What goes on chain is which resources exist, what each one
///         demands of whoever wants it, and an auditable record of every grant.
///         What never goes on chain is the credential itself — a key written to a
///         public ledger is a key given to everyone, and no amount of care
///         afterwards undoes that.
///
///         So an agent asks here and is told yes or no. The provider watches for
///         the grant, checks it against this contract, and hands over the
///         credential off chain. Anyone can later audit who was entitled to what
///         without anybody having learned a secret.
///
/// @dev Putting the quota on chain rather than in the provider's memory buys two
///      things worth more than the gas.
///
///      **One counter, however many servers.** A provider running three instances
///      behind a load balancer cannot meter a per-human quota in process memory
///      without a shared store and a locking story. This is that store, and it is
///      already the one everybody trusts for the bar.
///
///      **The provider cannot quietly be more generous than the rules.** With the
///      count off chain, a resource owner could hand out extra to whoever they
///      liked and nobody could tell. Here the entitlement is checked by the same
///      contract that holds the bar, and exceeding it is not something a provider
///      can decide to do.
contract ResourceRegistry is Ownable2Step {
    // ------------------------------------------------------------------ types

    struct Resource {
        /// @dev Who releases the credential once a grant exists.
        address provider;
        /// @dev Uses per epoch for an operator at parity standing. Scaled by
        ///      standing at request time, so this is a baseline and not a cap.
        uint32 baseLimit;
        /// @dev Weakest assurance tier allowed near this resource at all, whatever
        ///      the standing. Some seats are expensive enough that a device signal
        ///      should not reach them however good the track record.
        uint8 minAssurance;
        /// @dev A retired resource refuses new grants; the ones already issued
        ///      stay valid until they lapse, because an agent mid-job should not
        ///      lose a credential it was entitled to.
        bool active;
        /// @dev Commitment to the off-chain description and terms of use.
        bytes32 termsHash;
    }

    struct Grant {
        bytes32 resourceId;
        bytes32 humanId;
        address wallet;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    /// @notice Why a request would be refused. Returned by {quote} so a caller can
    ///         explain itself rather than surfacing a bare revert.
    enum Refusal {
        None,
        NoSuchResource,
        Retired,
        NotHumanBacked,
        Barred,
        BelowMinimumAssurance,
        QuotaExhausted
    }

    // ------------------------------------------------------------- parameters

    IHumanBacking public immutable backing;
    IStanding public immutable standing;

    /// @dev Immutable for the same reason the commons pool's is: a settable window
    ///      silently re-maps every historical usage bucket the moment it changes.
    uint64 public immutable epochLength;

    /// @notice How long a grant stays good for. Long enough for an agent to fetch
    ///         its credential, short enough that a provider is not obliged to
    ///         honour something issued to an operator barred since.
    uint64 public constant GRANT_LIFETIME = 1 hours;

    /// @notice Ceiling on the scaled limit, so standing alone never buys an
    ///         effectively unbounded share of somebody else's API.
    uint32 public constant MAX_LIMIT = 10_000;

    // ----------------------------------------------------------------- state

    mapping(bytes32 resourceId => Resource) private _resources;
    /// @dev Uses taken, per resource, per human, per epoch.
    mapping(bytes32 resourceId => mapping(bytes32 humanId => mapping(uint256 epoch => uint32)))
        private _used;

    mapping(bytes32 grantId => Grant) private _grants;
    uint256 public grantCount;

    // ---------------------------------------------------------------- events

    event ResourceRegistered(
        bytes32 indexed resourceId,
        address indexed provider,
        uint32 baseLimit,
        uint8 minAssurance,
        bytes32 termsHash
    );
    event ResourceUpdated(bytes32 indexed resourceId, uint32 baseLimit, uint8 minAssurance);
    event ResourceRetired(bytes32 indexed resourceId);

    /// @notice The signal a provider watches for. Carries no credential — the
    ///         provider mints that itself, off chain, after checking the grant.
    event AccessGranted(
        bytes32 indexed grantId,
        bytes32 indexed resourceId,
        bytes32 indexed humanId,
        address wallet,
        uint32 usedAfter,
        uint32 effectiveLimit,
        uint64 expiresAt
    );

    // ---------------------------------------------------------------- errors

    error Refused(Refusal reason);
    error NotTheProvider();
    error ZeroAddress();
    error ZeroResourceId();
    error AlreadyRegistered();
    error UnknownTier(uint8 tier);

    // ----------------------------------------------------------- construction

    constructor(
        address initialOwner,
        IHumanBacking backing_,
        IStanding standing_,
        uint64 epochLength_
    ) Ownable(initialOwner) {
        if (address(backing_) == address(0) || address(standing_) == address(0)) {
            revert ZeroAddress();
        }
        if (epochLength_ == 0) revert Refused(Refusal.NoSuchResource);
        backing = backing_;
        standing = standing_;
        epochLength = epochLength_;
    }

    // ------------------------------------------------------------ registering

    /// @notice Register a resource. The owner admits it and names who provides it.
    function register(
        bytes32 resourceId,
        address provider,
        uint32 baseLimit,
        uint8 minAssurance,
        bytes32 termsHash
    ) external onlyOwner {
        if (resourceId == bytes32(0)) revert ZeroResourceId();
        if (provider == address(0)) revert ZeroAddress();
        if (_resources[resourceId].provider != address(0)) revert AlreadyRegistered();
        if (!AssuranceTiers.isKnown(minAssurance)) revert UnknownTier(minAssurance);

        _resources[resourceId] = Resource({
            provider: provider,
            baseLimit: baseLimit,
            minAssurance: minAssurance,
            active: true,
            termsHash: termsHash
        });
        emit ResourceRegistered(resourceId, provider, baseLimit, minAssurance, termsHash);
    }

    /// @notice The provider adjusts what its own resource costs and demands.
    /// @dev The provider rather than the owner, because the provider is the one
    ///      paying for the seat and is the only party that knows what it can bear.
    function update(bytes32 resourceId, uint32 baseLimit, uint8 minAssurance) external {
        Resource storage resource = _resources[resourceId];
        if (resource.provider == address(0)) revert Refused(Refusal.NoSuchResource);
        if (msg.sender != resource.provider) revert NotTheProvider();
        if (!AssuranceTiers.isKnown(minAssurance)) revert UnknownTier(minAssurance);

        resource.baseLimit = baseLimit;
        resource.minAssurance = minAssurance;
        emit ResourceUpdated(resourceId, baseLimit, minAssurance);
    }

    /// @notice Stop issuing new grants for a resource.
    /// @dev Grants already issued stay valid until they lapse. An agent halfway
    ///      through a job should not lose a credential it was entitled to because
    ///      the provider retired the resource a block later.
    function retire(bytes32 resourceId) external {
        Resource storage resource = _resources[resourceId];
        if (resource.provider == address(0)) revert Refused(Refusal.NoSuchResource);
        if (msg.sender != resource.provider && msg.sender != owner()) revert NotTheProvider();

        resource.active = false;
        emit ResourceRetired(resourceId);
    }

    // -------------------------------------------------------------- requesting

    /// @notice Ask for access. Reverts if the operator is not entitled; otherwise
    ///         records the grant and emits the signal the provider watches for.
    ///
    /// @dev Returns a grant id rather than anything secret. The credential is the
    ///      provider's to release, off chain, and this contract never sees it.
    function requestAccess(bytes32 resourceId) external returns (bytes32 grantId) {
        (bool allowed, Refusal reason, uint32 effectiveLimit,) = quote(msg.sender, resourceId);
        if (!allowed) revert Refused(reason);

        bytes32 humanId = backing.humanOf(msg.sender);
        uint256 epoch = currentEpoch();
        uint32 usedAfter = _used[resourceId][humanId][epoch] + 1;
        _used[resourceId][humanId][epoch] = usedAfter;

        unchecked {
            grantCount++;
        }
        // Bound to the caller, the resource and the count, so a grant id cannot be
        // guessed from the resource alone or collide with another operator's.
        grantId = keccak256(abi.encode(resourceId, humanId, msg.sender, grantCount, block.chainid));

        uint64 expiresAt = uint64(block.timestamp) + GRANT_LIFETIME;
        _grants[grantId] = Grant({
            resourceId: resourceId,
            humanId: humanId,
            wallet: msg.sender,
            issuedAt: uint64(block.timestamp),
            expiresAt: expiresAt
        });

        emit AccessGranted(
            grantId, resourceId, humanId, msg.sender, usedAfter, effectiveLimit, expiresAt
        );
    }

    // ----------------------------------------------------------------- views

    function currentEpoch() public view returns (uint256) {
        return block.timestamp / epochLength;
    }

    function resourceOf(bytes32 resourceId) external view returns (Resource memory) {
        return _resources[resourceId];
    }

    function grantOf(bytes32 grantId) external view returns (Grant memory) {
        return _grants[grantId];
    }

    /// @notice What a provider checks before releasing a credential.
    /// @dev Re-checks the bar rather than trusting the grant, so an operator
    ///      barred in the minutes between asking and collecting gets nothing. The
    ///      grant is evidence of entitlement at issue time; this is entitlement
    ///      now, and now is what matters when the key changes hands.
    function isGrantReleasable(bytes32 grantId)
        external
        view
        returns (bool releasable, Refusal reason)
    {
        Grant memory grant = _grants[grantId];
        if (grant.wallet == address(0)) return (false, Refusal.NoSuchResource);
        if (block.timestamp > grant.expiresAt) return (false, Refusal.QuotaExhausted);
        if (standing.isBarred(grant.humanId)) return (false, Refusal.Barred);
        // The wallet must still resolve to the human the grant was issued to, so a
        // revoked or rebound wallet cannot collect on somebody else's entitlement.
        if (backing.humanOf(grant.wallet) != grant.humanId) return (false, Refusal.NotHumanBacked);
        return (true, Refusal.None);
    }

    /// @notice What this operator's standing earns them on this resource.
    function effectiveLimitOf(address wallet, bytes32 resourceId) public view returns (uint32) {
        Resource memory resource = _resources[resourceId];
        if (resource.provider == address(0)) return 0;

        bytes32 humanId = backing.humanOf(wallet);
        if (humanId == bytes32(0)) return 0;

        uint256 scaled =
            (uint256(resource.baseLimit) * standing.multiplierBpsOf(humanId)) / AssuranceTiers.BPS;
        // The clamp already bounds this well inside uint32; SafeCast makes that a
        // guarantee the runtime enforces rather than one a reader has to verify.
        return scaled > MAX_LIMIT ? MAX_LIMIT : SafeCast.toUint32(scaled);
    }

    function usedBy(bytes32 resourceId, bytes32 humanId, uint256 epoch)
        external
        view
        returns (uint32)
    {
        return _used[resourceId][humanId][epoch];
    }

    /// @notice Would a request succeed, and if not why?
    /// @dev `requestAccess` runs exactly this, so the two cannot disagree.
    function quote(address wallet, bytes32 resourceId)
        public
        view
        returns (bool allowed, Refusal reason, uint32 effectiveLimit, uint32 remaining)
    {
        Resource memory resource = _resources[resourceId];
        if (resource.provider == address(0)) return (false, Refusal.NoSuchResource, 0, 0);
        if (!resource.active) return (false, Refusal.Retired, 0, 0);

        bytes32 humanId = backing.humanOf(wallet);
        if (humanId == bytes32(0)) return (false, Refusal.NotHumanBacked, 0, 0);
        if (standing.isBarred(humanId)) return (false, Refusal.Barred, 0, 0);
        if (backing.assuranceOf(wallet) < resource.minAssurance) {
            return (false, Refusal.BelowMinimumAssurance, 0, 0);
        }

        effectiveLimit = effectiveLimitOf(wallet, resourceId);
        uint32 used = _used[resourceId][humanId][currentEpoch()];
        remaining = used >= effectiveLimit ? 0 : effectiveLimit - used;

        if (remaining == 0) return (false, Refusal.QuotaExhausted, effectiveLimit, 0);
        return (true, Refusal.None, effectiveLimit, remaining);
    }
}
