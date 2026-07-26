/**
 * Turning an approved solution into a paid one, on chain, honestly.
 *
 * Settlement is the one place the optimistic vote becomes money, so it is written
 * to the same standard as the attestor: it signs with `WELL_ATTESTOR_PK`, that key
 * never leaves this module, and a broadcast is not a success — the result is `ok`
 * only after a mined receipt with `status === "success"`.
 *
 * **The votive the attestation names is the rail, not the wish.** `release` on
 * `AgentBountyRail` checks `registry.isConditionMet(address(this), milestoneHash)`
 * — `address(this)` is the rail — so the condition is attested against the rail's
 * own address, keyed by the milestone hash, which is the submission's `resultHash`.
 * Attesting against the wish address instead would land a real transaction that
 * `release` then ignores, and read on screen as "the vote did not count".
 *
 * **The registry is read off the rail, never from configuration.** Two registries
 * can both accept our attestor, so attesting to the wrong one *succeeds* and then
 * `release` reverts `MilestoneNotAttested`. `railRegistry()` asks the rail which
 * registry it actually obeys, and that is the one attested to.
 *
 * **Everything that decides the payout comes from the stored submission.** The
 * rail, the bounty id, the milestone hash and the amount are read from the row the
 * community approved — never from the settle request — so a settle call cannot be
 * pointed at a different bounty, a larger amount, or another agent's work than the
 * one the window closed on.
 *
 * **Idempotent, because the money is.** If the milestone is already released on
 * chain, this sends nothing and reports the existing release. The database
 * `@@unique([railAddress, bountyId, resultHash])` is the first guard; the chain's
 * own `milestoneReleased` is the one that actually holds when two settle calls
 * race.
 */
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { registryAbi } from "@/lib/chain";
import { bountyOf, milestoneReleased, railRegistry } from "@/lib/chainReads";
import { parseAbi } from "viem";
import { recordTx, type TxChain } from "@/lib/txLog";

const railAbi = parseAbi([
  "function release(uint256 id, bytes32 milestoneHash, uint256 amount)",
]);

const BASE_SEPOLIA: Chain = {
  id: Number(process.env.NEXT_PUBLIC_WELL_CHAIN_ID ?? 84532),
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_WELL_RPC_URL ?? "https://sepolia.base.org"] },
  },
};

const HEDERA_TESTNET: Chain = {
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_HEDERA_RPC_URL ?? "https://testnet.hashio.io/api"] },
  },
};

function chainFor(chain: TxChain): Chain {
  return chain === "hedera-testnet" ? HEDERA_TESTNET : BASE_SEPOLIA;
}

function attestorKey(): `0x${string}` | null {
  const v = process.env.WELL_ATTESTOR_PK;
  return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as `0x${string}`) : null;
}

/** Whether automated settlement can sign at all on this deployment. */
export function settlementConfigured(): boolean {
  return attestorKey() !== null;
}

export interface SettleTarget {
  railAddress: `0x${string}`;
  bountyId: number;
  milestoneHash: `0x${string}`;
  chain: TxChain;
  /** The wish this is about, for the evidence preimage and the record. */
  wish: string;
  /** Decimal wei string, or null to release the whole remaining balance. */
  amountWei: string | null;
}

export type SettleResult =
  | {
      ok: true;
      alreadyReleased: boolean;
      attestTxHash: `0x${string}` | null;
      releaseTxHash: `0x${string}` | null;
      amount: string;
      evidenceHash: `0x${string}`;
      evidencePreimage: string;
    }
  | { ok: false; reason: string; detail: string };

/**
 * The preimage the condition attestation commits to.
 *
 * Published in full so anyone who kept a copy can recompute the on-chain
 * `evidenceHash`. It names what was settled, never a secret — the submission id,
 * the bounty, and the milestone are all already public.
 */
function evidencePreimage(t: SettleTarget, amount: bigint): string {
  return [
    "votive:solution-settlement:v1",
    `wish: ${t.wish}`,
    `rail: ${t.railAddress}`,
    `bounty: ${t.bountyId}`,
    `milestone: ${t.milestoneHash}`,
    `amount: ${amount.toString()}`,
  ].join("\n");
}

