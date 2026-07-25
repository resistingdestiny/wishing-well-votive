import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { conditionHash } from "../schema/story.js";

const StoredConditionSchema = z.object({
  conditionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  summary: z.string(),
  canonical: z.string().min(1),
});
export type StoredCondition = z.infer<typeof StoredConditionSchema>;

/**
 * Content-addressed store mapping conditionHash → canonical condition string.
 * On chain only the hash lives; the executor resolves it here to evaluate.
 * Wish creation (seeder now, web app in M4) writes entries.
 */
export class ConditionStore {
  private readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "conditions.json");
  }

  private readAll(): Record<string, StoredCondition> {
    if (!fs.existsSync(this.file)) return {};
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
    const out: Record<string, StoredCondition> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = StoredConditionSchema.parse(v);
    return out;
  }

  add(summary: string, canonical: string): StoredCondition {
    const hash = conditionHash(canonical);
    const all = this.readAll();
    const entry: StoredCondition = { conditionHash: hash, summary, canonical };
    all[hash] = entry;
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2));
    return entry;
  }

  get(hash: `0x${string}`): StoredCondition | undefined {
    return this.readAll()[hash];
  }
}
