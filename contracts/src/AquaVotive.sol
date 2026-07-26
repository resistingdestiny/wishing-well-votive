// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TokenVotive} from "./TokenVotive.sol";
import {VotiveState} from "./VotiveTypes.sol";
import {IAqua} from "./interfaces/IAqua.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title AquaVotive
/// @notice A wish that is also a position: one vault per wish, holding its own
///         principal, quoted through 1inch Aqua.
///
///         A votive already is a vault — its own contract, its own money, nothing
///         commingled. What this adds is the ability for that vault to *quote
///         itself*: to say, on the open market, "here is what I hold, here is what
///         has to be true before anybody may touch it, and here is what an agent
///         who fulfils me would be paid."
///
///         Nothing moves when a position is opened. Aqua is an accounting layer
///         over an allowance, not a custodian — the principal never leaves this
///         contract until a fill actually happens, and a fill can only happen
///         through a program this votive chose.
///
/// @dev **The allowance is the whole risk, and the program is the whole defence.**
///      Shipping grants Aqua an allowance over this votive's principal. Aqua will
///      only spend it when the router calls `pull`, and the router only reaches
///      `pull` after running the strategy's program — which is where the gates
///      live: the wish must be live, the capability open, the condition attested,
///      and (optionally) the taker human-backed and in good standing.
///
///      That is why `shipToAqua` is `onlyFounder` and why the allowance is
///      bounded by what was shipped rather than infinite. A founder is choosing to
///      make their wish quotable and is choosing the terms; nobody else can choose
///      it for them, and nothing can be spent beyond what they offered.
///
///      **Docking is always available.** A founder who changes their mind closes
///      the strategy and drops the allowance to zero, in one call, without waiting
///      for anybody. A position you cannot exit is not a position, it is a trap.
contract AquaVotive is TokenVotive {
    using SafeERC20 for IERC20;

    /// @notice The Aqua deployment this votive quotes through.
    IAqua public aqua;
    /// @notice The SwapVM router permitted to spend against the strategy.
    address public router;
    /// @notice The strategy this votive has shipped, or zero.
    bytes32 public strategyHash;
    /// @notice The token a filler pays in. The principal's token is what they get.
    address public quoteToken;
    /// @notice How much of the principal was offered to the strategy.
    uint256 public offered;
    /// @notice The asking price, as the quote-side reserve the curve prices against.
    uint256 public askingReserve;

    event PositionOpened(
        bytes32 indexed strategyHash,
        address indexed router,
        address indexed quoteToken,
        uint256 offered
    );
    event PositionClosed(bytes32 indexed strategyHash);

    error AquaNotConfigured();
    error PositionAlreadyOpen();
    error NoPositionOpen();
    error OffersMoreThanParked(uint256 offered, uint256 parked);
    error QuoteTokenIsFundingToken();
    error AskingPriceRequired();

    /// @notice Point this votive at an Aqua deployment. Callable once, by the
    ///         founder, before any position is opened.
    /// @dev Not an initializer argument because a votive should be openable on a
    ///      chain where Aqua is not deployed at all. Being quotable is something a
    ///      founder opts into afterwards, not a precondition for making a wish.
    function configureAqua(IAqua aqua_, address router_) external onlyLive onlyFounder {
        if (address(aqua_) == address(0) || router_ == address(0)) revert AquaNotConfigured();
        if (strategyHash != bytes32(0)) revert PositionAlreadyOpen();
        aqua = aqua_;
        router = router_;
    }

    /// @notice Offer part or all of the principal as a fillable position.
    ///
    /// @param strategy The ABI-encoded order. Its program carries the gates; this
    ///        contract does not inspect it, because the router is what enforces it
    ///        and duplicating that check here would be a second opinion that could
    ///        disagree with the first.
    /// @param quoteToken_ What a filler pays in.
    /// @param offer How much of the principal to make available.
    /// @param asking The quote-side reserve, which is how the curve learns what
    ///        this wish is asking. It is priced against, never paid out — a filler
    ///        pays the quote token *to* this votive — so declaring a reserve of a
    ///        token the votive does not hold is safe and is the only way to name a
    ///        price at all.
    ///
    /// @dev The first version of this hardcoded the quote side to zero, reasoning
    ///      that a votive sells what it holds rather than making a two-sided
    ///      market. That reasoning was wrong in a way that could not be seen from
    ///      the outside: `XYCSwap` requires both reserves non-zero, so the position
    ///      shipped perfectly and could never be filled by anybody.
    function shipToAqua(bytes calldata strategy, address quoteToken_, uint256 offer, uint256 asking)
        external
        onlyLive
        onlyFounder
        returns (bytes32 hash)
    {
        if (address(aqua) == address(0)) revert AquaNotConfigured();
        if (strategyHash != bytes32(0)) revert PositionAlreadyOpen();
        if (quoteToken_ == address(0) || quoteToken_ == address(token)) {
            // A pair of the same token is not a market, and it would let a fill
            // round-trip the principal through the curve for free.
            revert QuoteTokenIsFundingToken();
        }

        // Never offer more than is actually parked. `parked` is principal net of
        // the fee already accrued, so this cannot promise money the protocol has
        // already earned and not yet taken.
        uint256 available = parked();
        if (offer == 0 || offer > available) revert OffersMoreThanParked(offer, available);
        if (asking == 0) revert AskingPriceRequired();

        // Bounded, not infinite. Aqua may spend exactly what was offered.
        IERC20(token).forceApprove(address(aqua), offer);

        // And the quote token, because the performance fee is taken in it.
        //
        // The fee instruction ends in `AQUA.pull(maker, ..., tokenIn, fee, treasury)`,
        // which is a `transferFrom` against this contract. Approving only the
        // principal left every fill above the fee threshold reverting — and
        // reverting *late*, because `quote` runs with `isStaticContext` set and
        // skips the pull entirely. The screen therefore priced the fill happily
        // and the transaction then failed, which is the worst shape a bug can
        // take on a page whose whole claim is that what you see is what happens.
        //
        // Bounded by the asking price: a fill cannot bring in more quote than the
        // position is priced to take, so the fee cannot exceed it either.
        IERC20(quoteToken_).forceApprove(address(aqua), asking);

        address[] memory tokens = new address[](2);
        tokens[0] = address(token);
        tokens[1] = quoteToken_;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = offer;
        // The asking price. The curve needs a reserve on both sides to quote at
        // all; this one is never spent, only priced against.
        amounts[1] = asking;

        hash = aqua.ship(router, strategy, tokens, amounts);

        strategyHash = hash;
        quoteToken = quoteToken_;
        offered = offer;
        askingReserve = asking;

        emit PositionOpened(hash, router, quoteToken_, offer);
    }

    /// @notice Close the position and withdraw the allowance.
    /// @dev Available to the founder at any time while the votive is live, and to
    ///      anyone once it is not — a settled votive with a live allowance over its
    ///      principal is exactly the state nobody should be able to leave it in.
    function dockFromAqua() external {
        if (strategyHash == bytes32(0)) revert NoPositionOpen();
        if (state == VotiveState.Waiting || state == VotiveState.Attempting) {
            if (msg.sender != _intent.founder) revert NotFounder();
        }

        address[] memory tokens = new address[](2);
        tokens[0] = address(token);
        tokens[1] = quoteToken;

        bytes32 closing = strategyHash;
        address closingQuote = quoteToken;
        strategyHash = bytes32(0);
        offered = 0;
        askingReserve = 0;

        // Allowances first, so a reverting `dock` cannot leave one standing.
        IERC20(token).forceApprove(address(aqua), 0);
        if (closingQuote != address(0)) IERC20(closingQuote).forceApprove(address(aqua), 0);
        aqua.dock(router, closing, tokens);

        emit PositionClosed(closing);
    }

    /// @notice What the position currently declares, straight from Aqua.
    function positionBalances() external view returns (uint256 principalSide, uint256 quoteSide) {
        if (address(aqua) == address(0) || strategyHash == bytes32(0)) return (0, 0);
        return aqua.safeBalances(address(this), router, strategyHash, address(token), quoteToken);
    }

    /// @notice Whether this votive is currently quotable.
    function isPositionOpen() external view returns (bool) {
        return strategyHash != bytes32(0);
    }
}
