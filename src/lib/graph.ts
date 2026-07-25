const TIMEOUT_MS = 8_000;

export async function graphQuery<T>(
  gql: string,
  variables?: Record<string, unknown>,
): Promise<T | null> {
  const url = process.env.WELL_GRAPH_URL;
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: gql, variables: variables ?? {} }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: T; errors?: unknown[] };
    if (!body.data || (body.errors && body.errors.length > 0)) return null;
    return body.data;
  } catch {
    return null;
  }
}

export interface GraphWellStats {
  block: number;
  wishCount: number;
  activeCount: number;
  fulfilledCount: number;
  amendedCount: number;
  escheatedCount: number;
  attestationCount: number;
  totalStreamFeesCollected: bigint;
  totalPerfFeesTaken: bigint;
  totalPrincipal: bigint;
}

export async function graphWellStats(): Promise<GraphWellStats | null> {
  const data = await graphQuery<{
    _meta?: { block?: { number?: number } };
    well?: {
      wishCount: string;
      activeCount: string;
      fulfilledCount: string;
      amendedCount: string;
      escheatedCount: string;
      attestationCount: string;
      totalStreamFeesCollected: string;
      totalPerfFeesTaken: string;
      totalPrincipal: string;
    } | null;
  }>(
    `query WellStats {
      _meta { block { number } }
      well(id: "well") {
        wishCount activeCount fulfilledCount amendedCount escheatedCount
        attestationCount totalStreamFeesCollected totalPerfFeesTaken totalPrincipal
      }
    }`,
  );
  const w = data?.well;
  if (!w || typeof data?._meta?.block?.number !== "number") return null;
  try {
    return {
      block: data._meta.block.number,
      wishCount: Number(w.wishCount),
      activeCount: Number(w.activeCount),
      fulfilledCount: Number(w.fulfilledCount),
      amendedCount: Number(w.amendedCount),
      escheatedCount: Number(w.escheatedCount),
      attestationCount: Number(w.attestationCount),
      totalStreamFeesCollected: BigInt(w.totalStreamFeesCollected),
      totalPerfFeesTaken: BigInt(w.totalPerfFeesTaken),
      totalPrincipal: BigInt(w.totalPrincipal),
    };
  } catch {
    return null;
  }
}

export interface GraphLiveCounts {
  block: number;
  waiting: number;
  attempting: number;
  fulfilled: number;

  parked: bigint;
}

export async function graphLiveCounts(): Promise<GraphLiveCounts | null> {
  const data = await graphQuery<{
    _meta?: { block?: { number?: number } };
    well?: { fulfilledCount: string } | null;
    wishes?: { state: string; principal: string; streamFeesAccrued: string }[];
  }>(
    `query AskCounts {
      _meta { block { number } }
      well(id: "well") { fulfilledCount }
      wishes(where: { state_in: [Waiting, Attempting] }, first: 1000) {
        state principal streamFeesAccrued
      }
    }`,
  );
  if (!data?.wishes || typeof data._meta?.block?.number !== "number") return null;
  try {
    let parked = 0n;
    let waiting = 0;
    let attempting = 0;
    for (const w of data.wishes) {
      parked += BigInt(w.principal) - BigInt(w.streamFeesAccrued);
      if (w.state === "Attempting") attempting += 1;
      else waiting += 1;
    }
    return {
      block: data._meta.block.number,
      waiting,
      attempting,
      fulfilled: Number(data.well?.fulfilledCount ?? 0),
      parked,
    };
  } catch {
    return null;
  }
}

export interface GraphFlip {
  capabilityId: string;
  modelId: string;
  flippedAt: number;
  pass: boolean;
}

export async function graphRecentFlips(limit = 8): Promise<GraphFlip[] | null> {
  const data = await graphQuery<{
    modelCapabilities?: {
      modelId: string;
      flippedAt: string | null;
      pass: boolean;
      capability: { id: string };
    }[];
  }>(
    `query WhatMoved($limit: Int!) {
      modelCapabilities(
        where: { flippedAt_not: null }
        orderBy: flippedAt
        orderDirection: desc
        first: $limit
      ) {
        modelId
        flippedAt
        pass
        capability { id }
      }
    }`,
    { limit },
  );
  if (!data?.modelCapabilities) return null;
  return data.modelCapabilities
    .filter((m) => m.flippedAt !== null)
    .map((m) => ({
      capabilityId: m.capability.id,
      modelId: m.modelId,
      flippedAt: Number(m.flippedAt),
      pass: m.pass,
    }));
}

export interface GraphTimelineEvent {
  id: string;
  at: number;
  tx: string;
  label: string;
  detail: string;
}

export interface GraphWishTimeline {
  block: number;
  events: GraphTimelineEvent[];
}

interface TimelineRows {
  _meta?: { block?: { number?: number } };
  wish?: {
    transitions: { id: string; from: string; to: string; trigger: string; at: string; tx: string }[];
    feeEvents: { id: string; kind: string; amount: string; at: string; tx: string }[];
    payouts: { id: string; kind: string; to: string; amount: string; at: string; tx: string }[];
    contributions: { id: string; kind: string; from: string; amount: string; at: string; tx: string }[];
    conditionAttestations: { id: string; pass: boolean; at: string; tx: string }[];
  } | null;
}

const FEE_LABEL: Record<string, string> = {
  STREAM_ACCRUED: "2%/yr stream fee accrued",
  STREAM_COLLECTED: "Stream fee collected by platform",
  PERF_TAKEN: "8% performance fee taken",
};

