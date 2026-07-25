// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title VotiveToken
/// @notice The unit a wish is funded and settled in.
///
///         A votive can be funded in any allowed ERC-20, and on a real deployment
///         that would be whatever people actually hold. This is the protocol's own
///         unit for testnets and demonstrations: a real token with real transfers,
///         so that what moves when a wish settles or a position fills is a
///         balance somebody could look up rather than a stand-in.
///
/// @dev Permit is included because the flows that matter — funding a wish, filling
///      its position — otherwise cost an approval transaction each, and on a
///      testnet that is the difference between a demonstration that flows and one
///      that stops to sign twice.
///
///      **The faucet is deliberate and deliberately bounded.** A demo that depends
///      on somebody having been handed tokens in advance excludes anyone who turns
///      up late, which on a testnet is everybody. So anyone may draw a fixed amount
///      once per interval, per address. That is not a security property — an
///      address is free — it is a speed bump against one script emptying the
///      supply while a person is trying to look at the thing.
contract VotiveToken is ERC20, ERC20Permit, Ownable2Step {
    /// @notice How much the faucet hands out per draw.
    uint256 public constant FAUCET_AMOUNT = 1_000e18;
    /// @notice How long an address must wait before drawing again.
    uint64 public constant FAUCET_INTERVAL = 1 hours;

    mapping(address => uint64) public lastDrawnAt;

    event FaucetDrawn(address indexed to, uint256 amount);

    error FaucetTooSoon(uint64 availableAt);

    constructor(string memory name_, string memory symbol_, address initialOwner)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
        Ownable(initialOwner)
    {}

    /// @notice Mint. The owner's, so a deployment can seed liquidity and a
    ///         treasury without waiting on the faucet.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Draw the standard amount. Anyone, once per interval.
    function faucet() external {
        uint64 available = lastDrawnAt[msg.sender] + FAUCET_INTERVAL;
        // A first-time caller has `lastDrawnAt == 0`, so the comparison below is
        // against `FAUCET_INTERVAL` rather than zero — hence the explicit check
        // rather than leaning on the arithmetic.
        if (lastDrawnAt[msg.sender] != 0 && block.timestamp < available) {
            revert FaucetTooSoon(available);
        }
        lastDrawnAt[msg.sender] = uint64(block.timestamp);
        _mint(msg.sender, FAUCET_AMOUNT);
        emit FaucetDrawn(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice When this address may draw again. Zero means now.
    function faucetAvailableAt(address account) external view returns (uint64) {
        uint64 last = lastDrawnAt[account];
        if (last == 0) return 0;
        return last + FAUCET_INTERVAL;
    }
}
