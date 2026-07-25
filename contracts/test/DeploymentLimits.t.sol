// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {NativeVotive} from "../src/NativeVotive.sol";
import {TokenVotive} from "../src/TokenVotive.sol";
import {VotiveFactory} from "../src/VotiveFactory.sol";
import {OpenAccessGate} from "../src/gates/OpenAccessGate.sol";
import {VotiveTest} from "./helpers/VotiveTest.sol";

/// @notice Guards the deployability of the protocol.
///
/// @dev The 24 kB contract-size limit is the kind of ceiling you cross by
///      accident, in a pull request that looks like it only added a comment, and
///      then discover on a testnet. Asserting it here means the build tells you
///      instead.
///
///      The headroom numbers are deliberately stated rather than left implicit —
///      the point is not just "it fits today" but "here is how much room the next
///      feature has".
contract DeploymentLimitsTest is VotiveTest {
    /// @dev EIP-170.
    uint256 internal constant CODE_LIMIT = 24_576;

    function test_everyDeployedContractFitsTheLimit() public view {
        _assertFits("NativeVotive", address(implementation));
        _assertFits("TokenVotive", address(tokenImplementation));
        _assertFits("VotiveFactory", address(factory));
        _assertFits("AttestationRegistry", address(registry));
        _assertFits("OpenAccessGate", address(gate));
    }

    /// @dev The whole point of cloning: the factory's size is unrelated to the
    ///      protocol's. If this ever starts creeping, something has been added to
    ///      the factory that belongs in the votive.
    function test_theFactoryHasRoomToSpare() public view {
        uint256 size = address(factory).code.length;
        assertLt(size, CODE_LIMIT / 2, "the factory should stay well under half the limit");
    }

    /// @dev A votive is a minimal proxy, so opening a wish costs a few hundred
    ///      bytes of deployment rather than the whole protocol.
    function test_aVotiveIsAProxyNotACopy() public {
        address votive = address(openDefault());
        uint256 size = votive.code.length;

        assertLt(size, 128, "a clone should be EIP-1167 sized");
        assertGt(size, 0);
        assertLt(
            size,
            address(implementation).code.length / 100,
            "a clone must not be a copy of the implementation"
        );
    }

    function _assertFits(string memory name, address deployed) private view {
        uint256 size = deployed.code.length;
        assertGt(size, 0, string.concat(name, " did not deploy"));
        assertLt(size, CODE_LIMIT, string.concat(name, " exceeds the contract size limit"));
    }
}
