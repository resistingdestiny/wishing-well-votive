/**
 * Filing a conduct report on chain — the heaviest thing this application can do.
 *
 * `StandingLedger.reportConduct` is `onlyReviewer`, and on this deployment the
 * reviewer is the same address the attestor signs from, so this signs with
 * `WELL_ATTESTOR_PK` and the key never leaves the module — not logged, not
 * returned, not in an error handed back. It is the twin of `attestor.ts`, and it
 * is deliberately harder to reach: a bar follows a human across every wallet they
 * will ever hold, so the route above it refuses to call this for anyone the ledger
 * itself would not accept as a reviewer, and only ever against a submission the
 * community has already rejected.
 *
 * **The category sets the floor; we never file below it.** The contract raises a
 * too-low severity to the category's floor rather than rejecting it, so passing a
 * grade is a request, not the last word — Violence, Exploitation and
 * WeaponsOrMassHarm carry a permanent bar no grade can talk down. We pass what the
 * reviewer asked for and let the contract enforce its own floors.
 *
 * **A broadcast is not a success.** The result is `ok` only after a mined receipt
 * with `status === "success"`, for the same reason the attestor holds that line: a
 * hash proves a transaction exists, not that it did anything, and "reported" shown
 * off a hash is a bar that might never have landed.
 */
import { createPublicClient, createWalletClient, http, parseAbi, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { recordTx } from "@/lib/txLog";

const chainId = Number(process.env.NEXT_PUBLIC_WELL_CHAIN_ID ?? 84532);

const CHAIN: Chain = {
  id: chainId,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_WELL_RPC_URL ?? "https://sepolia.base.org"] },
  },
};

const ledgerAbi = parseAbi([
  "function reportConduct(bytes32 humanId, uint8 category, uint8 severity, bytes32 evidenceHash)",
  "function isReviewer(address who) view returns (bool)",
]);

function standingLedger(): `0x${string}` | null {
  const v = process.env.NEXT_PUBLIC_WELL_STANDING_LEDGER;
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : null;
}

function reviewerKey(): `0x${string}` | null {
  // The reviewer and the attestor are the same funded key on this deployment.
  // Read a dedicated `WELL_REVIEWER_PK` first so the two roles can be split later
  // without touching this module.
  const v = process.env.WELL_REVIEWER_PK ?? process.env.WELL_ATTESTOR_PK;
  return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as `0x${string}`) : null;
}

export function reviewerConfigured(): boolean {
  return reviewerKey() !== null && standingLedger() !== null;
}

/** The public address reports are filed from. Safe to display; the key is not. */
export function reviewerAddress(): `0x${string}` | null {
  const pk = reviewerKey();
  if (!pk) return null;
  try {
    return privateKeyToAccount(pk).address;
  } catch {
    return null;
  }
}

/**
 * Whether an address is a reviewer according to the ledger itself.
 *
 * Read, never assumed: the route mirrors the contract's own `onlyReviewer` gate at
 * the boundary rather than keeping its own list, so it can never accept a filer the
 * chain would reject or reject one the chain would accept.
 */
export async function isOnChainReviewer(who: `0x${string}`): Promise<
  { ok: true; value: boolean } | { ok: false; degraded: string }
> {
  const ledger = standingLedger();
  if (!ledger) return { ok: false, degraded: "no StandingLedger address on this deployment" };
  try {
    const v = await createPublicClient({ chain: CHAIN, transport: http() }).readContract({
      address: ledger,
      abi: ledgerAbi,
      functionName: "isReviewer",
      args: [who],
    });
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, degraded: `could not check reviewer status: ${(e as Error).message}`.slice(0, 220) };
  }
}

export type ReportResult =
  | { ok: true; txHash: `0x${string}` }
  | { ok: false; reason: "not-configured" | "tx-reverted" | "send-failed"; detail: string };

/**
 * File the report. `humanId` is resolved from the agent's wallet by the caller and
 * passed in — never accepted from a request body — so a report always lands on the
 * human the chain says is behind the work, not one a caller named.
 */
export async function reportConduct(
  humanId: `0x${string}`,
  category: number,
  severity: number,
  evidenceHash: `0x${string}`,
  note: { subject: string; detail: string },
): Promise<ReportResult> {
  const ledger = standingLedger();
  const pk = reviewerKey();
  if (!ledger || !pk) {
    return {
      ok: false,
      reason: "not-configured",
      detail: "no reviewer key or StandingLedger address on this deployment",
    };
  }

  const account = privateKeyToAccount(pk);
  const pub = createPublicClient({ chain: CHAIN, transport: http() });

  let txHash: `0x${string}`;
  try {
    const wallet = createWalletClient({ account, chain: CHAIN, transport: http() });
    // Simulate first so a revert — a zero humanId, a `None` severity, a caller the
    // ledger no longer trusts — arrives with its reason attached and costs no gas.
    const { request } = await pub.simulateContract({
      account,
      address: ledger,
      abi: ledgerAbi,
      functionName: "reportConduct",
      args: [humanId, category, severity, evidenceHash],
    });
    txHash = await wallet.writeContract(request);
  } catch (e) {
    return { ok: false, reason: "send-failed", detail: (e as Error).message.slice(0, 300) };
  }

  try {
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      return { ok: false, reason: "tx-reverted", detail: `reverted in ${txHash}` };
    }
    await recordTx({
      track: "world",
      chain: "base-sepolia",
      txHash,
      what: "Filed a conduct report against a human",
      detail: note.detail,
      contract: ledger,
      subject: note.subject,
      blockNumber: receipt.blockNumber,
    });
  } catch (e) {
    return {
      ok: false,
      reason: "send-failed",
      detail: `sent ${txHash} but could not confirm it: ${(e as Error).message}`.slice(0, 300),
    };
  }

  return { ok: true, txHash };
}
