// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessGate} from "../../src/gates/IAccessGate.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Refuses everything sent to it. Stands in for a beneficiary that has
///         gone hostile, or is simply a contract with no payable entry point.
contract RejectingReceiver {
    error No();

    receive() external payable {
        revert No();
    }
}

/// @notice Accepts value but burns far more gas than an optimistic push allows,
///         which is the other way a push legitimately fails.
contract GasHungryReceiver {
    uint256[] private _ballast;

    receive() external payable {
        for (uint256 i = 0; i < 32; i++) {
            _ballast.push(i + 1);
        }
    }
}

/// @notice Calls straight back into the votive that is paying it.
contract ReentrantReceiver {
    address public target;
    bytes public payload;
    bool public reentered;
    bool public reentryReverted;

    function arm(address target_, bytes memory payload_) external {
        target = target_;
        payload = payload_;
    }

    receive() external payable {
        if (target == address(0)) return;
        reentered = true;
        (bool ok,) = target.call(payload);
        reentryReverted = !ok;
    }
}

/// @notice A smart-contract wallet: signs by ERC-1271 rather than by key.
contract ContractSigner {
    bytes4 private constant MAGIC = 0x1626ba7e;

    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return MAGIC;
        return 0xffffffff;
    }

    /// @dev So the wallet can open a votive of its own.
    function execute(address target, uint256 value, bytes calldata data)
        external
        returns (bytes memory)
    {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        require(ok, "wallet call failed");
        return ret;
    }

    receive() external payable {}
}

/// @notice An access gate that admits nobody, for testing the admission path.
contract ClosedAccessGate is IAccessGate {
    function isPermitted(address) external pure returns (bool) {
        return false;
    }
}

/// @notice An access gate with an explicit allowlist.
contract AllowlistGate is IAccessGate {
    mapping(address account => bool) public allowed;

    function allow(address account, bool value) external {
        allowed[account] = value;
    }

    function isPermitted(address account) external view returns (bool) {
        return allowed[account];
    }
}
