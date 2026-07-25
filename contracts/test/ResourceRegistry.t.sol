// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AssuranceTiers} from "../src/world/AssuranceTiers.sol";
import {HumanBackingRegistry} from "../src/world/HumanBackingRegistry.sol";
import {ResourceRegistry} from "../src/world/ResourceRegistry.sol";
import {StandingLedger} from "../src/world/StandingLedger.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

contract ResourceRegistryTest is Test {
    HumanBackingRegistry internal humans;
    StandingLedger internal ledger;
    ResourceRegistry internal resources;

    address internal owner = makeAddr("owner");
    address internal attestor = makeAddr("attestor");
    address internal reviewer = makeAddr("reviewer");
    address internal recorder = makeAddr("recorder");
    address internal provider = makeAddr("provider");
    address internal stranger = makeAddr("stranger");

    address internal agentA = makeAddr("agentA");
    address internal agentB = makeAddr("agentB");

    bytes32 internal operator = keccak256("human:operator");
    bytes32 internal other = keccak256("human:other");
    bytes32 internal evidence = keccak256("evidence");

    bytes32 internal CORPUS = keccak256("resource:licensed-corpus");
    bytes32 internal CLUSTER = keccak256("resource:gpu-cluster");

    uint64 internal constant EPOCH = 1 days;
    uint32 internal constant BASE_LIMIT = 4;

    function setUp() public {
        vm.warp(1_800_000_000);
        humans = new HumanBackingRegistry(owner, attestor);
        ledger = new StandingLedger(owner);
        resources = new ResourceRegistry(owner, humans, ledger, EPOCH);

        vm.startPrank(owner);
        ledger.setRecorder(recorder, true);
        ledger.setReviewer(reviewer, true);
        resources.register(CORPUS, provider, BASE_LIMIT, AssuranceTiers.DEVICE, keccak256("terms"));
        resources.register(CLUSTER, provider, 2, AssuranceTiers.ORB, keccak256("terms:gpu"));
        vm.stopPrank();
    }

    function _verify(address wallet, bytes32 humanId, uint8 tier) internal {
        vm.prank(attestor);
        humans.attest(wallet, humanId, tier, evidence);
    }

    function _bar(bytes32 humanId) internal {
        vm.prank(reviewer);
        ledger.reportConduct(
            humanId,
            StandingLedger.Category.ViolenceAgainstPeople,
            StandingLedger.Severity.Critical,
            evidence
        );
    }

    function _deliver(bytes32 humanId, uint256 times) internal {
        vm.startPrank(recorder);
        for (uint256 i = 0; i < times; i++) {
            ledger.recordFulfilment(humanId);
        }
        vm.stopPrank();
    }

    // ------------------------------------------------------------- the grant

    function test_aVerifiedAgentIsGrantedAccess() public {
        _verify(agentA, operator, AssuranceTiers.SELFIE);

        vm.prank(agentA);
        bytes32 grantId = resources.requestAccess(CORPUS);

        ResourceRegistry.Grant memory grant = resources.grantOf(grantId);
        assertEq(grant.resourceId, CORPUS);
        assertEq(grant.humanId, operator);
        assertEq(grant.wallet, agentA);

        (bool releasable,) = resources.isGrantReleasable(grantId);
        assertTrue(releasable, "the provider would refuse a grant it just issued");
    }

    /// The credential never touches the chain. All that is public is that this
    /// operator became entitled — which is exactly the part worth auditing.
    function test_theGrantCarriesNoSecret() public {
        _verify(agentA, operator, AssuranceTiers.SELFIE);

        vm.prank(agentA);
        bytes32 grantId = resources.requestAccess(CORPUS);

        ResourceRegistry.Grant memory grant = resources.grantOf(grantId);
        // Nothing in the struct is a credential: a resource id, a human, a wallet
        // and two timestamps.
        assertGt(grant.issuedAt, 0);
        assertEq(grant.expiresAt, grant.issuedAt + resources.GRANT_LIFETIME());
    }

    function test_grantIdsDoNotCollideAcrossOperators() public {
        _verify(agentA, operator, AssuranceTiers.SELFIE);
        _verify(agentB, other, AssuranceTiers.SELFIE);

        vm.prank(agentA);
        bytes32 first = resources.requestAccess(CORPUS);
        vm.prank(agentB);
        bytes32 second = resources.requestAccess(CORPUS);

        assertTrue(first != second, "two operators got the same grant id");
    }

    // ------------------------------------------------------------- the quota

    function test_theShareRunsOutAndRefills() public {
        _verify(agentA, operator, AssuranceTiers.SELFIE);

        for (uint256 i = 0; i < BASE_LIMIT; i++) {
            vm.prank(agentA);
            resources.requestAccess(CORPUS);
        }

        vm.prank(agentA);
        vm.expectRevert(
            abi.encodeWithSelector(
                ResourceRegistry.Refused.selector, ResourceRegistry.Refusal.QuotaExhausted
            )
        );
        resources.requestAccess(CORPUS);

        vm.warp(block.timestamp + EPOCH);
        vm.prank(agentA);
        resources.requestAccess(CORPUS); // refilled
    }

    /// The property this shares with the money pool, and the reason both key on
    /// the human: an operator throttled on an API cannot register a second agent.
    function test_twoWalletsOfOneOperatorShareOneShare() public {
        _verify(agentA, operator, AssuranceTiers.SELFIE);
        _verify(agentB, operator, AssuranceTiers.SELFIE);

        for (uint256 i = 0; i < BASE_LIMIT; i++) {
            address wallet = i % 2 == 0 ? agentA : agentB;
            vm.prank(wallet);
            resources.requestAccess(CORPUS);
        }

        vm.prank(agentB);
        vm.expectRevert(
            abi.encodeWithSelector(
                ResourceRegistry.Refused.selector, ResourceRegistry.Refusal.QuotaExhausted
            )
        );
        resources.requestAccess(CORPUS);
    }

    function test_betterStandingEarnsALargerShare() public {
        _verify(agentA, operator, AssuranceTiers.SELFIE);
        assertEq(resources.effectiveLimitOf(agentA, CORPUS), BASE_LIMIT);

        _deliver(operator, 10); // multiplier climbs to its ceiling

        assertGt(resources.effectiveLimitOf(agentA, CORPUS), BASE_LIMIT);
    }

    // ------------------------------------------------------------ the refusals

    function test_anUnverifiedAgentGetsNothing() public {
        vm.prank(agentA);
        vm.expectRevert(
            abi.encodeWithSelector(
                ResourceRegistry.Refused.selector, ResourceRegistry.Refusal.NotHumanBacked
            )
        );
        resources.requestAccess(CORPUS);
    }

    /// The reason this shares the bar with everything else: an operator barred from
    /// spending money must not carry on using the expensive API instead.
    function test_aBarredOperatorGetsNothing() public {
        _verify(agentA, operator, AssuranceTiers.ORB);
        _deliver(operator, 10);
        _bar(operator);

        vm.prank(agentA);
        vm.expectRevert(
            abi.encodeWithSelector(
                ResourceRegistry.Refused.selector, ResourceRegistry.Refusal.Barred
            )
        );
        resources.requestAccess(CORPUS);
        assertEq(resources.effectiveLimitOf(agentA, CORPUS), 0);
    }

    function test_aResourceCanDemandStrongerEvidenceThanStandingSubstitutesFor() public {
        _verify(agentA, operator, AssuranceTiers.SELFIE);
        _deliver(operator, 20);

        vm.prank(agentA);
        vm.expectRevert(
            abi.encodeWithSelector(
                ResourceRegistry.Refused.selector, ResourceRegistry.Refusal.BelowMinimumAssurance
            )
        );
        resources.requestAccess(CLUSTER);
    }

    function test_askingForSomethingUnregisteredIsRefused() public {
        _verify(agentA, operator, AssuranceTiers.SELFIE);

        vm.prank(agentA);
        vm.expectRevert(
            abi.encodeWithSelector(
                ResourceRegistry.Refused.selector, ResourceRegistry.Refusal.NoSuchResource
            )
        );
        resources.requestAccess(keccak256("resource:imaginary"));
    }

    // ------------------------------------------------- release-time rechecking

    /// The case this design exists for. A grant is evidence of entitlement when it
    /// was issued; what matters is entitlement when the key actually changes hands.
    function test_aGrantStopsBeingReleasableIfTheOperatorIsBarredMeanwhile() public {
        _verify(agentA, operator, AssuranceTiers.SELFIE);

        vm.prank(agentA);
        bytes32 grantId = resources.requestAccess(CORPUS);
        (bool before,) = resources.isGrantReleasable(grantId);
        assertTrue(before);

        _bar(operator);

        (bool after_, ResourceRegistry.Refusal reason) = resources.isGrantReleasable(grantId);
        assertFalse(after_, "a barred operator could still collect its credential");
        assertEq(uint8(reason), uint8(ResourceRegistry.Refusal.Barred));
    }

    function test_aGrantLapses() public {
        _verify(agentA, operator, AssuranceTiers.SELFIE);

        vm.prank(agentA);
        bytes32 grantId = resources.requestAccess(CORPUS);

        vm.warp(block.timestamp + resources.GRANT_LIFETIME() + 1);

        (bool releasable,) = resources.isGrantReleasable(grantId);
        assertFalse(releasable, "an expired grant was still releasable");
    }

    /// A wallet revoked between asking and collecting cannot collect, and a wallet
    /// rebound to somebody else cannot collect on the first operator's entitlement.
    function test_aRevokedWalletCannotCollect() public {
        _verify(agentA, operator, AssuranceTiers.SELFIE);

        vm.prank(agentA);
        bytes32 grantId = resources.requestAccess(CORPUS);

        vm.prank(attestor);
        humans.revoke(agentA);

        (bool releasable, ResourceRegistry.Refusal reason) = resources.isGrantReleasable(grantId);
        assertFalse(releasable);
        assertEq(uint8(reason), uint8(ResourceRegistry.Refusal.NotHumanBacked));
    }

    function test_anUnknownGrantIsNotReleasable() public view {
        (bool releasable,) = resources.isGrantReleasable(keccak256("never issued"));
        assertFalse(releasable);
    }

    // -------------------------------------------------------------- lifecycle

    /// Retiring stops new grants but does not strand an agent mid-job.
    function test_retiringStopsNewGrantsAndHonoursOldOnes() public {
        _verify(agentA, operator, AssuranceTiers.SELFIE);

        vm.prank(agentA);
        bytes32 grantId = resources.requestAccess(CORPUS);

        vm.prank(provider);
        resources.retire(CORPUS);

        vm.prank(agentA);
        vm.expectRevert(
            abi.encodeWithSelector(
                ResourceRegistry.Refused.selector, ResourceRegistry.Refusal.Retired
            )
        );
        resources.requestAccess(CORPUS);

        (bool releasable,) = resources.isGrantReleasable(grantId);
        assertTrue(releasable, "retiring stranded an agent that was already entitled");
    }

    /// The provider pays for the seat, so the provider sets what it costs.
    function test_theProviderSetsItsOwnTermsAndNobodyElseDoes() public {
        vm.prank(stranger);
        vm.expectRevert(ResourceRegistry.NotTheProvider.selector);
        resources.update(CORPUS, 99, AssuranceTiers.DEVICE);

        vm.prank(provider);
        resources.update(CORPUS, 9, AssuranceTiers.DEVICE);

        _verify(agentA, operator, AssuranceTiers.SELFIE);
        assertEq(resources.effectiveLimitOf(agentA, CORPUS), 9);
    }

    function test_onlyTheOwnerRegisters() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        resources.register(keccak256("r"), provider, 1, AssuranceTiers.DEVICE, bytes32(0));
    }

    function test_aResourceCannotBeRegisteredTwice() public {
        vm.prank(owner);
        vm.expectRevert(ResourceRegistry.AlreadyRegistered.selector);
        resources.register(CORPUS, provider, 1, AssuranceTiers.DEVICE, bytes32(0));
    }

    // -------------------------------------------------------------- agreement

    /// `quote` and `requestAccess` must never disagree, or a caller's explanation
    /// of a refusal is fiction.
    function test_quoteAgreesWithWhatRequestDoes() public {
        _verify(agentA, operator, AssuranceTiers.SELFIE);

        (bool allowed,, uint32 limit, uint32 remaining) = resources.quote(agentA, CORPUS);
        assertTrue(allowed);
        assertEq(limit, BASE_LIMIT);
        assertEq(remaining, BASE_LIMIT);

        for (uint256 i = 0; i < BASE_LIMIT; i++) {
            vm.prank(agentA);
            resources.requestAccess(CORPUS);
        }

        (bool allowedNow, ResourceRegistry.Refusal reason,, uint32 left) =
            resources.quote(agentA, CORPUS);
        assertFalse(allowedNow);
        assertEq(uint8(reason), uint8(ResourceRegistry.Refusal.QuotaExhausted));
        assertEq(left, 0);
    }

    // ------------------------------------------------------------------ fuzz

    /// However many wallets one operator registers, the total granted in a window
    /// is the one share their standing earned.
    function testFuzz_moreWalletsNeverBuyMoreAccess(uint8 walletCount) public {
        uint160 count = uint160(bound(walletCount, 1, 10));
        for (uint160 i = 0; i < count; i++) {
            _verify(address(0x9000 + i), operator, AssuranceTiers.SELFIE);
        }

        uint256 granted = 0;
        for (uint160 round = 0; round < 20; round++) {
            for (uint160 i = 0; i < count; i++) {
                (bool allowed,,,) = resources.quote(address(0x9000 + i), CORPUS);
                if (!allowed) continue;
                vm.prank(address(0x9000 + i));
                resources.requestAccess(CORPUS);
                granted++;
            }
        }

        assertEq(granted, BASE_LIMIT, "more wallets bought more access");
    }
}
