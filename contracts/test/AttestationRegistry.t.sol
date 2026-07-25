// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

contract AttestationRegistryTest is Test {
    AttestationRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal attestor = makeAddr("attestor");
    address internal factory = makeAddr("factory");
    address internal stranger = makeAddr("stranger");
    address internal votive = makeAddr("votive");

    bytes32 internal constant CAPABILITY = keccak256("draft-a-legal-brief");
    bytes32 internal constant OTHER_CAPABILITY = keccak256("prove-a-theorem");
    bytes32 internal constant MODEL_A = keccak256("model-a");
    bytes32 internal constant MODEL_B = keccak256("model-b");
    bytes32 internal constant CONDITION = keccak256("condition:brief-filed");
    bytes32 internal constant EVIDENCE = keccak256("ipfs://run-log");

    event AttestorChanged(address indexed previous, address indexed current);
    event FactoryChanged(address indexed previous, address indexed current);
    event VotiveRegistered(address indexed votive, bytes32 indexed capabilityId);
    event CapabilityAttested(
        bytes32 indexed capabilityId, bytes32 indexed modelId, bool verdict, bytes32 evidence
    );
    event CapabilityOpened(bytes32 indexed capabilityId, bytes32 indexed modelId);
    event CapabilityClosed(bytes32 indexed capabilityId);
    event ConditionAttested(
        address indexed votive, bytes32 indexed conditionHash, bool verdict, bytes32 evidence
    );

    function setUp() public {
        registry = new AttestationRegistry(owner, attestor);
        vm.prank(owner);
        registry.setFactory(factory);
    }

    // ------------------------------------------------------------ construction

    function test_constructor_setsOwnerAndAttestor() public view {
        assertEq(registry.owner(), owner);
        assertEq(registry.attestor(), attestor);
    }

    function test_constructor_rejectsZeroAttestor() public {
        vm.expectRevert(AttestationRegistry.ZeroAddress.selector);
        new AttestationRegistry(owner, address(0));
    }

    function test_constructor_rejectsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new AttestationRegistry(address(0), attestor);
    }

    // ------------------------------------------------------------------ admin

    function test_setAttestor_rotatesAndEmits() public {
        address next = makeAddr("next-attestor");
        vm.expectEmit(true, true, false, false);
        emit AttestorChanged(attestor, next);
        vm.prank(owner);
        registry.setAttestor(next);
        assertEq(registry.attestor(), next);

        // The old key is immediately powerless.
        vm.prank(attestor);
        vm.expectRevert(AttestationRegistry.NotAttestor.selector);
        registry.attestCapability(CAPABILITY, MODEL_A, true, EVIDENCE);
    }

    function test_setAttestor_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        registry.setAttestor(stranger);
    }

    function test_setAttestor_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(AttestationRegistry.ZeroAddress.selector);
        registry.setAttestor(address(0));
    }

    function test_setFactory_rotatesAndEmits() public {
        address next = makeAddr("next-factory");
        vm.expectEmit(true, true, false, false);
        emit FactoryChanged(factory, next);
        vm.prank(owner);
        registry.setFactory(next);
        assertEq(registry.factory(), next);
    }

    function test_setFactory_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        registry.setFactory(stranger);
    }

    function test_setFactory_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(AttestationRegistry.ZeroAddress.selector);
        registry.setFactory(address(0));
    }

    function test_ownershipHandoverIsTwoStep() public {
        address heir = makeAddr("heir");

        vm.prank(owner);
        registry.transferOwnership(heir);
        assertEq(registry.owner(), owner, "owner must not change until accepted");
        assertEq(registry.pendingOwner(), heir);

        vm.prank(heir);
        registry.acceptOwnership();
        assertEq(registry.owner(), heir);
    }

    // ----------------------------------------------------------- registration

    function test_registerVotive_bindsCapability() public {
        vm.expectEmit(true, true, false, false);
        emit VotiveRegistered(votive, CAPABILITY);
        vm.prank(factory);
        registry.registerVotive(votive, CAPABILITY);
        assertEq(registry.requiredCapability(votive), CAPABILITY);
    }

    function test_registerVotive_onlyFactory() public {
        vm.prank(stranger);
        vm.expectRevert(AttestationRegistry.NotFactory.selector);
        registry.registerVotive(votive, CAPABILITY);

        // Not even the owner may bind a votive.
        vm.prank(owner);
        vm.expectRevert(AttestationRegistry.NotFactory.selector);
        registry.registerVotive(votive, CAPABILITY);
    }

    function test_registerVotive_rejectsZeroArguments() public {
        vm.startPrank(factory);
        vm.expectRevert(AttestationRegistry.ZeroAddress.selector);
        registry.registerVotive(address(0), CAPABILITY);

        vm.expectRevert(AttestationRegistry.ZeroIdentifier.selector);
        registry.registerVotive(votive, bytes32(0));
        vm.stopPrank();
    }

    function test_registerVotive_isWriteOnce() public {
        vm.startPrank(factory);
        registry.registerVotive(votive, CAPABILITY);
        vm.expectRevert(AttestationRegistry.AlreadyRegistered.selector);
        registry.registerVotive(votive, OTHER_CAPABILITY);
        vm.stopPrank();

        assertEq(registry.requiredCapability(votive), CAPABILITY);
    }

    // ------------------------------------------------- capability attestations

    function test_attestCapability_onlyAttestor() public {
        vm.prank(stranger);
        vm.expectRevert(AttestationRegistry.NotAttestor.selector);
        registry.attestCapability(CAPABILITY, MODEL_A, true, EVIDENCE);
    }

    function test_attestCapability_rejectsZeroIdentifiers() public {
        vm.startPrank(attestor);
        vm.expectRevert(AttestationRegistry.ZeroIdentifier.selector);
        registry.attestCapability(bytes32(0), MODEL_A, true, EVIDENCE);

        vm.expectRevert(AttestationRegistry.ZeroIdentifier.selector);
        registry.attestCapability(CAPABILITY, bytes32(0), true, EVIDENCE);
        vm.stopPrank();
    }

    function test_gateStartsClosed() public view {
        assertFalse(registry.isCapabilityOpen(CAPABILITY));
        assertEq(registry.demonstratedBy(CAPABILITY), 0);
        assertEq(registry.pioneer(CAPABILITY), bytes32(0));
    }

    function test_attestCapability_passOpensGateAndRecordsPioneer() public {
        vm.expectEmit(true, true, false, true);
        emit CapabilityOpened(CAPABILITY, MODEL_A);
        vm.expectEmit(true, true, false, true);
        emit CapabilityAttested(CAPABILITY, MODEL_A, true, EVIDENCE);

        vm.warp(1_700_000_000);
        vm.prank(attestor);
        registry.attestCapability(CAPABILITY, MODEL_A, true, EVIDENCE);

        assertTrue(registry.isCapabilityOpen(CAPABILITY));
        assertEq(registry.demonstratedBy(CAPABILITY), 1);
        assertEq(registry.pioneer(CAPABILITY), MODEL_A);

        AttestationRegistry.Record memory record = registry.capabilityRecord(CAPABILITY, MODEL_A);
        assertTrue(record.exists);
        assertTrue(record.verdict);
        assertEq(record.at, 1_700_000_000);
        assertEq(record.evidence, EVIDENCE);
    }

    function test_attestCapability_failureIsRecordedNotDiscarded() public {
        vm.warp(1_700_000_000);
        vm.prank(attestor);
        registry.attestCapability(CAPABILITY, MODEL_A, false, EVIDENCE);

        assertFalse(registry.isCapabilityOpen(CAPABILITY));

        AttestationRegistry.Record memory record = registry.capabilityRecord(CAPABILITY, MODEL_A);
        assertTrue(record.exists, "a failure is an observation, and must be kept");
        assertFalse(record.verdict);
        assertEq(record.at, 1_700_000_000);
        assertEq(record.evidence, EVIDENCE);
    }

    function test_attestCapability_repeatedPassDoesNotDoubleCount() public {
        vm.startPrank(attestor);
        registry.attestCapability(CAPABILITY, MODEL_A, true, EVIDENCE);
        registry.attestCapability(CAPABILITY, MODEL_A, true, keccak256("second-run"));
        vm.stopPrank();

        assertEq(registry.demonstratedBy(CAPABILITY), 1);
        assertEq(registry.capabilityRecord(CAPABILITY, MODEL_A).evidence, keccak256("second-run"));
    }

    function test_attestCapability_repeatedFailureDoesNotUnderflow() public {
        vm.startPrank(attestor);
        registry.attestCapability(CAPABILITY, MODEL_A, false, EVIDENCE);
        registry.attestCapability(CAPABILITY, MODEL_A, false, EVIDENCE);
        vm.stopPrank();

        assertEq(registry.demonstratedBy(CAPABILITY), 0);
    }

    /// @dev The property the per-model bookkeeping exists for.
    function test_weakModelFailureDoesNotCloseGateOpenedByAnother() public {
        vm.startPrank(attestor);
        registry.attestCapability(CAPABILITY, MODEL_A, true, EVIDENCE);
        registry.attestCapability(CAPABILITY, MODEL_B, false, EVIDENCE);
        vm.stopPrank();

        assertTrue(registry.isCapabilityOpen(CAPABILITY), "gate must stay open");
        assertEq(registry.demonstratedBy(CAPABILITY), 1);
        assertEq(registry.pioneer(CAPABILITY), MODEL_A);
    }

    function test_retractingTheOnlyPassClosesTheGate() public {
        vm.startPrank(attestor);
        registry.attestCapability(CAPABILITY, MODEL_A, true, EVIDENCE);

        vm.expectEmit(true, false, false, false);
        emit CapabilityClosed(CAPABILITY);
        registry.attestCapability(CAPABILITY, MODEL_A, false, EVIDENCE);
        vm.stopPrank();

        assertFalse(registry.isCapabilityOpen(CAPABILITY));
        assertEq(registry.demonstratedBy(CAPABILITY), 0);
        assertEq(registry.pioneer(CAPABILITY), MODEL_A, "credit for opening it stays put");
    }

    function test_pioneerSurvivesLaterPasses() public {
        vm.startPrank(attestor);
        registry.attestCapability(CAPABILITY, MODEL_A, true, EVIDENCE);
        registry.attestCapability(CAPABILITY, MODEL_B, true, EVIDENCE);
        vm.stopPrank();

        assertEq(registry.demonstratedBy(CAPABILITY), 2);
        assertEq(registry.pioneer(CAPABILITY), MODEL_A);
    }

    function test_capabilitiesAreIndependent() public {
        vm.prank(attestor);
        registry.attestCapability(CAPABILITY, MODEL_A, true, EVIDENCE);

        assertTrue(registry.isCapabilityOpen(CAPABILITY));
        assertFalse(registry.isCapabilityOpen(OTHER_CAPABILITY));
    }

    // -------------------------------------------------- condition attestations

    function test_attestCondition_onlyAttestor() public {
        vm.prank(stranger);
        vm.expectRevert(AttestationRegistry.NotAttestor.selector);
        registry.attestCondition(votive, CONDITION, true, EVIDENCE);
    }

    function test_attestCondition_rejectsZeroArguments() public {
        vm.startPrank(attestor);
        vm.expectRevert(AttestationRegistry.ZeroAddress.selector);
        registry.attestCondition(address(0), CONDITION, true, EVIDENCE);

        vm.expectRevert(AttestationRegistry.ZeroIdentifier.selector);
        registry.attestCondition(votive, bytes32(0), true, EVIDENCE);
        vm.stopPrank();
    }

    function test_silenceIsNeverConfirmation() public view {
        assertFalse(registry.isConditionMet(votive, CONDITION));
        assertFalse(registry.conditionRecord(votive, CONDITION).exists);
    }

    function test_attestCondition_recordsAndEmits() public {
        vm.warp(1_700_000_000);
        vm.expectEmit(true, true, false, true);
        emit ConditionAttested(votive, CONDITION, true, EVIDENCE);
        vm.prank(attestor);
        registry.attestCondition(votive, CONDITION, true, EVIDENCE);

        assertTrue(registry.isConditionMet(votive, CONDITION));

        AttestationRegistry.Record memory record = registry.conditionRecord(votive, CONDITION);
        assertTrue(record.exists);
        assertTrue(record.verdict);
        assertEq(record.at, 1_700_000_000);
        assertEq(record.evidence, EVIDENCE);
    }

    function test_attestCondition_isRetractable() public {
        vm.startPrank(attestor);
        registry.attestCondition(votive, CONDITION, true, EVIDENCE);
        assertTrue(registry.isConditionMet(votive, CONDITION));

        registry.attestCondition(votive, CONDITION, false, EVIDENCE);
        assertFalse(registry.isConditionMet(votive, CONDITION));

        registry.attestCondition(votive, CONDITION, true, EVIDENCE);
        assertTrue(registry.isConditionMet(votive, CONDITION));
        vm.stopPrank();
    }

    function test_conditionsAreScopedToOneVotive() public {
        address neighbour = makeAddr("neighbour-votive");

        vm.prank(attestor);
        registry.attestCondition(votive, CONDITION, true, EVIDENCE);

        assertTrue(registry.isConditionMet(votive, CONDITION));
        assertFalse(
            registry.isConditionMet(neighbour, CONDITION),
            "the same words asked of another votive is another question"
        );
    }

    // ------------------------------------------------------------------- fuzz

    /// @notice However attestations arrive, `demonstratedBy` equals the number of
    ///         models whose latest verdict is a pass — so the gate is open if and
    ///         only if at least one model currently stands as having done it.
    function testFuzz_countTracksPassingModels(
        uint8[16] calldata models,
        bool[16] calldata verdicts
    ) public {
        bool[8] memory passing;

        vm.startPrank(attestor);
        for (uint256 i = 0; i < 16; i++) {
            uint256 slot = models[i] % 8;
            registry.attestCapability(
                CAPABILITY, bytes32(slot + 1), verdicts[i], bytes32(uint256(i))
            );
            passing[slot] = verdicts[i];
        }
        vm.stopPrank();

        uint256 expected;
        for (uint256 i = 0; i < 8; i++) {
            if (passing[i]) expected++;
        }

        assertEq(registry.demonstratedBy(CAPABILITY), expected);
        assertEq(registry.isCapabilityOpen(CAPABILITY), expected > 0);
    }
}
