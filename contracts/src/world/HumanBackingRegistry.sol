// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IHumanBacking} from "../interfaces/IHumanBacking.sol";
import {AssuranceTiers} from "./AssuranceTiers.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title HumanBackingRegistry
/// @notice The on-chain anchor for "a real, unique human stands behind this agent".
///
///         Proving humanity happens off-chain, where the evidence is: a liveness
///         check, a device signal, an in-person verification. What that produces is
///         a one-way identifier — the same human always yields the same one, and no
///         amount of it recovers the person. This registry is where an attestor
///         mirrors that result onto the chain the protocol runs on, so the payment
///         and allowance gates can read it without trusting a web service at the
///         moment money moves.
///
///         It is the identity anchor and nothing else. It holds no funds, decides
///         no allowances, and has no authority over any votive's payout
///         destination. What it knows is exactly the part that has to be on-chain:
///         *which unique human backs this wallet, and how strongly.*
///
/// @dev **Rebinding is a two-step operation, on purpose.** The obvious design lets
///      the attestor overwrite a wallet's backing in one call, moving it from one
///      human to another. That is a laundering path: standing and conduct are keyed
///      to the human, so silently re-pointing a wallet at a clean identifier is
///      exactly how a barred operator would try to keep working. Here, binding a
///      wallet that already belongs to someone else reverts; the attestor must
///      `revoke` first, which emits, and leaves the move as two auditable events
///      instead of one silent overwrite. Re-attesting the *same* human is still a
///      single call, because raising or lowering a tier is routine.
contract HumanBackingRegistry is IHumanBacking, Ownable2Step {
    // ------------------------------------------------------------------ types

    /// @notice A live backing. `humanId == 0` means the wallet carries none.
    struct Backing {
        bytes32 humanId;
        uint8 assurance;
        uint64 attestedAt;
    }

    // ----------------------------------------------------------------- state

    /// @notice The key permitted to mirror off-chain humanity results on-chain.
    ///         Swappable, and deliberately separate from the owner so the key that
    ///         signs routinely is not the key that can change the rules.
    address public attestor;

    /// @dev Latest live backing per agent wallet.
    mapping(address wallet => Backing) private _backing;

    /// @dev Wallets currently bound to each human. Aggregating here rather than per
    ///      wallet is the whole point: N wallets of one operator share one ceiling.
    mapping(bytes32 humanId => uint256) private _wallets;

    // ---------------------------------------------------------------- events

    event AttestorChanged(address indexed previousAttestor, address indexed newAttestor);

    /// @param evidenceHash Content hash of the off-chain verification record. The
    ///        chain stores the commitment; the transcript stays off it.
    event HumanAttested(
        address indexed wallet, bytes32 indexed humanId, uint8 assurance, bytes32 evidenceHash
    );

    /// @notice Emitted when a tier changes for a wallet already bound to the same
    ///         human, so a downgrade is as visible in the log as a first binding.
    event AssuranceChanged(
        address indexed wallet, bytes32 indexed humanId, uint8 previousTier, uint8 newTier
    );

    event HumanRevoked(address indexed wallet, bytes32 indexed humanId);

    // ---------------------------------------------------------------- errors

    error NotAttestor();
    error ZeroAddress();
    error ZeroHumanId();
    error UnknownTier(uint8 tier);
    /// @notice Thrown when binding a wallet that already belongs to another human.
    ///         Revoke it first — see the note on rebinding.
    error WalletBoundToAnotherHuman(bytes32 currentHumanId);

    // ----------------------------------------------------------- construction

    constructor(address initialOwner, address initialAttestor) Ownable(initialOwner) {
        if (initialAttestor == address(0)) revert ZeroAddress();
        attestor = initialAttestor;
        emit AttestorChanged(address(0), initialAttestor);
    }

    modifier onlyAttestor() {
        if (msg.sender != attestor) revert NotAttestor();
        _;
    }

    // ----------------------------------------------------------------- admin

    function setAttestor(address newAttestor) external onlyOwner {
        if (newAttestor == address(0)) revert ZeroAddress();
        emit AttestorChanged(attestor, newAttestor);
        attestor = newAttestor;
    }

    // ----------------------------------------------------------- attestation

    /// @notice Bind `wallet` to the unique human `humanId` at tier `assurance`.
    /// @dev Re-attesting the same human updates the tier in place. Binding a wallet
    ///      that currently belongs to a *different* human reverts; see the contract
    ///      note on why that is not a convenience worth having.
    function attest(address wallet, bytes32 humanId, uint8 assurance, bytes32 evidenceHash)
        external
        onlyAttestor
    {
        if (wallet == address(0)) revert ZeroAddress();
        if (humanId == bytes32(0)) revert ZeroHumanId();
        // Refuse a tier this deployment cannot price. Storing it would leave a
        // wallet that reads as backed but reverts on every allowance calculation.
        if (!AssuranceTiers.isKnown(assurance)) revert UnknownTier(assurance);

        Backing memory current = _backing[wallet];
        if (current.humanId != bytes32(0) && current.humanId != humanId) {
            revert WalletBoundToAnotherHuman(current.humanId);
        }

        if (current.humanId == bytes32(0)) {
            _wallets[humanId] += 1;
        } else if (current.assurance != assurance) {
            emit AssuranceChanged(wallet, humanId, current.assurance, assurance);
        }

        _backing[wallet] =
            Backing({humanId: humanId, assurance: assurance, attestedAt: uint64(block.timestamp)});
        emit HumanAttested(wallet, humanId, assurance, evidenceHash);
    }

    /// @notice Clear a wallet's backing — the human unregistered the agent, or the
    ///         evidence lapsed. The wallet immediately reads as unbacked, so it
    ///         loses commons access and settlement authority in the same block.
    /// @dev Idempotent: revoking an unbacked wallet is a no-op rather than a
    ///      revert, so an attestor reconciling state does not have to check first.
    function revoke(address wallet) external onlyAttestor {
        bytes32 previous = _backing[wallet].humanId;
        if (previous == bytes32(0)) return;
        _wallets[previous] -= 1;
        delete _backing[wallet];
        emit HumanRevoked(wallet, previous);
    }

    // ----------------------------------------------------------------- views

    /// @notice The full backing record for `wallet`.
    function backingOf(address wallet) external view returns (Backing memory) {
        return _backing[wallet];
    }

    /// @inheritdoc IHumanBacking
    function humanOf(address wallet) external view returns (bytes32) {
        return _backing[wallet].humanId;
    }

    /// @inheritdoc IHumanBacking
    function assuranceOf(address wallet) external view returns (uint8) {
        return _backing[wallet].assurance;
    }

    /// @inheritdoc IHumanBacking
    function isHumanBacked(address wallet) external view returns (bool) {
        return _backing[wallet].humanId != bytes32(0);
    }

    /// @inheritdoc IHumanBacking
    function walletCount(bytes32 humanId) external view returns (uint256) {
        return _wallets[humanId];
    }
}
