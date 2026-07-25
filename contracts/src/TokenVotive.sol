// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VotiveBase} from "./VotiveBase.sol";
import {Deadlines, Intent, Terms} from "./VotiveTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title TokenVotive
/// @notice A votive funded in a single ERC-20.
///
/// @dev Same four hooks as the native votive, and the same complete absence of
///      protocol logic: lifecycle, fees, remedies and settlement all come from
///      {VotiveBase}. What is specific to tokens is specific to tokens.
///
///      **The funding token is captured at creation and never re-read from the
///      factory.** De-listing a token therefore blocks new votives without
///      touching a single existing one. A votive whose funding asset could be
///      revoked underneath it would not really be segregated.
///
///      **Principal is the measured balance, not the amount somebody claimed to
///      send.** A token that takes a cut on transfer credits what actually
///      arrived. The real defence against badly-behaved tokens is the factory's
///      allowlist; this is the belt to that pair of braces.
///
///      **Pushing tokens must not be able to revert.** `SafeERC20.safeTransfer`
///      reverts on failure, which would let a recipient on a token's blocklist
///      wedge a settlement permanently. So the optimistic push is hand-rolled:
///      anything short of an unambiguous success falls through to the deferred
///      ledger, where it can be pulled at full gas later.
contract TokenVotive is VotiveBase {
    using SafeERC20 for IERC20;

    /// @dev Gas ceiling on an optimistic push. Higher than the native votive's
    ///      because a real token transfer is a proxy hop plus two storage writes
    ///      plus, often, a blocklist check — but still bounded, so a hostile
    ///      token cannot price a settlement out of the block.
    uint256 private constant PUSH_GAS = 120_000;

    /// @notice The single token this votive is funded in.
    IERC20 public token;

    /// @dev Recovering the funding token would break the accounting the whole
    ///      contract rests on. The lifecycle paths are how funds leave.
    error TokenIsTheFundingAsset();

    event Recovered(address indexed asset, address indexed to, uint256 amount);

    /// @notice Open this votive. The factory moves the founder's tokens in first
    ///         and this adopts whatever actually arrived as the principal.
    function initialize(
        Intent memory intent_,
        Deadlines memory deadlines_,
        Terms memory terms_,
        address registry_,
        IERC20 token_
    ) external initializer {
        if (address(token_) == address(0)) revert BadIntent();
        token = token_;
        _open(intent_, deadlines_, terms_, registry_, token_.balanceOf(address(this)));
    }

    /// @notice The founder adds to their principal. Pulls from the caller, so the
    ///         founder must approve this votive first, and credits the measured
    ///         delta rather than the requested amount.
    function topUp(uint256 amount) external nonReentrant onlyLive onlyFounder {
        if (amount == 0) revert ZeroFunding();
        uint256 before = _held();
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 delta = _held() - before;
        if (delta == 0) revert ZeroFunding();
        _applyTopUp(delta);
    }

    /// @notice Back somebody else's wish. Value arriving this way is an offering,
    ///         not principal, and is what the performance fee is charged on.
    /// @dev A plain `transfer` straight to this address works identically as far
    ///      as the accounting is concerned — it simply raises the balance. This
    ///      entry point exists so that backing a wish is a legible on-chain event
    ///      rather than an anonymous transfer, and so the founder topping up by
    ///      mistake still registers as a sign of life.
    function offer(uint256 amount) external nonReentrant onlyLive {
        if (amount == 0) revert ZeroFunding();
        uint256 before = _held();
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 delta = _held() - before;
        if (msg.sender == _intent.founder) {
            lastFounderSignal = uint64(block.timestamp);
        }
        emit Offered(msg.sender, delta);
    }

    // ---------------------------------------------------------------- rescue

    /// @notice Return a token that is not this votive's funding asset to the
    ///         founder. Foreign assets are never part of the accounting, so this
    ///         cannot touch principal, offerings or the deferred ledger.
    ///
    /// @dev "Is this the funding asset" cannot be answered by comparing addresses,
    ///      because a token can have more than one. Real tokens have shipped with a
    ///      proxy and an implementation both live over a single balance store, or
    ///      with a second façade contract; each is a different address reading and
    ///      moving the same balances. An address comparison waves that through, and
    ///      the result is a permissionless, fee-free withdrawal of the whole
    ///      principal out of a `Waiting` votive — `recoverToken` is callable by
    ///      anyone and pays the founder.
    ///
    ///      So the funding balance is measured on both sides of the transfer, and
    ///      any movement in it fails the call. That holds whatever the alias is
    ///      called and however many of them exist, which an allowlist of known-bad
    ///      addresses never could.
    function recoverToken(IERC20 other) external nonReentrant {
        if (other == token) revert TokenIsTheFundingAsset();

        uint256 fundingBefore = _held();
        uint256 balance = other.balanceOf(address(this));
        if (balance == 0) revert NothingToSweep();

        address to = _intent.founder;
        other.safeTransfer(to, balance);

        if (_held() != fundingBefore) revert TokenIsTheFundingAsset();
        emit Recovered(address(other), to, balance);
    }

    /// @notice Return native value force-sent to this token-only votive.
    function recoverNative() external nonReentrant {
        uint256 balance = address(this).balance;
        if (balance == 0) revert NothingToSweep();
        address to = _intent.founder;
        (bool ok,) = to.call{value: balance}("");
        if (!ok) revert TransferFailed();
        emit Recovered(address(0), to, balance);
    }

    // ------------------------------------------------------------ asset hooks

    /// @inheritdoc VotiveBase
    function asset() public view override returns (address) {
        return address(token);
    }

    /// @inheritdoc VotiveBase
    function _held() internal view override returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @inheritdoc VotiveBase
    /// @dev Only an unambiguous success counts as pushed. The return word is read
    ///      with assembly rather than `abi.decode`, because `abi.decode` itself
    ///      reverts on a dirty word — which would defeat the entire purpose of a
    ///      push that is not allowed to revert. No return data at all is treated
    ///      as success, for the tokens that predate the standard saying otherwise.
    function _pushValue(address to, uint256 amount) internal override returns (bool) {
        (bool ok, bytes memory returndata) =
            address(token).call{gas: PUSH_GAS}(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (returndata.length == 0) return address(token).code.length > 0;
        if (returndata.length < 32) return false;

        uint256 word;
        assembly ("memory-safe") {
            word := mload(add(returndata, 32))
        }
        return word == 1;
    }

    /// @inheritdoc VotiveBase
    function _moveValue(address to, uint256 amount) internal override {
        token.safeTransfer(to, amount);
    }
}
