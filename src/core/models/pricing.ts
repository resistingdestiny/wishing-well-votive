/**
 * Per-model USD pricing — reference list prices, NOT a live feed (no paid API
 * call, no vendor). A model can override its rate in `models.json` via the
 * optional `pricing` field; otherwise we fall back to the model-id table, then a
 * tier default, then a conservative catch-all. Rates are USD per MILLION tokens,
 * the industry-standard quote unit, so the numbers here read like a price sheet.
 */

export interface ModelPricing {
  /** USD per million input (prompt) tokens. */
  inputPerMTok: number;
  /** USD per million output (completion) tokens. */
  outputPerMTok: number;
}

export type Tier = "frontier" | "mid" | "small";

/**
 * Known-model list prices (USD / MTok). Extend when a model is priced; an unknown
 * id degrades to the tier table so a fresh release still gets a sane estimate
 * before anyone reprices it.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-8": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-fable-5": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 0.8, outputPerMTok: 4 },
  // Representative non-Anthropic entries so the ledger is provider-agnostic out of
  // the box (still just static reference data — using these models needs a key).
  "gpt-5": { inputPerMTok: 10, outputPerMTok: 30 },
  "gpt-5-mini": { inputPerMTok: 0.5, outputPerMTok: 2 },
  "gemini-3-pro": { inputPerMTok: 7, outputPerMTok: 21 },
  "grok-4": { inputPerMTok: 5, outputPerMTok: 15 },
  "deepseek-v4": { inputPerMTok: 0.5, outputPerMTok: 1.5 },
};

/** Fallback by coarse tier when a model id is not in the table above. */
export const TIER_PRICING: Record<Tier, ModelPricing> = {
  frontier: { inputPerMTok: 15, outputPerMTok: 75 },
  mid: { inputPerMTok: 3, outputPerMTok: 15 },
  small: { inputPerMTok: 0.8, outputPerMTok: 4 },
};

/** Last resort when neither id nor tier is known. */
export const FALLBACK_PRICING: ModelPricing = { inputPerMTok: 5, outputPerMTok: 15 };

export interface Priceable {
  id?: string;
  tier?: Tier;
  /** Per-model override from the registry (`models.json`). Wins over the tables. */
  pricing?: ModelPricing;
}

/** Resolve a rate: explicit override → model-id table → tier default → fallback. */
export function priceFor(m: Priceable): ModelPricing {
  if (m.pricing) return m.pricing;
  if (m.id && MODEL_PRICING[m.id]) return MODEL_PRICING[m.id]!;
  if (m.tier && TIER_PRICING[m.tier]) return TIER_PRICING[m.tier]!;
  return FALLBACK_PRICING;
}

/** USD cost of a token spend at a given rate. */
export function costUsd(
  p: ModelPricing,
  inputTokens: number,
  outputTokens: number,
): number {
  return (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
}

/** Convenience: cost for a model spec/id in one call (degrades gracefully). */
export function costForModel(
  m: Priceable,
  inputTokens: number,
  outputTokens: number,
): number {
  return costUsd(priceFor(m), inputTokens, outputTokens);
}

/** Compact human money string; keeps sub-cent amounts legible on the board. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
