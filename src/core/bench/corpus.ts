import { keccak256, toHex } from "viem";
import type { SignedRunLogEntry } from "../runlog/verify.js";
import type { ModelRegistry } from "../models/registry.js";
import type { CapabilityStore } from "../sweep/capabilityStore.js";
import { entryCostUsd } from "../models/costLedger.js";
import { buildCapabilityDataset } from "./dataset.js";
import type { CapabilityCheckDetail } from "../sweep/streak.js";

export const BENCH_CORPUS_VERSION = "wwbench-corpus/1";
export const BENCH_LICENSE = "CC-BY-4.0";

export interface CorpusRow {
  capabilityId: `0x${string}`;
  capabilitySummary?: string;
  model: string;
  provider: string;
  seq: number;
  ts: string;
  pass: boolean | null;
  passRate: number | null;
  wilsonLower: number | null;
  cleared: boolean | null;
  streak: number | null;
  satisfied: boolean | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  hash: `0x${string}`;
  signature: `0x${string}`;
  signer: `0x${string}`;
  prevHash: `0x${string}` | null;
}

export interface CorpusCapability {
  capabilityId: `0x${string}`;
  summary?: string;
  contentHash: `0x${string}`;
  checks: number;
}

export interface BenchCorpus {
  schemaVersion: string;
  version: string;
  license: string;
  generatedAtSeq: number;
  totals: {
    capabilities: number;
    checks: number;
    passes: number;
    fails: number;
    models: number;
    providers: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    firstTs: string | null;
    lastTs: string | null;
  };
  models: string[];
  providers: string[];

  capabilities: CorpusCapability[];

  corpusHash: `0x${string}`;
}

function detail(d: unknown): CapabilityCheckDetail | undefined {
  return typeof d === "object" && d !== null && "passK" in d
    ? (d as CapabilityCheckDetail)
    : undefined;
}

export function corpusRows(
  entries: SignedRunLogEntry[],
  opts: { registry?: ModelRegistry; summaries?: Map<string, string> } = {},
): CorpusRow[] {
  return entries
    .filter((e) => e.entry.kind === "capability-check" && e.entry.capabilityId)
    .sort((a, b) => a.entry.seq - b.entry.seq)
    .map((e) => {
      const d = detail(e.entry.detail);
      return {
        capabilityId: e.entry.capabilityId!,
        capabilitySummary: opts.summaries?.get(e.entry.capabilityId!) ?? d?.summary,
        model: e.entry.model,
        provider: e.entry.provider,
        seq: e.entry.seq,
        ts: e.entry.ts,
        pass: e.entry.pass ?? null,
        passRate: d?.passK.passRate ?? null,
        wilsonLower: d?.passK.wilsonLower ?? null,
        cleared: d?.passK.cleared ?? null,
        streak: d?.streak.count ?? null,
        satisfied: d?.streak.satisfied ?? null,
        inputTokens: e.entry.inputTokens,
        outputTokens: e.entry.outputTokens,
        costUsd: entryCostUsd(e.entry, opts.registry),
        hash: e.hash,
        signature: e.signature,
        signer: e.signer,
        prevHash: e.entry.prevHash ?? null,
      };
    });
}

export function buildCorpus(
  entries: SignedRunLogEntry[],
  opts: { store?: CapabilityStore; registry?: ModelRegistry; version?: string } = {},
): BenchCorpus {
  const checks = entries.filter(
    (e) => e.entry.kind === "capability-check" && e.entry.capabilityId,
  );
  const capIds = [...new Set(checks.map((e) => e.entry.capabilityId!))].sort();

  const capabilities: CorpusCapability[] = capIds.map((capId) => {
    const stored = opts.store?.get(capId);
    const ds = buildCapabilityDataset(capId, entries, {
      summary: stored?.summary,
      eval: stored?.eval,
      registry: opts.registry,
    });
    return {
      capabilityId: capId,
      summary: stored?.summary,
      contentHash: ds.contentHash,
      checks: ds.records.length,
    };
  });

  const models = [...new Set(checks.map((e) => e.entry.model))].sort();
  const providers = [...new Set(checks.map((e) => e.entry.provider))].sort();
  const seqs = checks.map((e) => e.entry.seq);
  const tss = checks.map((e) => e.entry.ts).sort();
  const totals = {
    capabilities: capabilities.length,
    checks: checks.length,
    passes: checks.filter((e) => e.entry.pass === true).length,
    fails: checks.filter((e) => e.entry.pass === false).length,
    models: models.length,
    providers: providers.length,
    inputTokens: checks.reduce((s, e) => s + e.entry.inputTokens, 0),
    outputTokens: checks.reduce((s, e) => s + e.entry.outputTokens, 0),
    costUsd: checks.reduce((s, e) => s + entryCostUsd(e.entry, opts.registry), 0),
    firstTs: tss[0] ?? null,
    lastTs: tss[tss.length - 1] ?? null,
  };

  const base = {
    schemaVersion: BENCH_CORPUS_VERSION,
    version: opts.version ?? BENCH_CORPUS_VERSION,
    license: BENCH_LICENSE,
    generatedAtSeq: seqs.length ? Math.max(...seqs) : -1,
    totals,
    models,
    providers,
    capabilities,
  };
  return { ...base, corpusHash: corpusContentHash(base) };
}

