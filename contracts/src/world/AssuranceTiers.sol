// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title AssuranceTiers
/// @notice How strongly a humanity claim is evidenced, and what that is worth in
///         spending authority.
///
/// @dev The tiers are ordered and comparable, so a gate can say "at least this
///      strong" with a single `>=` rather than enumerating cases. The weights are
///      integer basis points against a base allowance, because the alternative —
///      a fractional multiplier — would need floating point the EVM does not have
///      and rounding rules nobody would agree on.
///
///      The gap between tiers is intentionally wide. A device signal is cheap to
///      obtain at scale, so it earns a fraction of the base allowance rather than
///      all of it; only the strongest evidence earns a multiple. That shape is the
///      whole economic argument: draining the commons requires proving humanity
///      once per unit of draw, and the strongest proof is the one that cannot be
///      farmed.
library AssuranceTiers {
    /// @notice No live humanity evidence. Draws nothing from the commons.
    uint8 internal constant NONE = 0;
    /// @notice Bound to a device. Cheap to obtain, so weighted lightly.
    uint8 internal constant DEVICE = 1;
    /// @notice A liveness check confirming a real, present person.
    uint8 internal constant SELFIE = 2;
    /// @notice The strongest evidence available. Required for the largest draws.
    uint8 internal constant ORB = 3;

    /// @notice Basis-point weight applied to the base allowance, per tier.
    uint256 internal constant WEIGHT_NONE = 0;
    uint256 internal constant WEIGHT_DEVICE = 2_500; // 0.25x
    uint256 internal constant WEIGHT_SELFIE = 10_000; // 1x
    uint256 internal constant WEIGHT_ORB = 20_000; // 2x

    uint256 internal constant BPS = 10_000;

    /// @notice Anything above the step-up threshold demands this tier, regardless
    ///         of how much standing the human has built up. Standing raises a
    ///         ceiling; it never substitutes for evidence.
    uint8 internal constant STEP_UP_TIER = ORB;

    error UnknownAssuranceTier(uint8 tier);

    /// @notice The basis-point weight for `tier`.
    /// @dev Reverts on an unrecognised tier rather than treating it as zero. A
    ///      registry that started attesting a tier this library has never heard of
    ///      is a deployment mistake, and silently granting it no allowance would
    ///      hide that until somebody asked why their agent could not draw.
    function weight(uint8 tier) internal pure returns (uint256) {
        if (tier == NONE) return WEIGHT_NONE;
        if (tier == DEVICE) return WEIGHT_DEVICE;
        if (tier == SELFIE) return WEIGHT_SELFIE;
        if (tier == ORB) return WEIGHT_ORB;
        revert UnknownAssuranceTier(tier);
    }

    /// @notice Whether `tier` is a tier this library knows how to price.
    function isKnown(uint8 tier) internal pure returns (bool) {
        return tier <= ORB;
    }

    /// @notice Whether `tier` clears the evidence bar for a draw of `amount`.
    /// @param stepUpAmount The value above which the strongest tier is required.
    ///        Zero disables the step-up entirely, leaving only the tier weight.
    function meetsStepUp(uint8 tier, uint256 amount, uint256 stepUpAmount)
        internal
        pure
        returns (bool)
    {
        if (tier == NONE) return false;
        if (stepUpAmount == 0 || amount <= stepUpAmount) return true;
        return tier >= STEP_UP_TIER;
    }
}
