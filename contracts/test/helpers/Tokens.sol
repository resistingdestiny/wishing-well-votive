// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A well-behaved ERC-20, with settable decimals so tests are not all
///         implicitly about 18-decimal tokens.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice A token that returns nothing from `transfer` and `transferFrom` —
///         the pre-standard style that a naive integration breaks on.
contract NoReturnToken {
    string public constant name = "No Return";
    string public constant symbol = "NORET";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        uint256 permitted = allowance[from][msg.sender];
        if (permitted != type(uint256).max) allowance[from][msg.sender] = permitted - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @notice A token that takes a cut on every transfer.
contract FeeOnTransferToken is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) ERC20("Skim", "SKIM") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, address(0xdead), fee);
        super._update(from, to, value - fee);
    }
}

/// @notice A token that refuses to pay certain addresses, the way a real
///         regulated stablecoin refuses to pay a sanctioned one.
contract BlocklistToken is ERC20 {
    mapping(address => bool) public blocked;

    error Blocked();

    constructor() ERC20("Blocklist", "BLOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function block_(address account, bool value) external {
        blocked[account] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from] || blocked[to]) revert Blocked();
        super._update(from, to, value);
    }
}

/// @notice A token whose `transfer` answers with a word that is neither zero nor
///         one. Decoding that with `abi.decode(..., (bool))` reverts, which is
///         exactly what a push that must never revert cannot afford to do.
contract DirtyReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 permitted = allowance[from][msg.sender];
        if (permitted != type(uint256).max) allowance[from][msg.sender] = permitted - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    /// @dev Moves the value, then answers with 2.
    function transfer(address to, uint256 amount) external returns (uint256) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return 2;
    }
}

/// @notice A token with two addresses over one balance store — the shape real
///         tokens have had (TUSD, sUSD) when a proxy and its implementation are
///         both live, or a token ships a second facade.
///
/// @dev The point for tests: `alias.balanceOf(x)` and `alias.transfer(...)` read
///      and move the *same* balances as the core, while being a different address.
///      Any guard that compares addresses will wave it through.
contract SharedLedgerToken is ERC20 {
    address public facade;

    error NotFacade();

    constructor() ERC20("Shared Ledger", "SHARE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFacade(address facade_) external {
        facade = facade_;
    }

    /// @dev The second entry point moves core balances through here.
    function moveForFacade(address from, address to, uint256 amount) external {
        if (msg.sender != facade) revert NotFacade();
        _transfer(from, to, amount);
    }
}

/// @notice The second address over {SharedLedgerToken}'s balances.
contract TokenFacade {
    SharedLedgerToken public immutable core;

    constructor(SharedLedgerToken core_) {
        core = core_;
    }

    function balanceOf(address account) external view returns (uint256) {
        return core.balanceOf(account);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        core.moveForFacade(msg.sender, to, amount);
        return true;
    }
}
