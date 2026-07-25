// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MockTaker} from "@1inch/swap-vm-test/mocks/MockTaker.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {MakerTraits} from "@1inch/swap-vm/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/libs/TakerTraits.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice Fill a wish's position, so the wish's own principal actually moves.
///
/// @dev Shipping transfers nothing — that is the whole point of Aqua's design —
///      so a position that has only ever been shipped has moved no tokens at all.
///      This is the other half: a taker pays the quote token in and the votive's
///      principal goes out, through the seven-instruction program.
///
///      The order has to be reconstructed exactly as it was shipped, because Aqua
///      keys the strategy on its hash. `ORDER_DATA` is the program bytes from the
///      shipping run.
contract FillVaultPosition is Script {
    function run() external {
        address router = vm.envAddress("AQUA_ROUTER");
        address votive = vm.envAddress("VOTIVE_ADDRESS");
        address tokenIn = vm.envAddress("QUOTE_TOKEN");
        address tokenOut = vm.envAddress("PRINCIPAL_TOKEN");
        address takerAddr = vm.envAddress("AQUA_TAKER");
        uint256 amount = vm.envUint("FILL_AMOUNT");
        bytes memory program = vm.envBytes("ORDER_DATA");

        ISwapVM.Order memory order =
            ISwapVM.Order({maker: votive, traits: MakerTraits.wrap(1 << 254), data: program});

        uint256 votiveBefore = IERC20Like(tokenOut).balanceOf(votive);
        uint256 takerBefore = IERC20Like(tokenOut).balanceOf(takerAddr);
        uint256 treasuryBefore = IERC20Like(tokenIn).balanceOf(address(0xFEE));

        vm.startBroadcast();
        // The taker needs the quote token to pay with, and the maker needs quote
        // headroom for the fee, which is pulled in the token coming in.
        IERC20Like(tokenIn).mint(takerAddr, amount);
        IERC20Like(tokenIn).mint(votive, amount);

        (uint256 amountIn, uint256 amountOut) = MockTaker(payable(takerAddr))
            .swap(
                order,
                tokenIn,
                tokenOut,
                amount,
                abi.encodePacked(
                    TakerTraitsLib.build(
                        TakerTraitsLib.Args({
                        taker: takerAddr,
                        isExactIn: true,
                        shouldUnwrapWeth: false,
                        hasPreTransferInCallback: true,
                        hasPreTransferOutCallback: false,
                        isStrictThresholdAmount: false,
                        isFirstTransferFromTaker: false,
                        useTransferFromAndAquaPush: false,
                        threshold: "",
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
                    )
                )
            );
        vm.stopBroadcast();

        console.log("");
        console.log("  The wish's own principal moved");
        console.log("  ------------------------------------------------------");
        console.log("    quote token in       %s", amountIn);
        console.log("    principal out        %s", amountOut);
        console.log(
            "    votive principal     %s -> %s",
            votiveBefore,
            IERC20Like(tokenOut).balanceOf(votive)
        );
        console.log(
            "    taker principal      %s -> %s",
            takerBefore,
            IERC20Like(tokenOut).balanceOf(takerAddr)
        );
        console.log(
            "    treasury fee         %s -> %s",
            treasuryBefore,
            IERC20Like(tokenIn).balanceOf(address(0xFEE))
        );
        console.log("");
        require(amountOut > 0, "no principal moved");
    }
}
