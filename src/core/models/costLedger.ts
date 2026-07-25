/**
 * USD cost ledger derived from the signed run log. Every capability check and
 * fulfilment attempt already records input/output token counts; this turns those
 * counts into dollars using the pricing table (per-model override → id → tier →
 * fallback), so the board can show "compute spent on the frontier" and the sweep
 * can enforce a real per-wish dollar cap on top of the token cap.
 */

import type { RunLogEntry, SignedRunLogEntry } from "../runlog/runlog.js";
import type { ModelRegistry } from "./registry.js";
import { priceFor, costUsd } from "./pricing.js";

export interface CostBucket {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** Number of run-log entries that spent tokens in this bucket. */
  entries: number;
}

export interface CostBreakdown {
  totalUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  entries: number;
  byModel: Record<string, CostBucket>;
  byProvider: Record<string, CostBucket>;
  byCapability: Record<string, CostBucket>;
}

/**
 * Price a single entry. A registry (if supplied) lets a model's `pricing`
 * override + tier inform the rate; without one we price by model id alone, which
 * still covers every model in the pricing table (used web-side, no file access).
 */
export function entryCostUsd(
  entry: Pick<RunLogEntry, "model" | "inputTokens" | "outputTokens">,
  registry?: ModelRegistry,
): number {
  const spec = registry?.get(entry.model);
  return costUsd(
    priceFor({ id: entry.model, tier: spec?.tier, pricing: spec?.pricing }),
    entry.inputTokens,
    entry.outputTokens,
  );
}

function bump(
  buckets: Record<string, CostBucket>,
  key: string,
  usd: number,
  inTok: number,
  outTok: number,
): void {
  const b = (buckets[key] ??= { usd: 0, inputTokens: 0, outputTokens: 0, entries: 0 });
  b.usd += usd;
  b.inputTokens += inTok;
  b.outputTokens += outTok;
  b.entries += 1;
}

/** Minimal entry shape the ledger needs — matches both the agent's run-log entry
 *  and the web's Prisma `RunEntry` row, so the board can reuse this directly. */
export interface CostableEntry {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  capabilityId?: string | null;
}

/** Aggregate a list of raw entries into a USD breakdown (web + agent share this). */
export function computeCostRaw(
  entries: CostableEntry[],
  registry?: ModelRegistry,
): CostBreakdown {
  const out: CostBreakdown = {
    totalUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    entries: 0,
    byModel: {},
    byProvider: {},
    byCapability: {},
  };
  for (const entry of entries) {
    if (entry.inputTokens === 0 && entry.outputTokens === 0) continue; // skip refusals/notes
    const usd = entryCostUsd(entry, registry);
    out.totalUsd += usd;
    out.totalInputTokens += entry.inputTokens;
    out.totalOutputTokens += entry.outputTokens;
    out.entries += 1;
    bump(out.byModel, entry.model, usd, entry.inputTokens, entry.outputTokens);
    bump(out.byProvider, entry.provider, usd, entry.inputTokens, entry.outputTokens);
    if (entry.capabilityId) {
      bump(out.byCapability, entry.capabilityId, usd, entry.inputTokens, entry.outputTokens);
    }
  }
  return out;
}

/** Aggregate the whole (or a filtered) signed run log into a USD breakdown. */
export function computeCost(
  signed: SignedRunLogEntry[],
  registry?: ModelRegistry,
): CostBreakdown {
  return computeCostRaw(
    signed.map((s) => s.entry),
    registry,
  );
}

/**
 * USD ever spent on a wish/capability — the dollar analog of
 * `RunLog.tokensSpentOn`, used to enforce the optional per-wish USD budget cap.
 */
export function usdSpentOn(
  signed: SignedRunLogEntry[],
  key: { capabilityId?: `0x${string}`; cell?: `0x${string}` },
  registry?: ModelRegistry,
): number {
  return signed
    .filter(
      (e) =>
        (key.capabilityId && e.entry.capabilityId === key.capabilityId) ||
        (key.cell && e.entry.cell === key.cell),
    )
    .reduce((sum, e) => sum + entryCostUsd(e.entry, registry), 0);
}
