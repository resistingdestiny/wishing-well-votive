// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VotiveToken} from "../src/token/VotiveToken.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The protocol's own unit.
///
///         Most of what matters is inherited and already tested by OpenZeppelin,
///         so this covers only what was written here: minting authority and the
///         faucet, which is the part a demo actually leans on and the part that
///         could quietly hand the supply to one script.
contract VotiveTokenTest is Test {
    VotiveToken internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new VotiveToken("Votive", "VOTIVE", owner);
    }

    function test_itIsTheProtocolsUnit() public view {
        assertEq(token.name(), "Votive");
        assertEq(token.symbol(), "VOTIVE");
        assertEq(token.decimals(), 18);
    }

    function test_onlyTheOwnerMints() public {
        vm.prank(owner);
        token.mint(alice, 500e18);
        assertEq(token.balanceOf(alice), 500e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        token.mint(alice, 1);
    }

    // ------------------------------------------------------------- the faucet

    /// Somebody who turns up with nothing can start, which on a testnet is
    /// everybody.
    function test_anyoneCanDrawOnce() public {
        vm.prank(alice);
        token.faucet();
        assertEq(token.balanceOf(alice), token.FAUCET_AMOUNT());
    }

    function test_aSecondDrawHasToWait() public {
        vm.startPrank(alice);
        token.faucet();

        vm.expectRevert(
            abi.encodeWithSelector(
                VotiveToken.FaucetTooSoon.selector,
                uint64(block.timestamp) + token.FAUCET_INTERVAL()
            )
        );
        token.faucet();
        vm.stopPrank();
    }

    function test_theWaitEnds() public {
        vm.startPrank(alice);
        token.faucet();
        vm.warp(block.timestamp + token.FAUCET_INTERVAL());
        token.faucet();
        vm.stopPrank();

        assertEq(token.balanceOf(alice), 2 * token.FAUCET_AMOUNT());
    }

    /// The interval is per address, so one person drawing does not lock out the
    /// next — which on a demo day is the failure that matters.
    function test_oneDrawDoesNotBlockAnybodyElse() public {
        vm.prank(alice);
        token.faucet();

        vm.prank(bob);
        token.faucet();

        assertEq(token.balanceOf(bob), token.FAUCET_AMOUNT());
    }

    function test_theNextDrawTimeIsReadable() public {
        assertEq(token.faucetAvailableAt(alice), 0, "a newcomer waits for nothing");

        vm.prank(alice);
        token.faucet();
        assertEq(token.faucetAvailableAt(alice), uint64(block.timestamp) + token.FAUCET_INTERVAL());
    }

    /// @dev The zero sentinel is why the check is explicit rather than arithmetic:
    ///      a first-time caller has `lastDrawnAt == 0`, and comparing
    ///      `block.timestamp < 0 + INTERVAL` would refuse them for the first hour
    ///      after the epoch and, more to the point, reads as though it works.
    function test_aFirstDrawIsNotRefusedByTheSentinel() public {
        vm.warp(100); // early enough that `0 + INTERVAL` is still in the future
        vm.prank(bob);
        token.faucet();
        assertEq(token.balanceOf(bob), token.FAUCET_AMOUNT());
    }
}
