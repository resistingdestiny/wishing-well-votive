import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { keccak256, toHex } from "viem";
import { ResourceSpecSchema, isActive, type ResourceSpec, type ResourceStatus } from "./resource.js";

const StoreShapeSchema = z.object({
  shared: z.array(ResourceSpecSchema).default([]),
  byCell: z.record(z.array(ResourceSpecSchema)).default({}),
});
type StoreShape = z.infer<typeof StoreShapeSchema>;

export function proposalId(name: string, provider: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "resource";
  const h = keccak256(toHex(`${slug}|${provider}`)).slice(2, 10);
  return `res/${slug}-${h}`;
}

export class ResourceStore {
  private readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "resources.json");
  }

  private read(): StoreShape {
    if (!fs.existsSync(this.file)) return { shared: [], byCell: {} };
    return StoreShapeSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
  }

  private write(s: StoreShape): void {
    fs.writeFileSync(this.file, JSON.stringify(s, null, 2) + "\n");
  }

  grant(cell: `0x${string}`, spec: Omit<ResourceSpec, "scope">): ResourceSpec {
    const key = cell.toLowerCase();
    const s = this.read();
    const full = ResourceSpecSchema.parse({ ...spec, scope: "wish" });
    const list = (s.byCell[key] ??= []);
    const idx = list.findIndex((r) => r.id === full.id);
    if (idx >= 0) list[idx] = full;
    else list.push(full);
    this.write(s);
    return full;
  }

  publishShared(spec: Omit<ResourceSpec, "scope">): ResourceSpec {
    const s = this.read();
    const full = ResourceSpecSchema.parse({ ...spec, scope: "shared" });
    const idx = s.shared.findIndex((r) => r.id === full.id);
    if (idx >= 0) s.shared[idx] = full;
    else s.shared.push(full);
    this.write(s);
    return full;
  }

  propose(spec: Omit<ResourceSpec, "scope" | "id" | "status"> & { provider: string }): ResourceSpec {
    const id = proposalId(spec.name, spec.provider);
    return this.publishShared({ ...spec, id, status: "pending" });
  }

  setStatus(id: string, status: ResourceStatus): ResourceSpec | null {
    const s = this.read();
    const r = s.shared.find((x) => x.id === id);
    if (!r) return null;
    r.status = status;
    this.write(s);
    return r;
  }

  forCell(cell: `0x${string}`): ResourceSpec[] {
    const s = this.read();
    const wish = s.byCell[cell.toLowerCase()] ?? [];
    return [...wish, ...s.shared].filter(isActive);
  }

  shared(): ResourceSpec[] {
    return this.read().shared;
  }

  cellGrants(cell: `0x${string}`): ResourceSpec[] {
    return this.read().byCell[cell.toLowerCase()] ?? [];
  }

  revoke(id: string): boolean {
    const s = this.read();
    let hit = false;
    const mark = (list: ResourceSpec[]) => {
      for (const r of list) if (r.id === id && !r.revoked) { r.revoked = true; hit = true; }
    };
    mark(s.shared);
    for (const list of Object.values(s.byCell)) mark(list);
    if (hit) this.write(s);
    return hit;
  }
}
