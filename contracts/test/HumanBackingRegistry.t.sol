// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AssuranceTiers} from "../src/world/AssuranceTiers.sol";
import {HumanBackingRegistry} from "../src/world/HumanBackingRegistry.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

contract HumanBackingRegistryTest is Test {
    HumanBackingRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal attestor = makeAddr("attestor");
    address internal stranger = makeAddr("stranger");

    address internal agentA = makeAddr("agentA");
    address internal agentB = makeAddr("agentB");

    bytes32 internal alice = keccak256("human:alice");
    bytes32 internal mallory = keccak256("human:mallory");
    bytes32 internal evidence = keccak256("evidence");

    function setUp() public {
        registry = new HumanBackingRegistry(owner, attestor);
    }

    function _attest(address wallet, bytes32 humanId, uint8 tier) internal {
        vm.prank(attestor);
        registry.attest(wallet, humanId, tier, evidence);
    }

    // ------------------------------------------------------------- attestation

    function test_anAttestedWalletResolvesToItsHuman() public {
        _attest(agentA, alice, AssuranceTiers.ORB);

        assertEq(registry.humanOf(agentA), alice);
        assertEq(registry.assuranceOf(agentA), AssuranceTiers.ORB);
        assertTrue(registry.isHumanBacked(agentA));
        assertEq(registry.walletCount(alice), 1);
    }

    function test_anUnattestedWalletIsNobody() public view {
        assertEq(registry.humanOf(agentA), bytes32(0));
        assertEq(registry.assuranceOf(agentA), AssuranceTiers.NONE);
        assertFalse(registry.isHumanBacked(agentA));
    }

    /// One human running several agents is the normal case, and the count is what
    /// the commons aggregates against — so it has to be exact.
    function test_oneHumanManyWalletsSharesOneIdentity() public {
        _attest(agentA, alice, AssuranceTiers.SELFIE);
        _attest(agentB, alice, AssuranceTiers.SELFIE);

        assertEq(registry.humanOf(agentA), registry.humanOf(agentB));
        assertEq(registry.walletCount(alice), 2);
    }

    function test_reAttestingTheSameHumanMovesTheTierWithoutDoubleCounting() public {
        _attest(agentA, alice, AssuranceTiers.DEVICE);
        assertEq(registry.walletCount(alice), 1);

        _attest(agentA, alice, AssuranceTiers.ORB);

        assertEq(registry.assuranceOf(agentA), AssuranceTiers.ORB);
        assertEq(registry.walletCount(alice), 1, "the same wallet counted twice");
    }

    function test_aTierDowngradeIsAnnouncedNotJustApplied() public {
        _attest(agentA, alice, AssuranceTiers.ORB);

        vm.expectEmit(true, true, false, true, address(registry));
        emit HumanBackingRegistry.AssuranceChanged(
            agentA, alice, AssuranceTiers.ORB, AssuranceTiers.DEVICE
        );
        _attest(agentA, alice, AssuranceTiers.DEVICE);

        assertEq(registry.assuranceOf(agentA), AssuranceTiers.DEVICE);
    }

    // ---------------------------------------------------------- the laundering

    /// The point of the two-step rebinding rule. Standing and conduct are keyed to
    /// the human, so quietly re-pointing a wallet at a different identifier would be
    /// how a barred operator kept working. It has to be refused outright.
    function test_aWalletCannotBeMovedToAnotherHumanInOneCall() public {
        _attest(agentA, mallory, AssuranceTiers.SELFIE);

        vm.prank(attestor);
        vm.expectRevert(
            abi.encodeWithSelector(HumanBackingRegistry.WalletBoundToAnotherHuman.selector, mallory)
        );
        registry.attest(agentA, alice, AssuranceTiers.SELFIE, evidence);

        assertEq(registry.humanOf(agentA), mallory, "the binding moved anyway");
    }

    /// The move is still possible — it is a legitimate operation when an agent
    /// genuinely changes hands — but it costs two transactions and emits twice.
    function test_theMoveIsPossibleThroughRevokeAndLeavesBothEvents() public {
        _attest(agentA, mallory, AssuranceTiers.SELFIE);

        vm.expectEmit(true, true, false, false, address(registry));
        emit HumanBackingRegistry.HumanRevoked(agentA, mallory);
        vm.prank(attestor);
        registry.revoke(agentA);

        _attest(agentA, alice, AssuranceTiers.SELFIE);

        assertEq(registry.humanOf(agentA), alice);
        assertEq(registry.walletCount(mallory), 0);
        assertEq(registry.walletCount(alice), 1);
    }

    // -------------------------------------------------------------- revocation

    function test_revokingClearsTheBackingAndTheCount() public {
        _attest(agentA, alice, AssuranceTiers.ORB);
        _attest(agentB, alice, AssuranceTiers.ORB);

        vm.prank(attestor);
        registry.revoke(agentA);

        assertFalse(registry.isHumanBacked(agentA));
        assertEq(registry.assuranceOf(agentA), AssuranceTiers.NONE);
        assertEq(registry.walletCount(alice), 1, "the other wallet was affected");
    }

    /// An attestor reconciling state should not have to check first, and a double
    /// revoke must not underflow the per-human count.
    function test_revokingTwiceIsHarmless() public {
        _attest(agentA, alice, AssuranceTiers.SELFIE);

        vm.startPrank(attestor);
        registry.revoke(agentA);
        registry.revoke(agentA);
        registry.revoke(agentB); // never attested at all
        vm.stopPrank();

        assertEq(registry.walletCount(alice), 0);
    }

    // ------------------------------------------------------------ authorisation

    function test_onlyTheAttestorCanAttestOrRevoke() public {
        vm.prank(stranger);
        vm.expectRevert(HumanBackingRegistry.NotAttestor.selector);
        registry.attest(agentA, alice, AssuranceTiers.ORB, evidence);

        _attest(agentA, alice, AssuranceTiers.ORB);

        vm.prank(stranger);
        vm.expectRevert(HumanBackingRegistry.NotAttestor.selector);
        registry.revoke(agentA);
    }

    /// The owner sets the rules; it does not get to sign attestations as a side
    /// effect of owning the contract.
    function test_theOwnerIsNotAnAttestor() public {
        vm.prank(owner);
        vm.expectRevert(HumanBackingRegistry.NotAttestor.selector);
        registry.attest(agentA, alice, AssuranceTiers.ORB, evidence);
    }

    function test_onlyTheOwnerCanRotateTheAttestor() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        registry.setAttestor(stranger);

        address next = makeAddr("nextAttestor");
        vm.prank(owner);
        registry.setAttestor(next);
        assertEq(registry.attestor(), next);

        vm.prank(next);
        registry.attest(agentA, alice, AssuranceTiers.SELFIE, evidence);
        assertEq(registry.humanOf(agentA), alice);
    }

    // -------------------------------------------------------------- bad input

    function test_aNobodyCannotBeAttested() public {
        vm.startPrank(attestor);

        vm.expectRevert(HumanBackingRegistry.ZeroAddress.selector);
        registry.attest(address(0), alice, AssuranceTiers.ORB, evidence);

        vm.expectRevert(HumanBackingRegistry.ZeroHumanId.selector);
        registry.attest(agentA, bytes32(0), AssuranceTiers.ORB, evidence);

        vm.stopPrank();
    }

    /// A tier the deployment cannot price would read as backed and then revert on
    /// every allowance calculation. Refuse it at the door instead.
    function test_aTierNobodyCanPriceIsRefused() public {
        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(HumanBackingRegistry.UnknownTier.selector, uint8(9)));
        registry.attest(agentA, alice, 9, evidence);
    }

    function test_theConstructorInsistsOnAnAttestor() public {
        vm.expectRevert(HumanBackingRegistry.ZeroAddress.selector);
        new HumanBackingRegistry(owner, address(0));
    }

    // ------------------------------------------------------------------ fuzz

    /// However many wallets one human registers, the count matches — that number is
    /// the denominator the commons trusts.
    function testFuzz_theWalletCountTracksWhatWasAttested(uint8 count) public {
        count = uint8(bound(count, 1, 32));
        for (uint256 i = 0; i < count; i++) {
            _attest(address(uint160(0x5000 + i)), alice, AssuranceTiers.SELFIE);
        }
        assertEq(registry.walletCount(alice), count);

        for (uint256 i = 0; i < count; i++) {
            vm.prank(attestor);
            registry.revoke(address(uint160(0x5000 + i)));
        }
        assertEq(registry.walletCount(alice), 0);
    }
}
