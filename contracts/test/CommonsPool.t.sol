// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AssuranceTiers} from "../src/world/AssuranceTiers.sol";
import {CommonsPool} from "../src/world/CommonsPool.sol";
import {HumanBackingRegistry} from "../src/world/HumanBackingRegistry.sol";
import {StandingLedger} from "../src/world/StandingLedger.sol";
import {Test} from "forge-std/Test.sol";

/// @dev A payee that tries to draw again from inside the transfer it is being paid
///      by. The pool writes the epoch total before sending, so the second draw
///      should find the headroom already spent — the guard is the second line of
///      defence, not the first.
contract ReentrantPayee {
    CommonsPool internal pool;
    uint256 internal amount;
    bool public reentered;
    bool public reentrySucceeded;

    constructor(CommonsPool pool_) {
        pool = pool_;
    }

    function arm(uint256 amount_) external {
        amount = amount_;
    }

    function drawOnce(uint256 first) external {
        pool.draw(first, address(this));
    }

    receive() external payable {
        if (amount == 0 || reentered) return;
        reentered = true;
        try pool.draw(amount, address(this)) {
            reentrySucceeded = true;
        } catch {
            reentrySucceeded = false;
        }
    }
}

/// @dev Refuses everything sent to it, so a failed transfer is observable.
contract RejectingPayee {
    receive() external payable {
        revert("no thanks");
    }
}

