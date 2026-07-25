import "server-only";
import path from "node:path";
import { formatEther } from "viem";
import { prisma } from "@/lib/db";
import { listAllCells, readCell, cellNumber } from "@/lib/chain";
import { readSignedRunLog } from "@/lib/runlog";
import { wishTag } from "@/lib/format";
import { buildFrontierReport } from "@/core/frontier/report";
import { ModelRegistry } from "@/core/models/registry";

interface V7BoardRow {
  capability: string;
  byModel: boolean[];
  wait: number;
  eth: string;
}
interface V7BoardModel {
  label: string;
  month: string;
}
interface V7Featured {
  tag: string;
  cell: string;
  story: string;
  parkedEth: string;
  parkedUsd: string | null;
  created: string;
  status: string;
  sweeps: number;
  latestSweep: { model: string; month: string; pass: boolean; evidence: string } | null;
}
export interface V7LandingData {
  openWishes: number;
  ethParked: string;
  sweepsRun: number;
  board: V7BoardRow[];
  boardModels: V7BoardModel[];
  boardTotals: { waiting: number; eth: string };
  openCapabilities: number;
  featured: V7Featured | null;
}

export const ZERO_LANDING: V7LandingData = {
  openWishes: 0,
  ethParked: "0",
  sweepsRun: 0,
  board: [],
  boardModels: [],
  boardTotals: { waiting: 0, eth: "0" },
  openCapabilities: 0,
  featured: null,
};

const USD_PER_ETH = 2000;

function ethStr(wei: bigint, dp = 3): string {
  const n = Number(formatEther(wei));
  if (n === 0) return "0";
  if (n < 0.001) return n.toFixed(4);
  return n.toFixed(dp).replace(/\.?0+$/, "");
}

function monthYear(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 7)}-15T00:00:00Z`);
  return d.toLocaleString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }).toLowerCase();
}

export async function computeLandingData(): Promise<V7LandingData> {

  let openWishes = 0;
  let parkedTotal = 0n;
  const parkedByCell = new Map<string, bigint>();
  try {
    const cells = await listAllCells();
    const views = await Promise.all(
      cells.map((c: { address: `0x${string}` }) => readCell(c.address).catch(() => null)),
    );
    for (const v of views) {
      if (!v) continue;
      if (v.state === 1 || v.state === 2) openWishes += 1;
      parkedTotal += v.parked;
      parkedByCell.set(v.address.toLowerCase(), v.parked);
    }
  } catch {

  }

  const entries = readSignedRunLog();
  const grouped = await prisma.story
    .groupBy({ by: ["capabilityId"], _count: { _all: true } })
    .catch(() => [] as { capabilityId: string; _count: { _all: number } }[]);
  const demand = new Map(grouped.map((g) => [g.capabilityId, g._count._all]));
  const report = buildFrontierReport(entries, demand);
  const allModels = [
    ...new Set(report.capabilities.flatMap((c) => c.models.map((m) => m.model))),
  ].sort();

  const checks = entries.filter(
    (e) => e.entry.kind === "capability-check" && e.entry.capabilityId,
  );
  const perPair = new Map<string, number>();
  for (const e of checks) {
    const k = `${e.entry.capabilityId}|${e.entry.model}`;
    perPair.set(k, (perPair.get(k) ?? 0) + 1);
  }
  const sweepsRun = perPair.size ? Math.max(...perPair.values()) : 0;

  const stories = await prisma.story.findMany().catch(() => []);
  const cellsByCap = new Map<string, string[]>();
  for (const s of stories) {
    if (!s.cell) continue;
    const list = cellsByCap.get(s.capabilityId) ?? [];
    list.push(s.cell.toLowerCase());
    cellsByCap.set(s.capabilityId, list);
  }
  const parkedForCap = (capId: string) =>
    (cellsByCap.get(capId) ?? []).reduce((sum, c) => sum + (parkedByCell.get(c) ?? 0n), 0n);

  let boardModels: V7BoardModel[] = [];
  try {
    const p = process.env.WELL_MODELS_FILE ?? path.resolve(process.cwd(), "..", "agent", "models.json");
    const byId = new Map(new ModelRegistry(p).all().map((s) => [s.id, s]));
    boardModels = allModels.slice(0, 4).map((id) => {
      const spec = byId.get(id);
      return {
        label: spec?.displayName ?? id,
        month: monthYear(spec?.released),
      };
    });
  } catch {
    boardModels = [];
  }

  const board: V7BoardRow[] = [...report.backlog, ...report.cleared].slice(0, 8).map((c) => ({
    capability: c.summary ?? c.capabilityId.slice(0, 14),
    byModel: allModels.slice(0, 4).map((m) => c.models.some((x) => x.model === m && x.latestPass)),
    wait: c.demand,
    eth: ethStr(parkedForCap(c.capabilityId), 2),
  }));

  const feat = await prisma.story
    .findFirst({ where: { featured: true, cell: { not: null } }, orderBy: { createdAt: "desc" } })
    .catch(() => null);
  let featured: V7Featured | null = null;
  if (feat?.cell) {
    const cellAddr = feat.cell as `0x${string}`;
    const parked = parkedByCell.get(feat.cell.toLowerCase()) ?? 0n;
    const parkedEthNum = Number(formatEther(parked));
    const [num, view] = await Promise.all([
      cellNumber(cellAddr).catch(() => 0),
      readCell(cellAddr).catch(() => null),
    ]);
    const capEntries = checks.filter((e) => e.entry.capabilityId === feat.capabilityId);
    const last = capEntries[capEntries.length - 1]?.entry;
    featured = {
      tag: wishTag(num, cellAddr),
      cell: cellAddr,
      story: feat.prose,
      parkedEth: ethStr(parked),
      parkedUsd:
        parked > 0n
          ? `≈ $${Math.round(parkedEthNum * USD_PER_ETH).toLocaleString("en-US")}`
          : null,
      created: new Date(feat.createdAt).toLocaleString("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).toLowerCase(),
      status: (view?.stateName ?? "waiting").toLowerCase(),
      sweeps: capEntries.length,
      latestSweep: last
          ? {
              model: last.model,
              month: monthYear(last.ts.slice(0, 10)),
              pass: last.pass === true,
              evidence:
                typeof (last.detail as { evidence?: unknown })?.evidence === "string"
                  ? ((last.detail as { evidence: string }).evidence.slice(0, 140) as string)
                  : "",
            }
          : null,
    };
  }

  return {
    openWishes,
    ethParked: ethStr(parkedTotal),
    sweepsRun,
    board,
    boardModels,
    boardTotals: { waiting: openWishes, eth: ethStr(parkedTotal) },
    openCapabilities: report.backlog.length,
    featured,
  };
}
