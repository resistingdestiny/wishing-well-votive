// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TakerTraitsLib} from "@1inch/swap-vm/libs/TakerTraits.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

/// @notice Print what `TakerTraitsLib.build` produces for the browser filler's
///         exact shape, so the TypeScript encoder can be checked against it
///         rather than against a second reading of the same bit table.
///
/// @dev Two readings of a spec agree with each other far more often than either
///      agrees with the code. This prints the code.
contract PrintTakerTraits is Script {
    function run() external pure {
        address taker = 0x8A898Bbbbc2c754d9e7aE0596424A814B4F1A8B7;

        console.log("no threshold:");
        console.logBytes(_build(taker, ""));

        console.log("threshold 15e18:");
        console.logBytes(_build(taker, abi.encodePacked(uint256(15e18))));

        console.log("threshold 1:");
        console.logBytes(_build(taker, abi.encodePacked(uint256(1))));
    }

    function _build(address taker, bytes memory threshold) private pure returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
                isExactIn: true,
                shouldUnwrapWeth: false,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: true,
                useTransferFromAndAquaPush: true,
                threshold: threshold,
                to: address(0),
                deadline: 0,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );
    }
}