contract CommonsPoolTest is Test {
    HumanBackingRegistry internal registry;
    StandingLedger internal ledger;
    CommonsPool internal pool;

    address internal owner = makeAddr("owner");
    address internal attestor = makeAddr("attestor");
    address internal reviewer = makeAddr("reviewer");
    address internal rail = makeAddr("rail");
    address internal funder = makeAddr("funder");
    address internal supplier = makeAddr("supplier");

    address internal agentA = makeAddr("agentA");
    address internal agentB = makeAddr("agentB");
    address internal botC = makeAddr("botC");

    bytes32 internal alice = keccak256("human:alice");
    bytes32 internal mallory = keccak256("human:mallory");
    bytes32 internal evidence = keccak256("evidence");

    uint64 internal constant EPOCH = 1 days;
    uint256 internal constant BASE = 10 ether;
    /// The step-up is off by default so the allowance tests are about allowances.
    /// The tests that are about the step-up switch it on themselves.
    uint256 internal constant STEP_UP = 4 ether;

    function setUp() public {
        registry = new HumanBackingRegistry(owner, attestor);
        ledger = new StandingLedger(owner);

        vm.startPrank(owner);
        ledger.setRecorder(rail, true);
        ledger.setReviewer(reviewer, true);
        vm.stopPrank();

        pool = new CommonsPool(owner, registry, ledger, EPOCH, BASE, 0, AssuranceTiers.DEVICE);

        vm.deal(funder, 1_000 ether);
        vm.prank(funder);
        pool.fund{value: 500 ether}();
    }

    function _attest(address wallet, bytes32 humanId, uint8 tier) internal {
        vm.prank(attestor);
        registry.attest(wallet, humanId, tier, evidence);
    }

    function _enableStepUp() internal {
        vm.prank(owner);
        pool.setParameters(BASE, STEP_UP, AssuranceTiers.DEVICE);
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

    // ---------------------------------------------------------------- ceilings

    /// A wallet nobody vouches for is not part of the commons at all.
    function test_aBotDrawsNothing() public {
        assertEq(pool.ceilingOf(botC), 0);

        vm.prank(botC);
        vm.expectRevert(
            abi.encodeWithSelector(CommonsPool.Refused.selector, CommonsPool.Refusal.NotHumanBacked)
        );
        pool.draw(1 ether, supplier);
    }

    /// Evidence weight and track record multiply. At parity standing, the ceiling is
    /// just the tier weight against the base.
    function test_theCeilingIsEvidenceTimesRecord() public {
        _attest(agentA, alice, AssuranceTiers.SELFIE);
        assertEq(pool.ceilingOf(agentA), BASE, "selfie at parity should be the base");

        _attest(agentB, mallory, AssuranceTiers.DEVICE);
        assertEq(pool.ceilingOf(agentB), BASE / 4, "device is weighted a quarter");
    }

    function test_aBetterRecordRaisesTheCeiling() public {
        _attest(agentA, alice, AssuranceTiers.SELFIE);

        vm.startPrank(rail);
        ledger.recordFulfilment(alice);
        ledger.recordFulfilment(alice);
        vm.stopPrank();

        // base × 1.0 (selfie) × 1.2 (two fulfilments)
        assertEq(pool.ceilingOf(agentA), (BASE * 12_000) / 10_000);
    }

    /// Neither axis substitutes for the other: the strongest evidence with a poor
    /// record still draws less than the base.
    function test_strongEvidenceDoesNotRescueAPoorRecord() public {
        _attest(agentA, alice, AssuranceTiers.ORB);

        vm.startPrank(rail);
        for (uint256 i = 0; i < 20; i++) {
            ledger.recordFailure(alice);
        }
        vm.stopPrank();

        // orb weight 2.0 × floor multiplier 0.25 = 0.5 of base
        assertEq(pool.ceilingOf(agentA), BASE / 2);
    }

    // -------------------------------------------------- the Sybil property

    /// The property the whole design exists for. Ten agents get an operator no more
    /// than one, because they all spend from the same headroom.
    function test_twoWalletsOfOneHumanShareOneAllowance() public {
        _attest(agentA, alice, AssuranceTiers.SELFIE);
        _attest(agentB, alice, AssuranceTiers.SELFIE);

        assertEq(pool.remainingOf(agentA), BASE);
        assertEq(pool.remainingOf(agentB), BASE);

        vm.prank(agentA);
        pool.draw(6 ether, supplier);

        // The second wallet sees the first wallet's spend.
        assertEq(pool.remainingOf(agentB), BASE - 6 ether, "the wallets had separate budgets");

        vm.prank(agentB);
        vm.expectRevert(
            abi.encodeWithSelector(CommonsPool.Refused.selector, CommonsPool.Refusal.NoHeadroom)
        );
        pool.draw(5 ether, supplier);

        // What genuinely remains still works.
        vm.prank(agentB);
        pool.draw(4 ether, supplier);
        assertEq(pool.remainingOf(agentA), 0);
    }

    function testFuzz_registeringMoreWalletsNeverRaisesTheTotal(uint8 wallets) public {
        uint160 count = uint160(bound(wallets, 1, 12));
        for (uint160 i = 0; i < count; i++) {
            _attest(address(0x7000 + i), alice, AssuranceTiers.SELFIE);
        }

        uint256 before = supplier.balance;
        for (uint160 i = 0; i < count; i++) {
            address wallet = address(0x7000 + i);
            uint256 left = pool.remainingOf(wallet);
            if (left == 0) continue;
            vm.prank(wallet);
            pool.draw(left, supplier);
        }

        assertEq(supplier.balance - before, BASE, "more wallets drew more than one allowance");
    }

    // ------------------------------------------------------------- the barring

    /// The end-to-end consequence of a malicious wish: every wallet the operator
    /// holds loses access at once, without anybody touching the registry.
    function test_barringAnOperatorCutsOffEveryWalletTheyHold() public {
        _attest(agentA, mallory, AssuranceTiers.ORB);
        _attest(agentB, mallory, AssuranceTiers.ORB);

        vm.prank(agentA);
        pool.draw(1 ether, supplier); // fine beforehand

        _bar(mallory);

        assertEq(pool.ceilingOf(agentA), 0);
        assertEq(pool.ceilingOf(agentB), 0);

        for (uint256 i = 0; i < 2; i++) {
            address wallet = i == 0 ? agentA : agentB;
            vm.prank(wallet);
            vm.expectRevert(
                abi.encodeWithSelector(CommonsPool.Refused.selector, CommonsPool.Refusal.Barred)
            );
            pool.draw(0.1 ether, supplier);
        }
    }

    /// And a fresh wallet is not a fresh start, which is the point of keying on the
    /// human rather than the address.
    function test_aBarredOperatorGainsNothingFromANewWallet() public {
        _bar(mallory);

        address freshWallet = makeAddr("freshWallet");
        _attest(freshWallet, mallory, AssuranceTiers.ORB);

        assertEq(pool.ceilingOf(freshWallet), 0);
        vm.prank(freshWallet);
        vm.expectRevert(
            abi.encodeWithSelector(CommonsPool.Refused.selector, CommonsPool.Refusal.Barred)
        );
        pool.draw(0.1 ether, supplier);
    }

    // -------------------------------------------------------------- step up

    /// Past performance is not evidence that a person is still on the other end, so
    /// a large draw needs the strongest tier however good the record.
    function test_aLargeDrawNeedsTheStrongestEvidence() public {
        _enableStepUp();
        _attest(agentA, alice, AssuranceTiers.SELFIE);
        vm.startPrank(rail);
        for (uint256 i = 0; i < 10; i++) {
            ledger.recordFulfilment(alice);
        }
        vm.stopPrank();

        vm.prank(agentA);
        vm.expectRevert(
            abi.encodeWithSelector(CommonsPool.Refused.selector, CommonsPool.Refusal.StepUpRequired)
        );
        pool.draw(STEP_UP + 1, supplier);

        // Under the threshold is fine.
        vm.prank(agentA);
        pool.draw(STEP_UP, supplier);
    }

    /// The bypass a per-draw check would have left wide open: ask for the threshold
    /// twice instead of twice the threshold. The step-up is cumulative for the
    /// epoch, so the second request is refused.
    function test_theStepUpCannotBeSplitIntoSmallerDraws() public {
        _enableStepUp();
        _attest(agentA, alice, AssuranceTiers.SELFIE);

        vm.prank(agentA);
        pool.draw(STEP_UP, supplier);

        vm.prank(agentA);
        vm.expectRevert(
            abi.encodeWithSelector(CommonsPool.Refused.selector, CommonsPool.Refusal.StepUpRequired)
        );
        pool.draw(1, supplier);

        assertEq(supplier.balance, STEP_UP, "the threshold was exceeded by instalments");
    }

    /// Nor across the several wallets of one operator, since the running total is
    /// the human's rather than the wallet's.
    function test_theStepUpCannotBeSplitAcrossWallets() public {
        _enableStepUp();
        _attest(agentA, alice, AssuranceTiers.SELFIE);
        _attest(agentB, alice, AssuranceTiers.SELFIE);

        vm.prank(agentA);
        pool.draw(STEP_UP, supplier);

        vm.prank(agentB);
        vm.expectRevert(
            abi.encodeWithSelector(CommonsPool.Refused.selector, CommonsPool.Refusal.StepUpRequired)
        );
        pool.draw(1, supplier);
    }

    function test_theStrongestTierClearsTheStepUp() public {
        _enableStepUp();
        _attest(agentA, alice, AssuranceTiers.ORB);

        vm.prank(agentA);
        pool.draw(STEP_UP + 1 ether, supplier);
        assertEq(supplier.balance, STEP_UP + 1 ether);
    }

    function test_aTierBelowTheMinimumIsRefused() public {
        vm.prank(owner);
        pool.setParameters(BASE, STEP_UP, AssuranceTiers.SELFIE);

        _attest(agentA, alice, AssuranceTiers.DEVICE);

        assertEq(pool.ceilingOf(agentA), 0);
        vm.prank(agentA);
        vm.expectRevert(
            abi.encodeWithSelector(
                CommonsPool.Refused.selector, CommonsPool.Refusal.BelowMinimumAssurance
            )
        );
        pool.draw(0.1 ether, supplier);
    }

    // --------------------------------------------------------------- epochs

    function test_theAllowanceRefillsNextEpoch() public {
        _attest(agentA, alice, AssuranceTiers.SELFIE);

        vm.prank(agentA);
        pool.draw(BASE, supplier);
        assertEq(pool.remainingOf(agentA), 0);

        vm.warp(block.timestamp + EPOCH);

        assertEq(pool.remainingOf(agentA), BASE, "a new epoch did not refill");
        vm.prank(agentA);
        pool.draw(BASE, supplier);
    }

    /// Lowering the base mid-epoch can leave an operator already over the new
    /// ceiling. That must read as zero headroom, not underflow.
    function test_loweringTheBaseMidEpochDoesNotUnderflow() public {
        _attest(agentA, alice, AssuranceTiers.SELFIE);

        vm.prank(agentA);
        pool.draw(8 ether, supplier);

        // Step-up stays off: this case is about the subtraction, not the tier gate.
        vm.prank(owner);
        pool.setParameters(1 ether, 0, AssuranceTiers.DEVICE);

        assertEq(pool.remainingOf(agentA), 0);
        vm.prank(agentA);
        vm.expectRevert(
            abi.encodeWithSelector(CommonsPool.Refused.selector, CommonsPool.Refusal.NoHeadroom)
        );
        pool.draw(1, supplier);
    }

    // --------------------------------------------------------------- refunds

    /// An agent that over-estimates and hands the remainder back should not be out
    /// of pocket on allowance for having been careful.
    function test_returningCapitalFreesTheHeadroomItUsed() public {
        _attest(agentA, alice, AssuranceTiers.SELFIE);

        vm.prank(agentA);
        pool.draw(6 ether, agentA);
        assertEq(pool.remainingOf(agentA), BASE - 6 ether);

        vm.prank(agentA);
        pool.refund{value: 4 ether}();

        assertEq(pool.remainingOf(agentA), BASE - 2 ether);
    }

    /// Returning more than was drawn is a donation, not banked credit for later.
    function test_returningMoreThanWasDrawnDoesNotBankCredit() public {
        _attest(agentA, alice, AssuranceTiers.SELFIE);
        vm.deal(agentA, 50 ether);

        vm.prank(agentA);
        pool.draw(1 ether, agentA);

        vm.prank(agentA);
        pool.refund{value: 20 ether}();

        assertEq(pool.remainingOf(agentA), BASE, "credit was banked above the ceiling");
    }

    // ---------------------------------------------------------- reentrancy

    /// The epoch total is written before value leaves, so a payee calling back in
    /// finds its headroom already spent rather than doubling its draw.
    function test_aPayeeCannotReenterToDrawTwice() public {
        ReentrantPayee payee = new ReentrantPayee(pool);
        _attest(address(payee), alice, AssuranceTiers.SELFIE);

        payee.arm(BASE); // try to take the whole allowance again on the way in
        payee.drawOnce(BASE);

        assertTrue(payee.reentered(), "the callback never fired");
        assertFalse(payee.reentrySucceeded(), "the reentrant draw went through");
        assertEq(address(payee).balance, BASE, "more than one allowance left the pool");
        assertEq(pool.remainingOf(address(payee)), 0);
    }

    function test_aPayeeThatRefusesPaymentRevertsTheDraw() public {
        RejectingPayee payee = new RejectingPayee();
        _attest(agentA, alice, AssuranceTiers.SELFIE);

        vm.prank(agentA);
        vm.expectRevert(CommonsPool.TransferFailed.selector);
        pool.draw(1 ether, address(payee));

        assertEq(pool.remainingOf(agentA), BASE, "a failed draw still spent the allowance");
    }

    // --------------------------------------------------------------- solvency

    function test_theCommonsCannotPayWhatItDoesNotHave() public {
        vm.prank(owner);
        pool.sweep(owner, address(pool).balance);

        _attest(agentA, alice, AssuranceTiers.SELFIE);

        vm.prank(agentA);
        vm.expectRevert(
            abi.encodeWithSelector(CommonsPool.Refused.selector, CommonsPool.Refusal.PoolTooLow)
        );
        pool.draw(1 ether, supplier);
    }

    /// Sweeping is for winding a deployment down. It must not double as a way to
    /// reset somebody's spent allowance.
    function test_sweepingDoesNotResetSpentAllowances() public {
        _attest(agentA, alice, AssuranceTiers.SELFIE);
        vm.prank(agentA);
        pool.draw(BASE, supplier);

        vm.prank(owner);
        pool.sweep(owner, 1 ether);

        assertEq(pool.remainingOf(agentA), 0, "a sweep refilled an allowance");
    }

    // ------------------------------------------------------------ bad requests

    function test_aDrawNeedsAnAmountAndSomewhereToSendIt() public {
        _attest(agentA, alice, AssuranceTiers.SELFIE);

        vm.startPrank(agentA);
        vm.expectRevert(
            abi.encodeWithSelector(CommonsPool.Refused.selector, CommonsPool.Refusal.BadRequest)
        );
        pool.draw(0, supplier);

        vm.expectRevert(
            abi.encodeWithSelector(CommonsPool.Refused.selector, CommonsPool.Refusal.BadRequest)
        );
        pool.draw(1 ether, address(0));

        // Paying the pool from the pool would be accounting theatre.
        vm.expectRevert(
            abi.encodeWithSelector(CommonsPool.Refused.selector, CommonsPool.Refusal.BadRequest)
        );
        pool.draw(1 ether, address(pool));
        vm.stopPrank();
    }

    /// `quote` and `draw` must never disagree, or a caller's explanation of a
    /// refusal is fiction.
    function test_quoteAgreesWithWhatDrawActuallyDoes() public {
        _attest(agentA, alice, AssuranceTiers.SELFIE);

        (bool allowed,,, uint256 remaining) = pool.quote(agentA, BASE, supplier);
        assertTrue(allowed);
        assertEq(remaining, BASE);

        vm.prank(agentA);
        pool.draw(BASE, supplier);

        (bool allowedNow, CommonsPool.Refusal reason,,) = pool.quote(agentA, 1, supplier);
        assertFalse(allowedNow);
        assertEq(uint8(reason), uint8(CommonsPool.Refusal.NoHeadroom));
    }

    function test_theConstructorRejectsAnImpossibleConfiguration() public {
        vm.expectRevert(CommonsPool.ZeroAddress.selector);
        new CommonsPool(
            owner,
            HumanBackingRegistry(address(0)),
            ledger,
            EPOCH,
            BASE,
            STEP_UP,
            AssuranceTiers.DEVICE
        );

        vm.expectRevert(
            abi.encodeWithSelector(CommonsPool.Refused.selector, CommonsPool.Refusal.BadRequest)
        );
        new CommonsPool(owner, registry, ledger, 0, BASE, STEP_UP, AssuranceTiers.DEVICE);
    }
}
