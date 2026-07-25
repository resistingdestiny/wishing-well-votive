/**
 * Pure run-log crypto — no filesystem, no RPC (local ecrecover only), so this
 * module is safe to import into a browser bundle. `RunLog` (in runlog.ts) builds
 * on these; the web ships the identical `entryHash` / `verifyChain` to a client
 * component so a visitor can recompute every keccak and check every signature
 * themselves. Zero-trust: the server is never asked "is this valid?".
 */

import { keccak256, toHex, verifyMessage } from "viem";

export interface RunLogEntry {
  /** Monotonic per-log sequence number. */
  seq: number;
  ts: string;
  trigger: "schedule" | "model-release" | "manual";
  kind: "capability-check" | "fulfilment-attempt" | "budget-refusal" | "sweep-note";
  capabilityId?: `0x${string}`;
  cell?: `0x${string}`;
  model: string;
  provider: string;
  pass?: boolean;
  score?: number;
  detail: unknown;
  inputTokens: number;
  outputTokens: number;
  /**
   * Hash of the immediately-preceding entry (`ZERO_HASH` for the genesis entry),
   * folded into this entry's own hash — so an entry can't be dropped, reordered,
   * or inserted without breaking every downstream hash + signature. Absent on
   * pre-chaining entries (they verify individually; the chain "starts" at the
   * first entry that carries one). Appended last in the canonical projection so
   * legacy entries hash exactly as before.
   */
  prevHash?: `0x${string}`;
}

export interface SignedRunLogEntry {
  entry: RunLogEntry;
  /** keccak256 of the canonical entry JSON — posted as attestation evidence. */
  hash: `0x${string}`;
  signature: `0x${string}`;
  signer: `0x${string}`;
}

/** Genesis link — the prevHash of the first entry in a fresh log. */
export const ZERO_HASH = `0x${"0".repeat(64)}` as const;

export function canonical(entry: RunLogEntry): string {
  // Stable key order via manual projection — the signature must be replayable.
  const base = {
    seq: entry.seq,
    ts: entry.ts,
    trigger: entry.trigger,
    kind: entry.kind,
    capabilityId: entry.capabilityId ?? null,
    cell: entry.cell ?? null,
    model: entry.model,
    provider: entry.provider,
    pass: entry.pass ?? null,
    score: entry.score ?? null,
    detail: entry.detail ?? null,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
  };
  // prevHash appended LAST and only when present, so legacy (pre-chaining) entries
  // canonicalize — and therefore hash — byte-for-byte as they did before.
  return JSON.stringify(entry.prevHash ? { ...base, prevHash: entry.prevHash } : base);
}

export function entryHash(entry: RunLogEntry): `0x${string}` {
  return keccak256(toHex(canonical(entry)));
}

export async function verifyEntry(signed: SignedRunLogEntry): Promise<boolean> {
  if (entryHash(signed.entry) !== signed.hash) return false;
  return verifyMessage({
    address: signed.signer,
    message: { raw: signed.hash },
    signature: signed.signature,
  });
}

export interface ChainVerification {
  total: number;
  /** Entries whose stored hash equals keccak(canonical(entry)) — content intact. */
  hashOk: number;
  /** Entries whose signature recovers to the stated signer. */
  sigOk: number;
  /** prevHash links checked (entries after the first that carry a prevHash). */
  linksChecked: number;
  /** All checked prevHash links point at the actual prior entry's hash. */
  chainIntact: boolean;
  /** seq of the earliest entry carrying a prevHash (where the chain begins). */
  chainFromSeq?: number;
  /** The first (lowest-seq) entry's prevHash is ZERO_HASH — the log starts at
   *  genesis, so no prefix (failed checks, refusals) was dropped. False ⇒ this is
   *  a mid-chain window; a full-log verification must require this to be true. */
  startsAtGenesis: boolean;
  /** Distinct signer addresses across the log (one ⇒ a single consistent oracle). */
  signers: `0x${string}`[];
  /** Single signer AND it equals the expected oracle (only true if one was given).
   *  Internal consistency (ok) is NOT enough — a forger can self-sign a fake log
   *  with their own key; only oracleBound proves the ORACLE attested these rows. */
  oracleBound: boolean;
  /** First seq where any check failed, if any. */
  brokenAt?: number;
  /** Internal consistency: every hash + signature valid, chain intact, one signer.
   *  A "verified" UI verdict must additionally require `oracleBound && startsAtGenesis`. */
  ok: boolean;
}

/**
 * Verify an ordered run of signed entries end to end: each entry's content hash,
 * each signature, the prevHash chain linkage, and — when an expected oracle is
 * given — that every row is signed by THAT oracle (not merely self-consistent).
 * Tamper-evidence: dropping, reordering, editing, or forging any entry breaks a
 * downstream link, a hash, or the oracle binding. Pure (local ecrecover, no RPC).
 */
export async function verifyChain(
  entries: SignedRunLogEntry[],
  expectedSigner?: string,
): Promise<ChainVerification> {
  const sorted = [...entries].sort((a, b) => a.entry.seq - b.entry.seq);
  const out: ChainVerification = {
    total: sorted.length,
    hashOk: 0,
    sigOk: 0,
    linksChecked: 0,
    chainIntact: true,
    startsAtGenesis: sorted[0]?.entry.prevHash === ZERO_HASH,
    signers: [],
    oracleBound: false,
    ok: true,
  };
  const signerSet = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    if (entryHash(s.entry) === s.hash) out.hashOk++;
    else fail(out, s.entry.seq);

    const sigValid = await verifyMessage({
      address: s.signer,
      message: { raw: s.hash },
      signature: s.signature,
    });
    if (sigValid) out.sigOk++;
    else fail(out, s.entry.seq);
    signerSet.add(s.signer.toLowerCase());

    if (s.entry.prevHash) {
      if (out.chainFromSeq === undefined) out.chainFromSeq = s.entry.seq;
      if (i > 0) {
        const prev = sorted[i - 1];
        out.linksChecked++;
        // A chained entry must point at the actual immediately-prior entry's hash.
        if (!prev || s.entry.prevHash !== prev.hash) {
          out.chainIntact = false;
          fail(out, s.entry.seq);
        }
      }
      // i === 0: a ZERO_HASH prevHash is a valid genesis; any other value means a
      // mid-chain window whose predecessor we don't hold — unverifiable, not tamper.
    }
  }
  out.signers = [...signerSet] as `0x${string}`[];
  out.oracleBound =
    !!expectedSigner &&
    out.signers.length === 1 &&
    out.signers[0]!.toLowerCase() === expectedSigner.toLowerCase();
  out.ok =
    out.total > 0 &&
    out.hashOk === out.total &&
    out.sigOk === out.total &&
    out.chainIntact &&
    out.signers.length === 1 &&
    out.brokenAt === undefined;
  return out;
}

function fail(out: ChainVerification, seq: number): void {
  if (out.brokenAt === undefined || seq < out.brokenAt) out.brokenAt = seq;
}
