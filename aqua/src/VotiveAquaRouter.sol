// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Context} from "@1inch/swap-vm/libs/VM.sol";
import {AquaSwapVMRouter} from "@1inch/swap-vm/routers/AquaSwapVMRouter.sol";

import {VotiveOpcodes} from "./VotiveOpcodes.sol";

/// @title VotiveAquaRouter
/// @notice The official Aqua SwapVM router with the votive instructions appended.
///
///         The bounty permits redeploying a modified SwapVM, and this is the whole
///         modification: four instructions on the end of the official set. Nothing
///         inherited is altered, removed or reordered.
///
/// @dev Backwards compatibility is the reason for the append-only shape. The
///      official opcode indices stay exactly where they are, so a program encoded
///      by the Aqua SDK against the stock router runs byte-identically here — this
///      router is a superset, not a fork. The votive instructions occupy the four
///      indices immediately after, which are `_notInstruction` on the stock router
///      and therefore cannot collide with anything the SDK emits today.
///
///      `_opcodes()` is the only override. It copies the inherited table and adds
///      to it rather than rebuilding it, so an upstream release that appends its
///      own instruction shifts ours along without breaking either set.
contract VotiveAquaRouter is AquaSwapVMRouter, VotiveOpcodes {
    /// @notice Number of votive-native instructions appended to the official set.
    ///
    /// @dev Seven, in a fixed order that must only ever be appended to: three
    ///      gates on the wish, a performance fee, two gates on the filler, and a
    ///      bonus that pays a better-standing agent more. A program already
    ///      encoded against these indices would mean something else if they moved.
    uint256 public constant VOTIVE_OPCODE_COUNT = 7;

    constructor(address aqua, address weth, address owner)
        AquaSwapVMRouter(aqua, weth, owner, "VotiveAquaRouter", "1")
    {}

    /// @notice The index of the first votive instruction, so an off-chain program
    ///         builder never has to hardcode it — and so a test can assert the
    ///         official set really was left alone.
    function votiveOpcodeBase() external pure returns (uint256) {
        return super._opcodes().length;
    }

    /// @dev The official table, copied, plus ours on the end.
    function _opcodes()
        internal
        pure
        override
        returns (function(Context memory, bytes calldata) internal[] memory result)
    {
        function(Context memory, bytes calldata) internal[] memory official = super._opcodes();

        result = new function(Context memory, bytes calldata)
        internal[](official.length + VOTIVE_OPCODE_COUNT);
        for (uint256 i = 0; i < official.length; ++i) {
            result[i] = official[i];
        }

        uint256 base = official.length;
        result[base] = _onlyCapabilityOpen;
        result[base + 1] = _onlyConditionMet;
        result[base + 2] = _onlyVotiveLive;
        result[base + 3] = _votivePerformanceFeeAmountInXD;
        // Who may fill, and what their record is worth.
        result[base + 4] = _onlyHumanBackedFiller;
        result[base + 5] = _onlyFillerInGoodStanding;
        result[base + 6] = _fillerStandingBonusXD;
    }
}
