// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NativeVotive} from "../src/NativeVotive.sol";
import {VotiveBase} from "../src/VotiveBase.sol";
import {Intent, VotiveKind, VotiveState} from "../src/VotiveTypes.sol";
import {ContractSigner} from "./helpers/Recipients.sol";
import {VotiveTest} from "./helpers/VotiveTest.sol";

/// @notice The third invariant, exercised: who may point a votive somewhere
///         else, and when.
contract VotiveRedirectTest is VotiveTest {
    function guardedIntent() internal view returns (Intent memory intent_) {
        intent_ = defaultIntent();
        intent_.guardian = guardian;
    }

    // ------------------------------------------------------- founder redirect

    function test_founderMayRedirectAtAnyTime() public {
        NativeVotive votive = openDefault();

        vm.prank(founder);
        votive.redirect(payee);

        assertState(votive, VotiveState.Redirected);
        assertEq(payee.balance, DEPOSIT);
        assertEq(address(votive).balance, 0);
        assertFalse(factory.isLive(address(votive)));
    }

    function test_redirectSettlesTheScheduleFirst() public {
        NativeVotive votive = openDefault();

        vm.prank(stranger);
        (bool ok,) = address(votive).call{value: 50 ether}("");
        assertTrue(ok);

        vm.warp(block.timestamp + 365 days);
        vm.prank(founder);
        votive.redirect(payee);

        assertEq(treasury.balance, 2 ether + 4 ether);
        assertEq(payee.balance, 98 ether + 46 ether);
    }

    function test_redirectDuringAnAttemptIsFineForAnOrdinaryWish() public {
        NativeVotive votive = openDefault();
        beginAttempt(votive);

        vm.prank(founder);
        votive.redirect(payee);
        assertState(votive, VotiveState.Redirected);
    }

    function test_redirect_rejectsNowhere() public {
        NativeVotive votive = openDefault();

        vm.startPrank(founder);
        vm.expectRevert(VotiveBase.ZeroPayout.selector);
        votive.redirect(address(0));

        vm.expectRevert(VotiveBase.ZeroPayout.selector);
        votive.redirect(address(votive));
        vm.stopPrank();
    }

    function test_redirect_notForStrangers() public {
        NativeVotive votive = openDefault();
        vm.prank(stranger);
        vm.expectRevert(VotiveBase.NotAuthorised.selector);
        votive.redirect(stranger);
    }

    function test_redirect_isTerminal() public {
        NativeVotive votive = openDefault();
        vm.startPrank(founder);
        votive.redirect(payee);
        vm.expectRevert(VotiveBase.WrongState.selector);
        votive.redirect(payee);
        vm.stopPrank();
    }

    // ------------------------------------------------------ real-world lockout

    function test_aTaskInFlightCannotBeClawedBack() public {
        Intent memory intent_ = defaultIntent();
        intent_.kind = VotiveKind.RealWorldTask;
        intent_.expenseBudget = 10 ether;
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        beginAttempt(votive);

        vm.prank(founder);
        vm.expectRevert(VotiveBase.LockedDuringAttempt.selector);
        votive.redirect(payee);
    }

    function test_theLockoutEndsWithTheAttemptWindow() public {
        Intent memory intent_ = defaultIntent();
        intent_.kind = VotiveKind.RealWorldTask;
        intent_.expenseBudget = 10 ether;
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        beginAttempt(votive);
        vm.warp(block.timestamp + 7 days);
        votive.endAttempt();

        vm.prank(founder);
        votive.redirect(payee);
        assertState(votive, VotiveState.Redirected);
    }

    // ------------------------------------------------------ guardian redirect

    function test_guardianWaitsOutTheSilence() public {
        NativeVotive votive = openVotive(guardedIntent(), DEPOSIT);

        vm.prank(guardian);
        vm.expectRevert(VotiveBase.NotAuthorised.selector);
        votive.redirect(charity);

        vm.warp(votive.guardianOpensAt());
        vm.prank(guardian);
        votive.redirect(charity);

        assertState(votive, VotiveState.Redirected);
        // A year of silence has streamed 2 %; the guardian gets what is left.
        assertEq(treasury.balance, 2 ether);
        assertEq(charity.balance, DEPOSIT - 2 ether);
    }

    function test_aHeartbeatPutsTheGuardianBackToSleep() public {
        NativeVotive votive = openVotive(guardedIntent(), DEPOSIT);

        vm.warp(block.timestamp + 300 days);
        vm.prank(founder);
        votive.heartbeat();

        vm.warp(block.timestamp + 100 days);
        vm.prank(guardian);
        vm.expectRevert(VotiveBase.NotAuthorised.selector);
        votive.redirect(charity);

        vm.warp(votive.guardianOpensAt());
        vm.prank(guardian);
        votive.redirect(charity);
        assertEq(charity.balance + treasury.balance, DEPOSIT);
        assertGt(charity.balance, 0);
    }

    function test_thereIsNoGuardianUnlessOneWasNamed() public {
        NativeVotive votive = openDefault();
        vm.warp(block.timestamp + 3_650 days);

        vm.prank(guardian);
        vm.expectRevert(VotiveBase.NotAuthorised.selector);
        votive.redirect(charity);
    }

    // ------------------------------------------------------------ irrevocable

    function test_anIrrevocableVotiveCannotBeRedirectedByAnyone() public {
        Intent memory intent_ = defaultIntent();
        intent_.irrevocable = true;
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        vm.prank(founder);
        vm.expectRevert(VotiveBase.IrrevocableVotive.selector);
        votive.redirect(payee);

        vm.warp(block.timestamp + 3_650 days);
        vm.prank(stranger);
        vm.expectRevert(VotiveBase.IrrevocableVotive.selector);
        votive.redirect(payee);
    }

    function test_anIrrevocableVotiveRejectsSignedRedirectsToo() public {
        Intent memory intent_ = defaultIntent();
        intent_.irrevocable = true;
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        uint256 deadline = block.timestamp + 1 days;
        bytes memory signature = signRedirect(votive, founderKey, payee, deadline);

        vm.prank(stranger);
        vm.expectRevert(VotiveBase.IrrevocableVotive.selector);
        votive.redirectBySignature(payee, deadline, signature);
    }

    function test_anIrrevocableVotiveMayNotNameAGuardian() public {
        Intent memory intent_ = guardedIntent();
        intent_.irrevocable = true;

        vm.prank(founder);
        vm.expectRevert(VotiveBase.BadIntent.selector);
        factory.open{value: DEPOSIT}(intent_, noOverrides(), anyTerms());
    }

    function test_anIrrevocableVotiveStillFulfils() public {
        Intent memory intent_ = defaultIntent();
        intent_.irrevocable = true;
        intent_.beneficiary = payee;
        NativeVotive votive = openVotive(intent_, DEPOSIT);

        readyToFulfil(votive);
        vm.prank(executor);
        votive.fulfil();

        assertEq(payee.balance, DEPOSIT);
    }

    // ------------------------------------------------------ signed redirects

    function test_signedRedirectLetsSomebodyElsePayTheGas() public {
        NativeVotive votive = openDefault();
        uint256 deadline = block.timestamp + 1 days;
        bytes memory signature = signRedirect(votive, founderKey, charity, deadline);

        vm.prank(stranger);
        votive.redirectBySignature(charity, deadline, signature);

        assertState(votive, VotiveState.Redirected);
        assertEq(charity.balance, DEPOSIT);
        assertEq(votive.redirectNonce(), 1);
    }

    function test_signedRedirect_rejectsAnExpiredSignature() public {
        NativeVotive votive = openDefault();
        uint256 deadline = block.timestamp + 1 days;
        bytes memory signature = signRedirect(votive, founderKey, charity, deadline);

        vm.warp(deadline + 1);
        vm.expectRevert(VotiveBase.SignatureExpired.selector);
        votive.redirectBySignature(charity, deadline, signature);
    }

    function test_signedRedirect_rejectsTheWrongSigner() public {
        NativeVotive votive = openDefault();
        (, uint256 impostorKey) = makeAddrAndKey("impostor");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory signature = signRedirect(votive, impostorKey, charity, deadline);

        vm.expectRevert(VotiveBase.BadSignature.selector);
        votive.redirectBySignature(charity, deadline, signature);
    }

    function test_signedRedirect_rejectsATamperedDestination() public {
        NativeVotive votive = openDefault();
        uint256 deadline = block.timestamp + 1 days;
        bytes memory signature = signRedirect(votive, founderKey, charity, deadline);

        vm.expectRevert(VotiveBase.BadSignature.selector);
        votive.redirectBySignature(stranger, deadline, signature);
    }

    function test_signedRedirect_cannotBeReplayedOntoAnotherVotive() public {
        NativeVotive first = openDefault();
        NativeVotive second = openDefault();

        uint256 deadline = block.timestamp + 1 days;
        bytes memory signature = signRedirect(first, founderKey, charity, deadline);

        vm.expectRevert(VotiveBase.BadSignature.selector);
        second.redirectBySignature(charity, deadline, signature);

        assertTrue(
            domainSeparatorOf(address(first)) != domainSeparatorOf(address(second)),
            "each clone signs as itself"
        );
    }

    function test_invalidatingSignaturesVoidsAnOutstandingOne() public {
        NativeVotive votive = openDefault();
        uint256 deadline = block.timestamp + 1 days;
        bytes memory signature = signRedirect(votive, founderKey, charity, deadline);

        vm.prank(founder);
        votive.invalidateSignatures();
        assertEq(votive.redirectNonce(), 1);

        vm.expectRevert(VotiveBase.BadSignature.selector);
        votive.redirectBySignature(charity, deadline, signature);
    }

    function test_invalidateSignatures_onlyFounder() public {
        NativeVotive votive = openDefault();
        vm.prank(stranger);
        vm.expectRevert(VotiveBase.NotFounder.selector);
        votive.invalidateSignatures();
    }

    function test_aContractWalletCanSignARedirect() public {
        (address walletSigner, uint256 walletKey) = makeAddrAndKey("wallet-signer");
        ContractSigner wallet = new ContractSigner(walletSigner);
        vm.deal(address(wallet), DEPOSIT);

        Intent memory intent_ = defaultIntent();
        intent_.founder = address(wallet);

        bytes memory ret = wallet.execute(
            address(factory),
            DEPOSIT,
            abi.encodeCall(factory.open, (intent_, noOverrides(), anyTerms()))
        );
        NativeVotive votive = NativeVotive(payable(abi.decode(ret, (address))));

        uint256 deadline = block.timestamp + 1 days;
        bytes memory signature = signRedirect(votive, walletKey, charity, deadline);

        vm.prank(stranger);
        votive.redirectBySignature(charity, deadline, signature);

        assertEq(charity.balance, DEPOSIT, "ERC-1271 is a first-class signature here");
    }
}
