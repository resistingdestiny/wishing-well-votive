/**
 * What the protocol has done, recorded as it does it.
 *
 * Two rules hold this together, and they are opposites on purpose:
 *
 *   **History is written, never replayed.** A transaction is recorded at the
 *   moment it is broadcast. Reconstructing the same list from `eth_getLogs` looks
 *   tidier and does not work — a public endpoint caps the range (Base Sepolia at
 *   2000 blocks, about an hour), and a rejected query is indistinguishable from a
 *   contract that has never emitted anything. A demo that silently loses its own
 *   history after an hour is worse than one that keeps a row.
 *
 *   **State is read, never written.** A votive's phase, an operator's standing,
 *   what is left of an allowance — none of that is cached here. It comes from the
 *   contracts' own view functions every time, because a cached balance becomes a
 *   wrong balance the moment anybody transacts without us, and being confidently
 *   wrong about money is the one failure this project cannot afford.
 */
import { prisma } from "@/lib/db";

export type TxTrack = "votive" | "world" | "hedera" | "aqua";
export type TxChain = "base-sepolia" | "hedera-testnet" | "local-fork";

export interface RecordTxInput {
  track: TxTrack;
  chain: TxChain;
  txHash: string;
  /** One line a judge can read without knowing the codebase. */
  what: string;
  detail: string;
  contract?: string;
  subject?: string;
  blockNumber?: bigint;
}

export function explorerTx(chain: TxChain, hash: string): string {
  if (chain === "base-sepolia") return `https://sepolia.basescan.org/tx/${hash}`;
  if (chain === "hedera-testnet") return `https://hashscan.io/testnet/transaction/${hash}`;
  return "";
}

export function explorerAddress(chain: TxChain, address: string): string {
  if (chain === "base-sepolia") return `https://sepolia.basescan.org/address/${address}`;
  if (chain === "hedera-testnet") return `https://hashscan.io/testnet/contract/${address}`;
  return "";
}

/**
 * Record a transaction.
 *
 * Never throws. A demo page failing to note something is a smaller problem than a
 * user's wish failing to open because the note could not be written, and this is
 * always called after the transaction it describes has already landed.
 */
export async function recordTx(input: RecordTxInput): Promise<void> {
  try {
    await prisma.chainTx.upsert({
      // Keyed on the hash and the description together: one transaction can be
      // worth more than one line — opening a wish is both a votive event and,
      // when the founder was verified, a World one.
      where: { txHash_what: { txHash: input.txHash, what: input.what } },
      create: {
        track: input.track,
        chain: input.chain,
        txHash: input.txHash,
        what: input.what,
        detail: input.detail,
        contract: input.contract ?? null,
        subject: input.subject ?? null,
        blockNumber: input.blockNumber ?? null,
      },
      update: {},
    });
  } catch (e) {
    // Silent to the caller, always — but not silent to the developer. A swallowed
    // write is exactly how a bug hides: the endpoint answers 200, the page shows
    // nothing, and there is no thread to pull. In development, say so.
    if (process.env.NODE_ENV !== "production") {
      console.error("[txLog] could not record transaction:", (e as Error).message);
    }
  }
}

export interface RecordedTx {
  track: TxTrack;
  chain: TxChain;
  txHash: string;
  what: string;
  detail: string;
  subject: string | null;
  blockNumber: bigint | null;
  createdAt: Date;
  explorerUrl: string;
}

export async function recentTxs(limit = 200): Promise<RecordedTx[]> {
  const rows = await prisma.chainTx
    .findMany({ orderBy: { createdAt: "desc" }, take: limit })
    .catch(() => []);

  return rows.map((r) => ({
    track: r.track as TxTrack,
    chain: r.chain as TxChain,
    txHash: r.txHash,
    what: r.what,
    detail: r.detail,
    subject: r.subject,
    blockNumber: r.blockNumber,
    createdAt: r.createdAt,
    explorerUrl: explorerTx(r.chain as TxChain, r.txHash),
  }));
}
