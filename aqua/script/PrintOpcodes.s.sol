// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Controls} from "@1inch/swap-vm/instructions/Controls.sol";
import {XYCSwap} from "@1inch/swap-vm/instructions/XYCSwap.sol";
import {AquaOpcodesDebug} from "@1inch/swap-vm/opcodes/AquaOpcodesDebug.sol";
import {Program, ProgramBuilder} from "@1inch/swap-vm-test/utils/ProgramBuilder.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

/// @notice Prints the official opcode indices a client needs to encode a program.
///
/// @dev The indices are positions in a function-pointer table, resolved on chain
///      by scanning it. A TypeScript client cannot scan a table of function
///      pointers, so it has to hardcode the numbers — and a hardcoded opcode that
///      is wrong does not fail loudly, it runs a different instruction. This
///      prints them from the same table the router builds, so the numbers in the
///      client come from the contract rather than from counting by eye.
contract PrintOpcodes is Script, AquaOpcodesDebug {
    using ProgramBuilder for Program;

    constructor() AquaOpcodesDebug(address(0)) {}

    function run() external view {
        Program memory p = ProgramBuilder.init(_opcodes());
        console.log("official table length (votive opcode base): %s", _opcodes().length);
        console.log("xycSwapXD opcode: %s", uint8(p.build(XYCSwap._xycSwapXD)[0]));
        console.log("salt opcode:      %s", uint8(p.build(Controls._salt, abi.encodePacked(uint256(1)))[0]));
    }
}
