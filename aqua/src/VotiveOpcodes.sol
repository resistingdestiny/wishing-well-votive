// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Calldata} from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import {BPS, Fee} from "@1inch/swap-vm/instructions/Fee.sol";
import {Context} from "@1inch/swap-vm/libs/VM.sol";
import {ContextLib} from "@1inch/swap-vm/libs/VM.sol";

import {IVotiveHumanBacking, IVotiveStanding} from "./interfaces/IAgentStandingReads.sol";
import {IVotiveAttestations, IVotiveState} from "./interfaces/IVotiveReads.sol";

/// @notice Packed-calldata parsers for the votive instructions, in the style of
///         SwapVM's own argument builders: fixed-width fields, no ABI padding,
///         and a named error when the program is too short to hold them.
library VotiveArgs {
    using Calldata for bytes;

    error CapabilityGateArgs();
    error ConditionGateArgs();
    error LifecycleGateArgs();
    error PerformanceFeeArgs();
    error HumanGateArgs();
    error StandingGateArgs();
    error StandingBonusArgs();

    /// @dev [registry: 20][capabilityId: 32]
    function parseCapabilityGate(bytes calldata args)
        internal
        pure
        returns (address registry, bytes32 capabilityId)
    {
        bytes calldata a = args.slice(0, 52, CapabilityGateArgs.selector);
        registry = address(uint160(bytes20(a[0:20])));
        capabilityId = bytes32(a[20:52]);
    }

    /// @dev [registry: 20][votive: 20][conditionHash: 32]
    function parseConditionGate(bytes calldata args)
        internal
        pure
        returns (address registry, address votive, bytes32 conditionHash)
    {
        bytes calldata a = args.slice(0, 72, ConditionGateArgs.selector);
        registry = address(uint160(bytes20(a[0:20])));
        votive = address(uint160(bytes20(a[20:40])));
        conditionHash = bytes32(a[40:72]);
    }

    /// @dev [votive: 20]
    function parseLifecycleGate(bytes calldata args) internal pure returns (address votive) {
        bytes calldata a = args.slice(0, 20, LifecycleGateArgs.selector);
        votive = address(uint160(bytes20(a[0:20])));
    }

    /// @dev [backing: 20][minAssurance: 1]
    function parseHumanGate(bytes calldata args)
        internal
        pure
        returns (address backing, uint8 minAssurance)
    {
        bytes calldata a = args.slice(0, 21, HumanGateArgs.selector);
        backing = address(uint160(bytes20(a[0:20])));
        minAssurance = uint8(a[20]);
    }

    /// @dev [backing: 20][standing: 20][minMultiplierBps: 4]
    function parseStandingGate(bytes calldata args)
        internal
        pure
        returns (address backing, address standing, uint256 minMultiplierBps)
    {
        bytes calldata a = args.slice(0, 44, StandingGateArgs.selector);
        backing = address(uint160(bytes20(a[0:20])));
        standing = address(uint160(bytes20(a[20:40])));
        minMultiplierBps = uint32(bytes4(a[40:44]));
    }

    /// @dev [backing: 20][standing: 20][maxBonusBps: 4]
    function parseStandingBonus(bytes calldata args)
        internal
        pure
        returns (address backing, address standing, uint256 maxBonusBps)
    {
        bytes calldata a = args.slice(0, 44, StandingBonusArgs.selector);
        backing = address(uint160(bytes20(a[0:20])));
        standing = address(uint160(bytes20(a[20:40])));
        maxBonusBps = uint32(bytes4(a[40:44]));
    }

    /// @dev [threshold: 32][feeBps: 4][treasury: 20]
    function parsePerformanceFee(bytes calldata args)
        internal
        pure
        returns (uint256 threshold, uint256 feeBps, address treasury)
    {
        bytes calldata a = args.slice(0, 56, PerformanceFeeArgs.selector);
        threshold = uint256(bytes32(a[0:32]));
        feeBps = uint32(bytes4(a[32:36]));
        treasury = address(uint160(bytes20(a[36:56])));
    }
}

