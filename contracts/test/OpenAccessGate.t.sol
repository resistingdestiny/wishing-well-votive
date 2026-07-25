// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessGate} from "../src/gates/IAccessGate.sol";
import {OpenAccessGate} from "../src/gates/OpenAccessGate.sol";
import {Test} from "forge-std/Test.sol";

contract OpenAccessGateTest is Test {
    OpenAccessGate internal gate;

    function setUp() public {
        gate = new OpenAccessGate();
    }

    function testFuzz_permitsEveryone(address account) public view {
        assertTrue(gate.isPermitted(account));
    }

    function test_satisfiesTheInterface() public view {
        assertTrue(IAccessGate(address(gate)).isPermitted(address(this)));
    }

    /// @dev No owner, no storage, nothing to seize: the gate cannot be turned
    ///      against the people it admits.
    function test_holdsNoState() public view {
        assertEq(address(gate).balance, 0);
        assertEq(vm.load(address(gate), bytes32(0)), bytes32(0));
    }
}
