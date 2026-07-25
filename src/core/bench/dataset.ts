import { keccak256, toHex } from "viem";
import { verifyEntry, type SignedRunLogEntry } from "../runlog/verify.js";
import type { EvalSpec } from "../schema/story.js";
import type { ModelRegistry } from "../models/registry.js";
import { entryCostUsd } from "../models/costLedger.js";
import type { CapabilityCheckDetail } from "../sweep/streak.js";

export const BENCH_SCHEMA_VERSION = "wwbench/1";

export interface DatasetModelStat {
  model: string;
  provider: string;
  checks: number;
  passes: number;
  latestPass: boolean;
  latestPassRate?: number;
  latestStreak?: number;
  costUsd: number;
}

export interface CapabilityDataset {
  schemaVersion: string;
  capabilityId: `0x${string}`;
  summary?: string;

  eval?: EvalSpec;
  seqRange: { first: number; last: number; count: number };
  models: DatasetModelStat[];
  totals: {
    checks: number;
    passes: number;
    fails: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };

  records: SignedRunLogEntry[];

  contentHash: `0x${string}`;
}

function checkDetail(d: unknown): CapabilityCheckDetail | undefined {
  return typeof d === "object" && d !== null && "passK" in d
    ? (d as CapabilityCheckDetail)
    : undefined;
}

export function datasetContentHash(
  d: CapabilityDataset | Omit<CapabilityDataset, "contentHash">,
): `0x${string}` {
  const rest = { ...(d as CapabilityDataset) };
  delete (rest as Partial<CapabilityDataset>).contentHash;
  return keccak256(toHex(JSON.stringify(rest)));
}

export function buildCapabilityDataset(
  capabilityId: `0x${string}`,
  entries: SignedRunLogEntry[],
  opts: { summary?: string; eval?: EvalSpec; registry?: ModelRegistry } = {},
): CapabilityDataset {
  const records = entries
    .filter(
      (e) => e.entry.kind === "capability-check" && e.entry.capabilityId === capabilityId,
    )
    .sort((a, b) => a.entry.seq - b.entry.seq);

  const byModel = new Map<string, DatasetModelStat>();
  const totals = { checks: 0, passes: 0, fails: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const r of records) {
    const e = r.entry;
    const det = checkDetail(e.detail);
    const usd = entryCostUsd(e, opts.registry);
    totals.checks += 1;
    totals.passes += e.pass === true ? 1 : 0;
    totals.fails += e.pass === false ? 1 : 0;
    totals.inputTokens += e.inputTokens;
    totals.outputTokens += e.outputTokens;
    totals.costUsd += usd;

    const stat = byModel.get(e.model) ?? {
      model: e.model,
      provider: e.provider,
      checks: 0,
      passes: 0,
      latestPass: false,
      costUsd: 0,
    };
    stat.checks += 1;
    stat.passes += e.pass === true ? 1 : 0;
    stat.latestPass = e.pass === true;
    stat.latestPassRate = det?.passK.passRate ?? stat.latestPassRate;
    stat.latestStreak = det?.streak.count ?? stat.latestStreak;
    stat.costUsd += usd;
    byModel.set(e.model, stat);
  }

  const models = [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model));
  const seqs = records.map((r) => r.entry.seq);
  const base: Omit<CapabilityDataset, "contentHash"> = {
    schemaVersion: BENCH_SCHEMA_VERSION,
    capabilityId,
    summary: opts.summary,
    eval: opts.eval,
    seqRange: {
      first: seqs.length ? seqs[0]! : -1,
      last: seqs.length ? seqs[seqs.length - 1]! : -1,
      count: records.length,
    },
    models,
    totals,
    records,
  };
  return { ...base, contentHash: datasetContentHash(base) };
}

export interface DatasetVerification {

  contentHashOk: boolean;
  recordsValid: number;
  recordsTotal: number;
  ok: boolean;
}

export async function verifyDataset(d: CapabilityDataset): Promise<DatasetVerification> {

  const selfConsistent = datasetContentHash(d) === d.contentHash;

  const rebuilt = buildCapabilityDataset(d.capabilityId, d.records, {
    summary: d.summary,
    eval: d.eval,
  });
  const derivedFromRecords = rebuilt.contentHash === d.contentHash;
  const contentHashOk = selfConsistent && derivedFromRecords;
  let valid = 0;
  for (const r of d.records) {

    if (r.entry.kind !== "capability-check" || r.entry.capabilityId !== d.capabilityId) continue;
    if (await verifyEntry(r)) valid += 1;
  }
  return {
    contentHashOk,
    recordsValid: valid,
    recordsTotal: d.records.length,
    ok: contentHashOk && valid === d.records.length,
  };
}
