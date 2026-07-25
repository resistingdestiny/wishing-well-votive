import { NextResponse } from "next/server";
import { formatUnits } from "viem";
import { graphMarketplace, graphWellStats } from "@/lib/graph";

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
  const [stats, market] = await Promise.all([graphWellStats(), graphMarketplace()]);
  if (!stats && !market) {
    return NextResponse.json(
      {
        configured: false,
        note: "subgraph not configured (WELL_GRAPH_URL unset) — the marketplace read API is subgraph-backed",
      },
      { status: 200, headers: CORS },
    );
  }

  const usdc = (v: bigint) => Number(formatUnits(v, 6));

  const body = {
    configured: true,
    block: market?.block ?? stats?.block ?? null,

    demand: stats
      ? {
          open: stats.activeCount,
          fulfilled: stats.fulfilledCount,
          amended: stats.amendedCount,
          escheated: stats.escheatedCount,
          totalPrincipalCommitted: stats.totalPrincipal.toString(),
        }
      : null,

    intelligence: market
      ? {
          solverCount: market.solverCount,
          solverFeesPaidUsdc: usdc(market.totalSolverFeesPaid),
          topSolvers: market.topSolvers,
        }
      : null,

    resources: market
      ? {
          resourceFeesPaidUsdc: usdc(market.totalResourceFeesPaid),
          pool: market.pool
            ? {
                address: market.pool.address,
                totalDepositedUsdc: usdc(market.pool.totalDeposited),
                totalWithdrawnUsdc: usdc(market.pool.totalWithdrawn),
                totalRevenueUsdc: usdc(market.pool.totalRevenue),
                depositorCount: market.pool.depositorCount,
              }
            : null,
        }
      : null,
    attestations: stats?.attestationCount ?? null,
  };
  return NextResponse.json(body, { status: 200, headers: CORS });
}
