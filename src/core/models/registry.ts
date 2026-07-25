import fs from "node:fs";
import { z } from "zod";

/** Per-model USD rate (per million tokens); overrides the pricing tables. */
const ModelPricingSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
});

/**
 * Reference set of providers. Kept as an open string (not a literal) so the fleet
 * is genuinely provider-agnostic — a new provider slots in by naming it, and the
 * pricing/adapter layers key off the string. Known values documented for callers.
 */
export const KNOWN_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "meta",
  "mistral",
  "deepseek",
] as const;

const ModelSpecSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  displayName: z.string(),
  /** ISO date of public release; drives new-model sweep triggers. */
  released: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tier: z.enum(["frontier", "mid", "small"]),
  active: z.boolean(),
  /** Optional per-model USD pricing override (else the pricing tables apply). */
  pricing: ModelPricingSchema.optional(),
  /** 0G direct-broker path: the on-chain provider serving this model. */
  providerAddress: z.string().optional(),
  /** Enlisted solver agent's payout address (earns the perf-fee split when
   *  this model first opens a capability gate). */
  solverPayout: z.string().optional(),
  /** Who proposed this solver agent (address or handle), for the board. */
  proposedBy: z.string().optional(),
});

const ModelsFileSchema = z.object({
  comment: z.string().optional(),
  models: z.array(ModelSpecSchema),
});

export type ModelSpec = z.infer<typeof ModelSpecSchema>;

/**
 * Pluggable model registry backed by a JSON file. New models slot in by adding
 * an entry — the file is re-read on every access so a running sweep loop picks
 * up releases without a restart or code change.
 */
export class ModelRegistry {
  constructor(private readonly file: string) {}

  all(): ModelSpec[] {
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    return ModelsFileSchema.parse(raw).models;
  }

  active(): ModelSpec[] {
    return this.all().filter((m) => m.active);
  }

  get(id: string): ModelSpec | undefined {
    return this.all().find((m) => m.id === id);
  }

  has(id: string): boolean {
    return this.all().some((m) => m.id === id);
  }

  releasedAfter(isoDate: string): ModelSpec[] {
    return this.all().filter((m) => m.released > isoDate);
  }

  /**
   * Append a newly-released model to the registry file, preserving the file's
   * comment and existing order. Validates the whole file after the insert and
   * is a no-op if the id is already present — so the release watcher can call
   * it idempotently. Returns true if a new entry was written.
   */
  add(spec: ModelSpec): boolean {
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    const file = ModelsFileSchema.parse(raw);
    if (file.models.some((m) => m.id === spec.id)) return false;
    ModelSpecSchema.parse(spec);
    file.models.push(spec);
    ModelsFileSchema.parse(file); // guard against writing anything invalid
    fs.writeFileSync(this.file, JSON.stringify(file, null, 2) + "\n");
    return true;
  }
}
