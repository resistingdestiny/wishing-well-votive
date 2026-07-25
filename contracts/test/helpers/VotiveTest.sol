// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AttestationRegistry} from "../../src/AttestationRegistry.sol";
import {NativeVotive} from "../../src/NativeVotive.sol";
import {TokenVotive} from "../../src/TokenVotive.sol";
import {VotiveBase} from "../../src/VotiveBase.sol";
import {VotiveFactory} from "../../src/VotiveFactory.sol";
import {Deadlines, Intent, Terms, VotiveKind, VotiveState} from "../../src/VotiveTypes.sol";
import {OpenAccessGate} from "../../src/gates/OpenAccessGate.sol";
import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Shared fixture: a deployed protocol and the small vocabulary of
///         helpers every votive test needs.
abstract contract VotiveTest is Test {
    AttestationRegistry internal registry;
    OpenAccessGate internal gate;
    NativeVotive internal implementation;
    TokenVotive internal tokenImplementation;
    VotiveFactory internal factory;

    address internal owner = makeAddr("owner");
    address internal attestor = makeAddr("attestor");
    address internal treasury = makeAddr("treasury");
    address internal executor = makeAddr("executor");
    address internal guardian = makeAddr("guardian");
    address internal payee = makeAddr("payee");
    address internal stranger = makeAddr("stranger");
    address internal charity = makeAddr("charity");

    address internal founder;
    uint256 internal founderKey;

    bytes32 internal constant CAPABILITY = keccak256("capability:write-the-thing");
    bytes32 internal constant CONDITION = keccak256("condition:the-thing-is-written");
    bytes32 internal constant STORY = keccak256("story:once-there-was-a-wish");
    bytes32 internal constant MODEL = keccak256("model:the-one-that-could");
    bytes32 internal constant EVIDENCE = keccak256("evidence");

    uint256 internal constant DEPOSIT = 100 ether;

    bytes32 internal constant REDIRECT_TYPEHASH =
        keccak256("Redirect(address to,uint256 nonce,uint256 deadline)");

    function setUp() public virtual {
        (founder, founderKey) = makeAddrAndKey("founder");

        // Somewhere plausible in time, so year-long windows do not underflow.
        vm.warp(1_800_000_000);

        registry = new AttestationRegistry(owner, attestor);
        gate = new OpenAccessGate();
        implementation = new NativeVotive();
        tokenImplementation = new TokenVotive();
        factory = new VotiveFactory(
            owner,
            registry,
            address(implementation),
            address(tokenImplementation),
            treasury,
            executor,
            gate
        );

        vm.prank(owner);
        registry.setFactory(address(factory));

        vm.deal(founder, 1_000 ether);
        vm.deal(stranger, 1_000 ether);
        vm.deal(guardian, 1 ether);
    }

    // -------------------------------------------------------------- fixtures

    /// @dev The plain case: release to the founder when the condition is met.
    function defaultIntent() internal view returns (Intent memory) {
        return Intent({
            kind: VotiveKind.ReleaseOnCondition,
            founder: founder,
            guardian: address(0),
            beneficiary: address(0),
            fallbackTo: address(0),
            capabilityId: CAPABILITY,
            conditionHash: CONDITION,
            storyHash: STORY,
            expenseBudget: 0,
            irrevocable: false
        });
    }

    /// @dev Every clock left at zero, so the factory defaults apply.
    function noOverrides() internal pure returns (Deadlines memory) {
        return Deadlines({guardianAfter: 0, escheatAfter: 0, attemptWindow: 0});
    }

    /// @dev "I accept whatever you quote" — the ceiling is only interesting in
    ///      the tests that are specifically about it.
    function anyTerms() internal pure returns (Terms memory) {
        return Terms({streamBps: type(uint16).max, performanceBps: type(uint16).max});
    }

    // ---------------------------------------------------------------- actions

    function openVotive(Intent memory intent_, uint256 value)
        internal
        returns (NativeVotive votive)
    {
        vm.prank(intent_.founder);
        votive =
            NativeVotive(payable(factory.open{value: value}(intent_, noOverrides(), anyTerms())));
    }

    function openDefault() internal returns (NativeVotive) {
        return openVotive(defaultIntent(), DEPOSIT);
    }

    function passCapability() internal {
        vm.prank(attestor);
        registry.attestCapability(CAPABILITY, MODEL, true, EVIDENCE);
    }

    function meetCondition(address votive) internal {
        vm.prank(attestor);
        registry.attestCondition(votive, CONDITION, true, EVIDENCE);
    }

    /// @dev Get a votive all the way to the edge of settlement.
    function beginAttempt(NativeVotive votive) internal {
        passCapability();
        vm.prank(executor);
        votive.beginAttempt();
    }

    function readyToFulfil(NativeVotive votive) internal {
        beginAttempt(votive);
        meetCondition(address(votive));
    }

    // ---------------------------------------------------------------- signing

    /// @dev Build a redirect signature against the clone's own EIP-712 domain.
    ///      Reading the domain back off the votive (ERC-5267) rather than
    ///      hardcoding it is deliberate: it proves each clone signs as itself and
    ///      a signature cannot be replayed onto a sibling votive.
    function signRedirect(NativeVotive votive, uint256 key, address to, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash =
            keccak256(abi.encode(REDIRECT_TYPEHASH, to, votive.redirectNonce(), deadline));
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", domainSeparatorOf(address(votive)), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function domainSeparatorOf(address votive) internal view returns (bytes32) {
        (
            ,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,,
        ) = IERC5267(votive).eip712Domain();
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
    }

    // ------------------------------------------------------------- assertions

    /// @dev Typed against the base so it reads the same for either votive — they
    ///      share one state machine, and the tests should be able to say so.
    function assertState(VotiveBase votive, VotiveState expected) internal view {
        assertEq(uint8(votive.state()), uint8(expected), "unexpected lifecycle state");
    }
}