export function corpusContentHash(
  c: Omit<BenchCorpus, "corpusHash">,
): `0x${string}` {
  return keccak256(
    toHex(
      JSON.stringify({
        schemaVersion: c.schemaVersion,
        version: c.version,
        generatedAtSeq: c.generatedAtSeq,
        totals: c.totals,
        models: c.models,
        providers: c.providers,
        capabilities: c.capabilities.map((cap) => ({
          capabilityId: cap.capabilityId,
          contentHash: cap.contentHash,
          checks: cap.checks,
        })),
      }),
    ),
  );
}

export function verifyCorpus(c: BenchCorpus): boolean {
  return corpusContentHash(c) === c.corpusHash;
}

export function rowsToJsonl(rows: CorpusRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

const CSV_COLUMNS: (keyof CorpusRow)[] = [
  "capabilityId", "capabilitySummary", "model", "provider", "seq", "ts", "pass",
  "passRate", "wilsonLower", "cleared", "streak", "satisfied", "inputTokens",
  "outputTokens", "costUsd", "hash", "signature", "signer", "prevHash",
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows: CorpusRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const body = rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(","));
  return [header, ...body].join("\n") + "\n";
}

export function datasheet(corpus: BenchCorpus): string {
  const t = corpus.totals;
  return `# Wishing Well Bench

**Version:** \`${corpus.version}\` · **Content address:** \`${corpus.corpusHash}\` · **License:** ${corpus.license}

A dated, capital-weighted, signature-provable record of what AI models can and can
not do — assembled from the wishes people actually funded. Each row is one
capability check (K independent pass@k trials, Wilson-gated, three-consecutive-sweeps
verdict) recorded the moment it happened.

## Provenance & what's proven
Every row is a run-log entry **signed by the oracle** when the sweep ran, and each
verdict was **attested on chain** with the row's keccak as the evidence hash — so a
row's content and timestamp are anchored, not asserted, and cannot be fabricated
without the oracle key. In the *full* run log each entry is also **hash-chained to its
predecessor**, so nothing can be inserted, edited, or reordered undetected (verify with
the in-browser verifier over the complete log). NOTE: this corpus is a per-capability
*slice* of that log, so it proves each row is oracle-signed + on-chain-attested, but by
itself it does **not** prove no rows were dropped — run the whole-log chain verifier for
completeness. The \`contentHash\`/\`corpusHash\` commit to exactly the rows + totals shown.

## How to verify a row
1. Recompute \`keccak256\` of the canonical entry → must equal \`hash\`.
2. \`ecrecover(hash, signature)\` → must equal \`signer\` (the oracle).
3. Look up the on-chain \`attestCapability\` event whose evidence hash == \`hash\`.

## Contents
- **${t.capabilities}** capabilities · **${t.checks}** checks (${t.passes} pass / ${t.fails} fail)
- **${t.models}** models across **${t.providers}** providers: ${corpus.models.join(", ")}
- Window: ${t.firstTs ?? "—"} → ${t.lastTs ?? "—"}
- Compute spent proving the frontier: **$${t.costUsd.toFixed(2)}** (${t.inputTokens} in / ${t.outputTokens} out tokens)

## Files
- \`corpus.jsonl\` — one verifiable row per line
- \`corpus.csv\` — same, columnar (\`import pandas; pandas.read_csv("corpus.csv").to_parquet("corpus.parquet")\`)
- \`datasheet.md\` — this file
- \`/api/bench/<capabilityId>\` — the full per-capability dataset (transcripts + content hash)

## Row schema
${CSV_COLUMNS.map((c) => `- \`${c}\``).join("\n")}
`;
}
