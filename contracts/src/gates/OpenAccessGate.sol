// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessGate} from "./IAccessGate.sol";

/// @title OpenAccessGate
/// @notice The default gate: anyone may open a votive.
/// @dev Stateless and immutable — there is no owner, so there is no key that can
///      quietly turn admission off. Deploying a restrictive gate and pointing the
///      factory at it is a visible, on-chain governance action, which is the
///      point.
contract OpenAccessGate is IAccessGate {
    /// @inheritdoc IAccessGate
    function isPermitted(address) external pure returns (bool) {
        return true;
    }
}
