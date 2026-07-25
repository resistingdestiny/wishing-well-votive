// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Calldata} from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import {BPS, Fee} from "@1inch/swap-vm/instructions/Fee.sol";
import {Context} from "@1inch/swap-vm/libs/VM.sol";
import {ContextLib} from "@1inch/swap-vm/libs/VM.sol";

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

    /// @dev Lifecycle values at or above this have settled. Mirrors the protocol's
    ///      `VotiveState`: 0 Nascent, 1 Waiting, 2 Attempting, then terminal.
    uint8 private constant FIRST_TERMINAL_STATE = 3;

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
