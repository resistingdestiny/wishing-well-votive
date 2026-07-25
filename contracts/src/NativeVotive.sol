// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VotiveBase} from "./VotiveBase.sol";
import {Deadlines, Intent, Terms} from "./VotiveTypes.sol";

/// @title NativeVotive
/// @notice A votive funded in the chain's native asset.
///
/// @dev Everything that decides who gets paid lives in {VotiveBase}. This
///      contract answers four questions about the asset and nothing else: what
///      is it, how much is there, how do you push it without being able to
///      revert, and how do you move it when reverting is fine. Keeping the
///      surface this thin is deliberate — the ETH votive and the token votive
///      cannot drift apart in behaviour if neither of them contains any
///      behaviour.
contract NativeVotive is VotiveBase {
    /// @dev Gas ceiling on an optimistic push. Enough for an ordinary contract
    ///      recipient to book the receipt, not enough for one to burn the
    ///      settlement down. Anything that needs more falls through to the
    ///      deferred ledger and pulls at full gas.
    uint256 private constant PUSH_GAS = 50_000;

    /// @notice Open this votive. Callable once, by the factory that cloned it,
    ///         with the founder's deposit attached.
    function initialize(
        Intent memory intent_,
        Deadlines memory deadlines_,
        Terms memory terms_,
        address registry_
    ) external payable initializer {
        _open(intent_, deadlines_, terms_, registry_, msg.value);
    }

    /// @notice The founder adds to their principal — funding a long-lived wish a
    ///         bit at a time. Distinct from an offering: principal is never
    ///         touched by the performance fee, an offering is.
    function topUp() external payable nonReentrant onlyLive onlyFounder {
        if (msg.value == 0) revert ZeroFunding();
        _applyTopUp(msg.value);
    }

    /// @notice Anyone may add to a live votive. Value arriving this way is an
    ///         offering, not principal — it is somebody else backing the wish,
    ///         and it is what the performance fee is charged on at settlement.
    ///         When the founder is the one sending, that counts as a sign of
    ///         life like any other.
    receive() external payable onlyLive {
        if (msg.sender == _intent.founder) {
            lastFounderSignal = uint64(block.timestamp);
        }
        emit Offered(msg.sender, msg.value);
    }

    // ------------------------------------------------------------ asset hooks

    /// @inheritdoc VotiveBase
    function asset() public pure override returns (address) {
        return address(0);
    }

    /// @inheritdoc VotiveBase
    function _held() internal view override returns (uint256) {
        return address(this).balance;
    }

    /// @inheritdoc VotiveBase
    /// @dev Zero return-data size, so a recipient cannot answer a payout with a
    ///      multi-megabyte return value and price the settlement out of the block.
    function _pushValue(address to, uint256 amount) internal override returns (bool pushed) {
        assembly ("memory-safe") {
            pushed := call(PUSH_GAS, to, amount, 0, 0, 0, 0)
        }
    }

    /// @inheritdoc VotiveBase
    function _moveValue(address to, uint256 amount) internal override {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
