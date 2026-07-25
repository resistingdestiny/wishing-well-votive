import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { readSignedRunLog } from "@/lib/runlog";
import { buildFrontierReport } from "@/core/frontier/report";
import { computeCostRaw } from "@/core/models/costLedger";

export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",

  "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  const entries = readSignedRunLog();
  const grouped = await prisma.story
    .groupBy({ by: ["capabilityId"], _count: { _all: true } })
    .catch(() => [] as { capabilityId: string; _count: { _all: number } }[]);
  const demand = new Map(grouped.map((g) => [g.capabilityId, g._count._all]));
  const r = buildFrontierReport(entries, demand);
  const cost = computeCostRaw(
    entries.map((e) => ({
      model: e.entry.model,
      provider: e.entry.provider,
      inputTokens: e.entry.inputTokens,
      outputTokens: e.entry.outputTokens,
      capabilityId: e.entry.capabilityId,
    })),
  );

  const slim = (c: { capabilityId: string; summary?: string; demand: number; checks: number; sweepsToUnlock?: number }) => ({
    capabilityId: c.capabilityId,
    summary: c.summary ?? null,
    demand: c.demand,
    checks: c.checks,
    sweepsToUnlock: c.sweepsToUnlock ?? null,
  });

  return NextResponse.json(
    {
      source: "votive",
      generatedAtSeq: r.generatedAtSeq,
      totals: { ...r.totals, computeUsd: Number(cost.totalUsd.toFixed(4)) },
      medianSweepsToUnlock: r.medianSweepsToUnlock,
      flips: r.flips.slice(0, 12).map((f) => ({ capabilityId: f.capabilityId, summary: f.summary ?? null, model: f.model })),
      backlog: r.backlog.slice(0, 15).map(slim),
      cleared: r.cleared.slice(0, 15).map(slim),
      verify: "/bench",
      attribution: "Votive — https://wishing-well",
    },
    { headers: CORS },
  );
}
