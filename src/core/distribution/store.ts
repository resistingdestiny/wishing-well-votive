import fs from "node:fs";
import path from "node:path";
import type { Hex } from "viem";
import type { DistributionTree } from "./merkle.js";

/** A posted distribution's claim data, persisted so recipients can pull proofs. */
export interface StoredDistribution {
  cell: `0x${string}`;
  asset: `0x${string}`;
  root: Hex;
  totalWeight: string; // bigint as decimal string
  snapshotBlock: string;
  claims: {
    index: number;
    account: `0x${string}`;
    weight: string;
    proof: Hex[];
  }[];
}

/**
 * File-backed store of posted DistributeToActive snapshots (root + per-recipient
 * proofs), keyed by cell. On chain only the root lives; recipients resolve their
 * proof here to call claimDistribution. Written by the executor when it posts a
 * distribution; read by the web claim path.
 */
export class DistributionStore {
  private readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "distributions.json");
  }

  private readAll(): Record<string, StoredDistribution> {
    if (!fs.existsSync(this.file)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, StoredDistribution>;
    } catch {
      return {};
    }
  }

  save(
    cell: `0x${string}`,
    asset: `0x${string}`,
    snapshotBlock: bigint,
    tree: DistributionTree,
  ): StoredDistribution {
    const entry: StoredDistribution = {
      cell,
      asset,
      root: tree.root,
      totalWeight: tree.totalWeight.toString(),
      snapshotBlock: snapshotBlock.toString(),
      claims: tree.leaves.map((l) => ({
        index: l.index,
        account: l.account,
        weight: l.weight.toString(),
        proof: tree.proofs[l.index] ?? [],
      })),
    };
    const all = this.readAll();
    all[cell.toLowerCase()] = entry;
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2));
    return entry;
  }

  get(cell: `0x${string}`): StoredDistribution | undefined {
    return this.readAll()[cell.toLowerCase()];
  }
}
