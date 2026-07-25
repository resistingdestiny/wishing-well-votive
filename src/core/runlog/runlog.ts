import fs from "node:fs";
import path from "node:path";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  entryHash,
  ZERO_HASH,
  type RunLogEntry,
  type SignedRunLogEntry,
} from "./verify.js";

// Re-export the pure crypto core so existing imports (and the on-chain evidence
// callers) keep working; the web imports it directly from ./verify.js instead.
export {
  entryHash,
  canonical,
  verifyEntry,
  verifyChain,
  ZERO_HASH,
  type RunLogEntry,
  type SignedRunLogEntry,
  type ChainVerification,
} from "./verify.js";

/**
 * Append-only signed run log (JSONL). Every capability check and fulfilment
 * attempt lands here — pass or fail — signed by the oracle account so evidence
 * hashes on chain can be traced to exactly one log entry. Each entry is also
 * hash-chained to its predecessor (see ./verify.js) for tamper-evidence.
 */
export class RunLog {
  private readonly file: string;

  constructor(dataDir: string, private readonly account: PrivateKeyAccount) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "runlog.jsonl");
  }

  readAll(): SignedRunLogEntry[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SignedRunLogEntry);
  }

  nextSeq(): number {
    const all = this.readAll();
    return all.length === 0 ? 0 : all[all.length - 1]!.entry.seq + 1;
  }

  async append(entry: Omit<RunLogEntry, "seq" | "prevHash">): Promise<SignedRunLogEntry> {
    const all = this.readAll();
    const last = all[all.length - 1];
    const seq = last ? last.entry.seq + 1 : 0;
    // Chain to the prior entry's hash (ZERO_HASH for a fresh log's genesis entry).
    const prevHash = last ? last.hash : ZERO_HASH;
    const full: RunLogEntry = { ...entry, seq, prevHash };
    const hash = entryHash(full);
    const signature = await this.account.signMessage({ message: { raw: hash } });
    const signed: SignedRunLogEntry = {
      entry: full,
      hash,
      signature,
      signer: this.account.address,
    };
    fs.appendFileSync(this.file, JSON.stringify(signed) + "\n");
    return signed;
  }

  /** TOTAL tokens (input + output) ever spent on a wish/capability — drives the
   *  budget cap. Counting input too makes the cap a real ceiling: an input-heavy
   *  eval can't evade an output-only cap by never trips it. */
  tokensSpentOn(key: { capabilityId?: `0x${string}`; cell?: `0x${string}` }): number {
    return this.readAll()
      .filter(
        (e) =>
          (key.capabilityId && e.entry.capabilityId === key.capabilityId) ||
          (key.cell && e.entry.cell === key.cell),
      )
      .reduce((sum, e) => sum + e.entry.inputTokens + e.entry.outputTokens, 0);
  }
}
