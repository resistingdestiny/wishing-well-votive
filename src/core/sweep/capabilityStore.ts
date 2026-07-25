import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { EvalSpecSchema, type EvalSpec, capabilityId } from "../schema/story.js";

const StoredCapabilitySchema = z.object({
  capabilityId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  summary: z.string(),
  eval: EvalSpecSchema,
});
export type StoredCapability = z.infer<typeof StoredCapabilitySchema>;

/**
 * Off-chain side of the CapabilityRegistry: maps capabilityId → executable
 * eval spec. On chain only the id (keccak of the canonical spec) lives; this
 * store holds the specs the sweep loop compiles and runs. Wish creation
 * (seeder now, web app in M4) writes entries here.
 */
export class CapabilityStore {
  private readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "capabilities.json");
  }

  private readAll(): Record<string, StoredCapability> {
    if (!fs.existsSync(this.file)) return {};
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
    const out: Record<string, StoredCapability> = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = StoredCapabilitySchema.parse(v);
    }
    return out;
  }

  add(summary: string, spec: EvalSpec): StoredCapability {
    const id = capabilityId(spec);
    const all = this.readAll();
    const entry: StoredCapability = { capabilityId: id, summary, eval: spec };
    all[id] = entry;
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2));
    return entry;
  }

  get(id: `0x${string}`): StoredCapability | undefined {
    return this.readAll()[id];
  }
}