/// @title VotiveOpcodes
/// @notice The instructions that make a votive a native SwapVM position.
///
///         A votive is value parked against a job nobody can do yet. As an Aqua
///         position that is an unusual shape: it should not be *quotable*, let
///         alone fillable, until the world changes. The three gates below express
///         exactly that condition as VM instructions, so the frontier becomes
///         part of the pricing program rather than something a keeper has to
///         police off chain:
///
///         - `onlyCapabilityOpen` — has any model demonstrated the capability?
///         - `onlyConditionMet` — has *this* votive's release condition come true?
///         - `onlyVotiveLive` — is the votive still open, rather than settled?
///
///         And one instruction that moves value:
///
///         - `votivePerformanceFeeAmountInXD` — carves the protocol's performance
///           fee out of proceeds above the founder's committed principal.
///
///         The streaming fee needs no instruction of its own: 2 % per annum
///         against a parked balance is what the official `decayXD` opcode already
///         describes, so a votive's program composes it rather than reimplementing
///         it.
///
/// @dev All three gates are `view` and run in the quote path as well as the swap
///      path, so a closed votive quotes as unfillable rather than reverting only
///      once somebody has committed gas to a fill. That is the property that makes
///      this a *position* an aggregator can reason about and skip, instead of a
///      trap.
abstract contract VotiveOpcodes is Fee {
    using ContextLib for Context;

    error CapabilityNotOpen();
    error ConditionNotMet();
    error VotiveNotLive();
    error PerformanceFeeOutOfRange();
    error FillerNotHumanBacked();
    error FillerBelowAssurance();
    error FillerBarred();
    error FillerStandingTooLow();
    error StandingBonusOutOfRange();

    /// @dev Lifecycle values at or above this have settled. Mirrors the protocol's
    ///      `VotiveState`: 0 Nascent, 1 Waiting, 2 Attempting, then terminal.
    uint8 private constant FIRST_TERMINAL_STATE = 3;
    /// @dev The standing ledger's neutral point. Kept here rather than read so an
    ///      instruction cannot be made to pay a bonus by moving somebody's parity.
    uint256 private constant PARITY_BPS = 10_000;

    // ------------------------------------------------------------------- gates

    /// @notice Refuse the position until some model has demonstrated the
    ///         capability the votive named. This is the frontier as an
    ///         instruction: the position is unpriceable until the work becomes
    ///         possible at all.
    /// @param args [registry: 20][capabilityId: 32]
    function _onlyCapabilityOpen(Context memory, bytes calldata args) internal view {
        (address registry, bytes32 capabilityId) = VotiveArgs.parseCapabilityGate(args);
        require(IVotiveAttestations(registry).isCapabilityOpen(capabilityId), CapabilityNotOpen());
    }

    /// @notice Refuse the position until this votive's own release condition is
    ///         attested. Separate from the capability gate on purpose: one is a
    ///         fact about the frontier, the other a fact about this wish, and a
    ///         position that conflated them would open early.
    /// @param args [registry: 20][votive: 20][conditionHash: 32]
    function _onlyConditionMet(Context memory, bytes calldata args) internal view {
        (address registry, address votive, bytes32 conditionHash) =
            VotiveArgs.parseConditionGate(args);
        require(
            IVotiveAttestations(registry).isConditionMet(votive, conditionHash), ConditionNotMet()
        );
    }

    /// @notice Refuse the position once the votive has settled. Without this a
    ///         program could still be filled against a votive that had already
    ///         been fulfilled, redirected or escheated — the position would
    ///         outlive the thing it represents.
    /// @param args [votive: 20]
    function _onlyVotiveLive(Context memory, bytes calldata args) internal view {
        address votive = VotiveArgs.parseLifecycleGate(args);
        require(IVotiveState(votive).state() < FIRST_TERMINAL_STATE, VotiveNotLive());
    }

    // ------------------------------------------------------- who may fill this

    /// @notice Refuse a fill unless a verified human stands behind the filler.
    ///
    /// @dev The point of a wish is that somebody does the work. A position on a
    ///      wish that anyone can take is a position on a *price*; a position only
    ///      a human-backed agent can take is a position on the work actually being
    ///      done by somebody who can be held to it.
    ///
    ///      Reads the same registry the rest of the protocol reads, so an operator
    ///      barred for conduct is refused here without this instruction knowing
    ///      anything about conduct.
    /// @param args [backing: 20][minAssurance: 1]
    function _onlyHumanBackedFiller(Context memory ctx, bytes calldata args) internal view {
        (address backing, uint8 minAssurance) = VotiveArgs.parseHumanGate(args);
        address filler = ctx.query.taker;

        require(IVotiveHumanBacking(backing).humanOf(filler) != bytes32(0), FillerNotHumanBacked());
        require(
            IVotiveHumanBacking(backing).assuranceOf(filler) >= minAssurance, FillerBelowAssurance()
        );
    }

    /// @notice Refuse a fill from an operator who is barred or in poor standing.
    ///
    /// @dev Barred is checked separately from the multiplier and reported with its
    ///      own error, because they are different situations: one is "you have not
    ///      earned this yet" and the other is "you are not welcome here". Folding
    ///      them into one threshold would tell a suspended operator to go and
    ///      deliver more work, which is not the remedy.
    /// @param args [backing: 20][standing: 20][minMultiplierBps: 4]
    function _onlyFillerInGoodStanding(Context memory ctx, bytes calldata args) internal view {
        (address backing, address standing, uint256 minMultiplierBps) =
            VotiveArgs.parseStandingGate(args);

        bytes32 humanId = IVotiveHumanBacking(backing).humanOf(ctx.query.taker);
        require(humanId != bytes32(0), FillerNotHumanBacked());
        require(!IVotiveStanding(standing).isBarred(humanId), FillerBarred());
        require(
            IVotiveStanding(standing).multiplierBpsOf(humanId) >= minMultiplierBps,
            FillerStandingTooLow()
        );
    }

    /// @notice Pay a better-standing agent more for the same work.
    ///
    ///         This is the instruction that makes a wish a market rather than an
    ///         auction. Two agents can fulfil the same wish; the one with the
    ///         better record — who has delivered before, who wastes less, who has
    ///         not been reported — takes more of it home. The founder's principal
    ///         is unchanged either way; what moves is how much of the offered
    ///         amount the filler receives.
    ///
    /// @dev Brackets the rest of the program the way the fee instructions do: let
    ///      the curve settle the amounts first, then adjust. The bonus is a
    ///      fraction of `maxBonusBps` scaled by how far above parity the operator
    ///      stands, so parity earns nothing extra and the ceiling is reached only
    ///      by an operator at the ledger's own maximum.
    ///
    ///      Bounded twice over: `maxBonusBps` cannot exceed 100%, and the bonus
    ///      cannot exceed what the curve already computed. An instruction that
    ///      could mint output would be a hole in the maker's inventory, not a
    ///      reward.
    /// @param args [backing: 20][standing: 20][maxBonusBps: 4]
    function _fillerStandingBonusXD(Context memory ctx, bytes calldata args) internal {
        (address backing, address standing, uint256 maxBonusBps) =
            VotiveArgs.parseStandingBonus(args);
        require(maxBonusBps <= BPS, StandingBonusOutOfRange());

        ctx.runLoop();

        bytes32 humanId = IVotiveHumanBacking(backing).humanOf(ctx.query.taker);
        if (humanId == bytes32(0)) return;

        uint256 multiplier = IVotiveStanding(standing).multiplierBpsOf(humanId);
        // The ledger's parity is 10_000. Anything at or below it earns no bonus:
        // this rewards a record, it does not subsidise the absence of one.
        if (multiplier <= PARITY_BPS) return;

        uint256 above = multiplier - PARITY_BPS;
        if (above > PARITY_BPS) above = PARITY_BPS; // cap the scaling at 2x parity

        uint256 bonus = (ctx.swap.amountOut * maxBonusBps * above) / (BPS * PARITY_BPS);
        if (bonus == 0) return;

        // Never hand out more than the maker actually offered.
        uint256 headroom =
            ctx.swap.balanceOut > ctx.swap.amountOut ? ctx.swap.balanceOut - ctx.swap.amountOut : 0;
        if (bonus > headroom) bonus = headroom;

        ctx.swap.amountOut += bonus;
    }

    // --------------------------------------------------------- performance fee

    /// @notice Carve the protocol's performance fee out of proceeds above the
    ///         founder's committed principal, and send it to the treasury.
    ///
    /// @dev Brackets the rest of the program the way SwapVM's own amount-in fees
    ///      do: let the curve settle the proceeds first, then take a share of
    ///      whatever came back *above* the threshold. Below the threshold there is
    ///      no fee at all, because proceeds up to the principal are the founder's
    ///      own money returning — charging there would be charging for the wait,
    ///      which is what the streaming fee is for.
    ///
    ///      The fee is added to `amountNetPulled` and pulled from the maker's Aqua
    ///      balance, so the taker's price is untouched and the accounting stays
    ///      the maker's. `isStaticContext` guards the pull so a quote computes the
    ///      same number without moving anything.
    /// @param args [threshold: 32][feeBps: 4][treasury: 20]
    function _votivePerformanceFeeAmountInXD(Context memory ctx, bytes calldata args) internal {
        require(
            ctx.swap.amountIn == 0 || ctx.swap.amountOut == 0,
            FeeShouldBeAppliedBeforeSwapAmountsComputation()
        );
        (uint256 threshold, uint256 feeBps, address treasury) = VotiveArgs.parsePerformanceFee(args);
        require(feeBps <= BPS, PerformanceFeeOutOfRange());

        ctx.runLoop();

        uint256 proceeds = ctx.swap.amountIn;
        if (proceeds <= threshold) return;

        uint256 fee = (proceeds - threshold) * feeBps / BPS;
        if (fee == 0) return;

        ctx.swap.amountNetPulled += fee;
        if (!ctx.vm.isStaticContext) {
            _AQUA.pull(ctx.query.maker, ctx.query.orderHash, ctx.query.tokenIn, fee, treasury);
        }
    }
}
