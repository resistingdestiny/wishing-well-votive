// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TokenVotive} from "../src/TokenVotive.sol";
import {VotiveBase} from "../src/VotiveBase.sol";
import {Intent, VotiveState} from "../src/VotiveTypes.sol";
import {MockERC20, SharedLedgerToken, TokenFacade} from "./helpers/Tokens.sol";
import {VotiveTest} from "./helpers/VotiveTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice `recoverToken` exists to return an asset that wandered in by mistake.
///         It must not be able to return the asset the votive is actually funded
///         in — and "is this the funding asset" cannot be answered by comparing
///         addresses, because a token can have more than one.
contract TokenAliasRescueTest is VotiveTest {
    SharedLedgerToken internal core;
    TokenFacade internal facade;

    uint256 internal constant FUNDING = 1_000 ether;

    function setUp() public override {
        super.setUp();

        core = new SharedLedgerToken();
        facade = new TokenFacade(core);
        core.setFacade(address(facade));

        core.mint(founder, FUNDING * 2);

        vm.prank(owner);
        factory.setTokenAllowed(address(core), true);
    }

    function openInCore() internal returns (TokenVotive votive) {
        vm.startPrank(founder);
        core.approve(address(factory), FUNDING);
        votive = TokenVotive(
            factory.openWithToken(
                defaultIntent(), noOverrides(), anyTerms(), IERC20(address(core)), FUNDING
            )
        );
        vm.stopPrank();
    }

    /// @dev The two addresses really do share one balance store, so the premise of
    ///      the attack holds before we test the defence.
    function test_thePremise_twoAddressesOneLedger() public {
        TokenVotive votive = openInCore();

        assertEq(core.balanceOf(address(votive)), FUNDING);
        assertEq(facade.balanceOf(address(votive)), FUNDING, "the facade sees the same balance");
        assertTrue(address(facade) != address(core), "but it is a different address");
    }

    /// @dev Without a balance check this is a permissionless, fee-free, full
    ///      withdrawal of principal out of a `Waiting` votive: anyone may call
    ///      `recoverToken`, and it pays the founder.
    function test_aSecondEntryPointCannotWalkOffWithThePrincipal() public {
        TokenVotive votive = openInCore();
        uint256 founderBefore = core.balanceOf(founder);

        vm.prank(stranger);
        vm.expectRevert(TokenVotive.TokenIsTheFundingAsset.selector);
        votive.recoverToken(IERC20(address(facade)));

        assertEq(core.balanceOf(address(votive)), FUNDING, "principal stayed put");
        assertEq(core.balanceOf(founder), founderBefore, "and nobody was paid early");
        assertEq(votive.principal(), FUNDING);
        assertState(votive, VotiveState.Waiting);
    }

    /// @dev The direct attempt was always refused; keep asserting it, so the two
    ///      guards are known to be independent.
    function test_theFundingTokenItselfIsStillRefused() public {
        TokenVotive votive = openInCore();
        vm.expectRevert(TokenVotive.TokenIsTheFundingAsset.selector);
        votive.recoverToken(IERC20(address(core)));
    }

    /// @dev And a genuinely foreign token still goes home, so the guard has not
    ///      broken what the function is for.
    function test_aGenuinelyForeignTokenStillGoesHome() public {
        TokenVotive votive = openInCore();

        MockERC20 wanderer = new MockERC20("Wandered In", "WIN", 18);
        wanderer.mint(address(votive), 7 ether);

        vm.prank(stranger);
        votive.recoverToken(wanderer);

        assertEq(wanderer.balanceOf(founder), 7 ether);
        assertEq(core.balanceOf(address(votive)), FUNDING, "funding untouched");
    }

    /// @dev The votive settles normally afterwards — the guard is a check, not a
    ///      state change.
    function test_theVotiveStillSettlesAfterAFailedRescue() public {
        TokenVotive votive = openInCore();

        vm.prank(stranger);
        vm.expectRevert(TokenVotive.TokenIsTheFundingAsset.selector);
        votive.recoverToken(IERC20(address(facade)));

        passCapability();
        vm.prank(executor);
        votive.beginAttempt();
        meetCondition(address(votive));
        vm.prank(executor);
        votive.fulfil();

        assertEq(core.balanceOf(founder), FUNDING * 2, "founder made whole at settlement");
        assertEq(core.balanceOf(address(votive)), 0);
    }
}
