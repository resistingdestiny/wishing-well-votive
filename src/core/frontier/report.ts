import type { SignedRunLogEntry } from "../runlog/verify.js";
import type { CapabilityCheckDetail } from "../sweep/streak.js";

export interface ModelState {
  model: string;
  provider: string;
  latestPass: boolean;
  everFailed: boolean;

  flipped: boolean;
  checks: number;
}

export interface CapabilityFrontier {
  capabilityId: `0x${string}`;
  summary?: string;
  checks: number;
  clearedByAny: boolean;

  sweepsToUnlock?: number;

  demand: number;
  models: ModelState[];
}

export interface Flip {
  capabilityId: `0x${string}`;
  summary?: string;
  model: string;
  atSeq: number;
}

export interface FrontierReport {
  generatedAtSeq: number;
  totals: {
    capabilities: number;
    cleared: number;
    backlog: number;
    models: number;
    checks: number;
    flips: number;
  };

  flips: Flip[];

  backlog: CapabilityFrontier[];

  cleared: CapabilityFrontier[];

  medianSweepsToUnlock: number | null;
  capabilities: CapabilityFrontier[];
}

function detail(d: unknown): CapabilityCheckDetail | undefined {
  return typeof d === "object" && d !== null && "passK" in d
    ? (d as CapabilityCheckDetail)
    : undefined;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function buildFrontierReport(
  entries: SignedRunLogEntry[],
  demandByCapability: Map<string, number> = new Map(),
): FrontierReport {
  const checks = entries
    .filter((e) => e.entry.kind === "capability-check" && e.entry.capabilityId)
    .sort((a, b) => a.entry.seq - b.entry.seq);

  const byCap = new Map<`0x${string}`, SignedRunLogEntry[]>();
  for (const e of checks) {
    const id = e.entry.capabilityId!;
    (byCap.get(id) ?? byCap.set(id, []).get(id)!).push(e);
  }

  const flips: Flip[] = [];
  const capabilities: CapabilityFrontier[] = [];

  for (const [capId, capChecks] of byCap) {
    const summary = capChecks.map((c) => detail(c.entry.detail)?.summary).find(Boolean);

    let sweepsToUnlock: number | undefined;
    for (let i = 0; i < capChecks.length; i++) {
      if (capChecks[i]!.entry.pass === true) {
        sweepsToUnlock = i + 1;
        break;
      }
    }

    const byModel = new Map<string, SignedRunLogEntry[]>();
    for (const c of capChecks) {
      (byModel.get(c.entry.model) ?? byModel.set(c.entry.model, []).get(c.entry.model)!).push(c);
    }
    const models: ModelState[] = [];
    for (const [model, mChecks] of byModel) {
      let everFailed = false;
      let sawPassAfterFail = false;
      let flipSeq: number | undefined;
      for (const c of mChecks) {
        if (c.entry.pass === false) everFailed = true;
        if (c.entry.pass === true && everFailed && !sawPassAfterFail) {
          sawPassAfterFail = true;
          flipSeq = c.entry.seq;
        }
      }
      const latest = mChecks[mChecks.length - 1]!;
      const latestPass = latest.entry.pass === true;
      const flipped = latestPass && everFailed;
      models.push({
        model,
        provider: latest.entry.provider,
        latestPass,
        everFailed,
        flipped,
        checks: mChecks.length,
      });
      if (flipped && flipSeq !== undefined) {
        flips.push({ capabilityId: capId, summary, model, atSeq: flipSeq });
      }
    }

    capabilities.push({
      capabilityId: capId,
      summary,
      checks: capChecks.length,
      clearedByAny: models.some((m) => m.latestPass),
      sweepsToUnlock,
      demand: demandByCapability.get(capId) ?? 0,
      models: models.sort((a, b) => a.model.localeCompare(b.model)),
    });
  }

  const byDemand = (a: CapabilityFrontier, b: CapabilityFrontier) =>
    b.demand - a.demand || b.checks - a.checks;
  const cleared = capabilities.filter((c) => c.clearedByAny).sort(byDemand);
  const backlog = capabilities.filter((c) => !c.clearedByAny).sort(byDemand);
  flips.sort((a, b) => b.atSeq - a.atSeq);

  const seqs = checks.map((c) => c.entry.seq);
  const models = new Set(checks.map((c) => c.entry.model));

  return {
    generatedAtSeq: seqs.length ? Math.max(...seqs) : -1,
    totals: {
      capabilities: capabilities.length,
      cleared: cleared.length,
      backlog: backlog.length,
      models: models.size,
      checks: checks.length,
      flips: flips.length,
    },
    flips,
    backlog,
    cleared,
    medianSweepsToUnlock: median(
      cleared.map((c) => c.sweepsToUnlock).filter((n): n is number => n !== undefined),
    ),
    capabilities: capabilities.sort(byDemand),
  };
}