const PAYOUT_LABEL: Record<string, string> = {
  AMEND: "Amendment payout",
  ESCHEAT: "Escheat payout",
  DISTRIBUTION_CLAIMED: "Distribution share claimed",
  DISTRIBUTION_SWEPT: "Unclaimed distribution swept",
  OWED_FALLBACK: "Push failed — recorded as owed",
  OWED_CLAIMED: "Owed balance claimed",
  STRAY_RECOVERED: "Stray funds swept to wisher",
};

export async function graphWishTimeline(
  cell: string,
): Promise<GraphWishTimeline | null> {
  const data = await graphQuery<TimelineRows>(
    `query WishTimeline($id: ID!) {
      _meta { block { number } }
      wish(id: $id) {
        transitions(orderBy: at, orderDirection: desc, first: 50) {
          id from to trigger at tx
        }
        feeEvents(orderBy: at, orderDirection: desc, first: 50) {
          id kind amount at tx
        }
        payouts(orderBy: at, orderDirection: desc, first: 50) {
          id kind to amount at tx
        }
        contributions(orderBy: at, orderDirection: desc, first: 50) {
          id kind from amount at tx
        }
        conditionAttestations(orderBy: at, orderDirection: desc, first: 20) {
          id pass at tx
        }
      }
    }`,
    { id: cell.toLowerCase() },
  );
  const w = data?.wish;
  if (!w || typeof data?._meta?.block?.number !== "number") return null;

  const { formatEther } = await import("viem");
  const fmt = (weiStr: string): string => {
    try {
      const n = Number(formatEther(BigInt(weiStr)));
      return `${n.toLocaleString("en-GB", { maximumFractionDigits: 6 })} ETH`;
    } catch {
      return "";
    }
  };
  const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

  const events: GraphTimelineEvent[] = [];
  try {
    for (const t of w.transitions) {
      events.push({
        id: t.id,
        at: Number(t.at),
        tx: t.tx,
        label: `${t.from} → ${t.to}`,
        detail: t.trigger,
      });
    }
    for (const f of w.feeEvents) {
      events.push({
        id: f.id,
        at: Number(f.at),
        tx: f.tx,
        label: FEE_LABEL[f.kind] ?? f.kind,
        detail: fmt(f.amount),
      });
    }
    for (const p of w.payouts) {
      events.push({
        id: p.id,
        at: Number(p.at),
        tx: p.tx,
        label: PAYOUT_LABEL[p.kind] ?? p.kind,
        detail: `${fmt(p.amount)} → ${short(p.to)}`,
      });
    }
    for (const c of w.contributions) {
      events.push({
        id: c.id,
        at: Number(c.at),
        tx: c.tx,
        label: c.kind === "TOPUP" ? "Principal topped up" : "Donation received",
        detail: `${fmt(c.amount)} from ${short(c.from)}`,
      });
    }
    for (const a of w.conditionAttestations) {
      events.push({
        id: a.id,
        at: Number(a.at),
        tx: a.tx,
        label: "Resolution condition attested",
        detail: a.pass ? "met" : "not met",
      });
    }
  } catch {
    return null;
  }
  events.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  return { block: data._meta.block.number, events };
}

export interface GraphMarketplace {
  block: number;

  solverCount: number;
  totalSolverFeesPaid: bigint;
  topSolvers: {
    modelId: string;
    payout: string;
    capabilitiesOpened: number;
  }[];

  totalResourceFeesPaid: bigint;
  pool: {
    address: string;
    totalDeposited: bigint;
    totalWithdrawn: bigint;
    totalRevenue: bigint;
    depositorCount: number;
  } | null;
}

export async function graphMarketplace(): Promise<GraphMarketplace | null> {
  const data = await graphQuery<{
    _meta?: { block?: { number?: number } };
    well?: {
      solverCount: string;
      totalSolverFeesPaid: string;
      totalResourceFeesPaid: string;
    } | null;
    solvers?: { modelId: string; payout: string; capabilitiesOpened: string }[];
    resourcePools?: {
      id: string;
      totalDeposited: string;
      totalWithdrawn: string;
      totalRevenue: string;
      depositorCount: string;
    }[];
  }>(
    `query Marketplace {
      _meta { block { number } }
      well(id: "well") {
        solverCount totalSolverFeesPaid totalResourceFeesPaid
      }
      solvers(orderBy: capabilitiesOpened, orderDirection: desc, first: 10) {
        modelId payout capabilitiesOpened
      }
      resourcePools(first: 1) {
        id totalDeposited totalWithdrawn totalRevenue depositorCount
      }
    }`,
  );
  if (!data || typeof data._meta?.block?.number !== "number") return null;
  try {
    const w = data.well;
    const p = (data.resourcePools ?? [])[0];
    return {
      block: data._meta.block.number,
      solverCount: Number(w?.solverCount ?? 0),
      totalSolverFeesPaid: BigInt(w?.totalSolverFeesPaid ?? 0),
      totalResourceFeesPaid: BigInt(w?.totalResourceFeesPaid ?? 0),
      topSolvers: (data.solvers ?? []).map((s) => ({
        modelId: s.modelId,
        payout: s.payout,
        capabilitiesOpened: Number(s.capabilitiesOpened),
      })),
      pool: p
        ? {
            address: p.id,
            totalDeposited: BigInt(p.totalDeposited),
            totalWithdrawn: BigInt(p.totalWithdrawn),
            totalRevenue: BigInt(p.totalRevenue),
            depositorCount: Number(p.depositorCount),
          }
        : null,
    };
  } catch {
    return null;
  }
}
