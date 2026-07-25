// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IHumanBacking} from "../interfaces/IHumanBacking.sol";
import {IStanding} from "../interfaces/IStanding.sol";
import {AssuranceTiers} from "../world/AssuranceTiers.sol";
import {IAccessGate} from "./IAccessGate.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title HumanBackedAccessGate
/// @notice Admission policy: a votive may be opened only by an address a verified
///         human stands behind, and only while that human is in good standing.
///
///         This is the front door for the protection the rest of the integration
///         provides. Barring an operator for asking somebody to be hurt is worth
///         little if they can open a fresh wish from a fresh address the next
///         block — so the same identifier that carries the bar also decides who
///         may create anything at all.
///
/// @dev Implements the protocol's existing admission interface exactly, so it drops
///      into the factory with no change to a line of protocol code. That interface
///      is consulted once, at creation, and never re-consulted — which is a
///      deliberate property worth restating here: a votive that already exists is
///      never frozen by a later bar. Money already committed to a wish belongs to
///      that wish. Barring stops somebody opening new ones and drawing from the
///      commons; it is not a lever over funds already pledged, and conflating the
///      two would make an admission policy into a confiscation power.
contract HumanBackedAccessGate is IAccessGate, Ownable2Step {
    IHumanBacking public immutable backing;
    IStanding public immutable standing;

    /// @notice Weakest evidence tier admitted. Settable because the right answer
    ///         depends on what a deployment is willing to underwrite.
    uint8 public minAssurance;

    event MinAssuranceChanged(uint8 previous, uint8 current);

    error ZeroAddress();
    error UnknownTier(uint8 tier);

    constructor(
        address initialOwner,
        IHumanBacking backing_,
        IStanding standing_,
        uint8 minAssurance_
    ) Ownable(initialOwner) {
        if (address(backing_) == address(0) || address(standing_) == address(0)) {
            revert ZeroAddress();
        }
        if (!AssuranceTiers.isKnown(minAssurance_)) revert UnknownTier(minAssurance_);
        backing = backing_;
        standing = standing_;
        minAssurance = minAssurance_;
        emit MinAssuranceChanged(0, minAssurance_);
    }

    function setMinAssurance(uint8 newTier) external onlyOwner {
        if (!AssuranceTiers.isKnown(newTier)) revert UnknownTier(newTier);
        emit MinAssuranceChanged(minAssurance, newTier);
        minAssurance = newTier;
    }

    /// @inheritdoc IAccessGate
    function isPermitted(address account) external view returns (bool permitted) {
        bytes32 humanId = backing.humanOf(account);
        if (humanId == bytes32(0)) return false;
        if (backing.assuranceOf(account) < minAssurance) return false;
        return !standing.isBarred(humanId);
    }
}