export async function settleSolution(t: SettleTarget): Promise<SettleResult> {
  const pk = attestorKey();
  if (!pk) {
    return {
      ok: false,
      reason: "not-configured",
      detail: "no attestor key on this deployment, so an approved solution cannot be released automatically",
    };
  }

  // Already done? Then send nothing. The chain's own guard, read first, is what
  // keeps two racing settle calls from both trying to release.
  const done = await milestoneReleased(t.railAddress, t.bountyId, t.milestoneHash, t.chain);
  if (done.ok && done.value) {
    return {
      ok: true,
      alreadyReleased: true,
      attestTxHash: null,
      releaseTxHash: null,
      amount: "0",
      evidenceHash: keccak256(toHex(evidencePreimage(t, 0n))),
      evidencePreimage: evidencePreimage(t, 0n),
    };
  }

  // The amount is the stored one, or the whole remaining balance for a
  // single-milestone bounty. Read the bounty either way, so the amount released is
  // never larger than what the rail actually holds unpaid.
  const bounty = await bountyOf(t.railAddress, t.bountyId, t.chain);
  if (!bounty.ok) {
    return { ok: false, reason: "read-failed", detail: bounty.degraded };
  }
  const remaining = bounty.value.total - bounty.value.paid;
  let amount: bigint;
  try {
    amount = t.amountWei ? BigInt(t.amountWei) : remaining;
  } catch {
    return { ok: false, reason: "bad-amount", detail: "stored amount is not a valid integer" };
  }
  if (amount <= 0n) {
    return { ok: false, reason: "nothing-to-release", detail: "the bounty has nothing left to release" };
  }
  if (amount > remaining) {
    return {
      ok: false,
      reason: "exceeds-remaining",
      detail: `the claim (${amount}) is larger than the bounty's unpaid balance (${remaining})`,
    };
  }

  // Which registry does this rail actually obey? Read it, never assume it.
  const reg = await railRegistry(t.railAddress, t.chain);
  if (!reg.ok) {
    return { ok: false, reason: "read-failed", detail: reg.degraded };
  }
  const registry = reg.value;

  const preimage = evidencePreimage(t, amount);
  const evidenceHash = keccak256(toHex(preimage));

  const account = privateKeyToAccount(pk);
  const chain = chainFor(t.chain);
  const rpc = chain.rpcUrls.default.http[0];
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });

  // 1. Attest the condition on the rail's own registry. onlyAttestor, so this is
  //    the signing step and the one that can be refused for being the wrong key.
  let attestTxHash: `0x${string}`;
  try {
    const { request } = await pub.simulateContract({
      account,
      address: registry,
      abi: registryAbi,
      functionName: "attestCondition",
      args: [t.railAddress, t.milestoneHash, true, evidenceHash],
    });
    attestTxHash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash: attestTxHash });
    if (receipt.status !== "success") {
      return { ok: false, reason: "attest-reverted", detail: `attestCondition reverted in ${attestTxHash}` };
    }
    // Written the moment it lands: history is recorded, never replayed.
    await recordTx({
      track: t.chain === "hedera-testnet" ? "hedera" : "votive",
      chain: t.chain,
      txHash: attestTxHash,
      what: "Attested a wish solution's milestone",
      detail: `condition ${t.milestoneHash} marked met on bounty #${t.bountyId}`,
      contract: registry,
      subject: t.wish,
      blockNumber: receipt.blockNumber,
    });
  } catch (e) {
    return { ok: false, reason: "attest-failed", detail: (e as Error).message.slice(0, 300) };
  }

  // 2. Release the milestone. Permissionless — it decides nothing, it only moves
  //    what the attestation above authorised. The attestation stands even if this
  //    step fails, so the release is resumable by anyone; we report the gap rather
  //    than hiding it.
  let releaseTxHash: `0x${string}`;
  try {
    const { request } = await pub.simulateContract({
      account,
      address: t.railAddress,
      abi: railAbi,
      functionName: "release",
      args: [BigInt(t.bountyId), t.milestoneHash, amount],
    });
    releaseTxHash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash: releaseTxHash });
    if (receipt.status !== "success") {
      return {
        ok: false,
        reason: "release-reverted",
        detail: `the condition is attested (${attestTxHash}) but release reverted in ${releaseTxHash}; anyone may finish it`,
      };
    }
    await recordTx({
      track: t.chain === "hedera-testnet" ? "hedera" : "votive",
      chain: t.chain,
      txHash: releaseTxHash,
      what: "Paid a wish solution's reward",
      detail: `released ${amount} on bounty #${t.bountyId} for milestone ${t.milestoneHash}`,
      contract: t.railAddress,
      subject: t.wish,
      blockNumber: receipt.blockNumber,
    });
  } catch (e) {
    return {
      ok: false,
      reason: "release-failed",
      detail: `attested in ${attestTxHash}, but release did not land: ${(e as Error).message}`.slice(0, 300),
    };
  }

  return {
    ok: true,
    alreadyReleased: false,
    attestTxHash,
    releaseTxHash,
    amount: amount.toString(),
    evidenceHash,
    evidencePreimage: preimage,
  };
}
