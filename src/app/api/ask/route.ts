import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { listAllCells } from "@/lib/chain";
import { graphLiveCounts, graphRecentFlips } from "@/lib/graph";
import { formatEther, keccak256, toHex } from "viem";

export const dynamic = "force-dynamic";

interface AskResult {
  label: string;
  href?: string;
}
interface AskAnswer {
  answer: string;
  cite?: string;
  results: AskResult[];
}

const ADDR = /0x[0-9a-fA-F]{40}/;

export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  try {
    const answer = await route(q);
    return NextResponse.json(answer);
  } catch (e) {
    console.error("ask:", (e as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

async function route(q: string): Promise<AskAnswer> {
  const lc = q.toLowerCase();

  if (q.length === 0) {
    return {
      answer: "Ask about the well — every answer is grounded in the run log, never guessed.",
      results: [
        { label: "What's parked in the well?" },
        { label: "How many wishes are waiting?" },
        { label: "What moved recently?" },
        { label: "What has claude-fable-5 unlocked?" },
        { label: "Search wishes: chess" },
      ],
    };
  }

  const addr = q.match(ADDR)?.[0];
  if (addr) {
    return {
      answer: `Open the wish at ${addr.slice(0, 10)}…`,
      results: [{ label: `Wish ${addr.slice(0, 10)}…`, href: `/wish/${addr}` }],
    };
  }

  if (/(what moved|moved recently|recent flips?|flipped|just unlocked)/.test(lc)) {
    const flips = await graphRecentFlips(8);
    if (flips !== null && flips.length > 0) {
      const names = await modelNamesByHash();
      const summaries = await capabilitySummaries(flips.map((f) => f.capabilityId));
      return {
        answer: `${flips.length} capability–model pair${flips.length === 1 ? "" : "s"} flipped fail→pass most recently.`,
        cite: "The Graph subgraph (flip timestamps)",
        results: flips.map((f) => ({
          label: `${names.get(f.modelId.toLowerCase()) ?? f.modelId.slice(0, 12) + "…"} cleared ${
            summaries.get(f.capabilityId) ?? f.capabilityId.slice(0, 14) + "…"
          }${f.pass ? "" : " (since regressed)"}`,
          href: "/board",
        })),
      };
    }

    const passes = await prisma.runEntry.findMany({
      where: { kind: "capability-check", pass: true },
      orderBy: { seq: "desc" },
      take: 8,
    });
    return {
      answer:
        passes.length === 0
          ? "Nothing has moved yet — no capability has a passing check."
          : `Latest passing checks: ${[...new Set(passes.map((p) => p.model))].join(", ")}.`,
      cite: `${passes.length} passing checks in the run log`,
      results: [{ label: "The board", href: "/board" }],
    };
  }

  if (/(parked|value|how much|total|balance)/.test(lc)) {
    const counts = await graphLiveCounts();
    if (counts !== null) {
      const live = counts.waiting + counts.attempting;
      return {
        answer: `${Number(formatEther(counts.parked)).toLocaleString("en-GB", {
          maximumFractionDigits: 4,
        })} ETH is parked across ${live} waiting wish${live === 1 ? "" : "es"}.`,
        cite: `The Graph subgraph · block #${counts.block}`,
        results: [{ label: "See the well", href: "/explore" }],
      };
    }
    const cells = await listAllCells();
    const waiting = cells.filter((c) => c.state === 1 || c.state === 2);

    const parked = waiting.filter((c) => c.assetIsNative).reduce((s, c) => s + c.balance, 0n);
    return {
      answer: `${Number(formatEther(parked)).toLocaleString("en-GB", {
        maximumFractionDigits: 4,
      })} ETH is parked across ${waiting.length} waiting wish${waiting.length === 1 ? "" : "es"}.`,
      cite: `live, ${cells.length} cells on chain`,
      results: [{ label: "See the well", href: "/explore" }],
    };
  }

  if (/(waiting|backlog|executed|fulfilled|granted|how many wish)/.test(lc)) {
    const counts = await graphLiveCounts();
    if (counts !== null) {
      const live = counts.waiting + counts.attempting;
      return {
        answer: `${live} wish${live === 1 ? "" : "es"} waiting, ${counts.fulfilled} executed to date.`,
        cite: `The Graph subgraph · block #${counts.block}`,
        results: [
          { label: "The board", href: "/board" },
          { label: "The well", href: "/explore" },
        ],
      };
    }
    const cells = await listAllCells();
    const waiting = cells.filter((c) => c.state === 1 || c.state === 2).length;
    const done = cells.filter((c) => c.state === 3).length;
    return {
      answer: `${waiting} wish${waiting === 1 ? "" : "es"} waiting, ${done} executed to date.`,
      cite: `live, ${cells.length} cells on chain`,
      results: [
        { label: "The board", href: "/board" },
        { label: "The well", href: "/explore" },
      ],
    };
  }

  const modelMatch = lc.match(/(claude[\w.-]+|gpt[\w.-]*|[\w-]*sonnet[\w.-]*|[\w-]*opus[\w.-]*|[\w-]*fable[\w.-]*|[\w-]*haiku[\w.-]*)/);
  if (/(unlock|passed|can do|capab)/.test(lc) || modelMatch) {
    const passes = await prisma.runEntry.findMany({
      where: {
        kind: "capability-check",
        pass: true,
        ...(modelMatch ? { model: { contains: modelMatch[0] } } : {}),
      },
      orderBy: { seq: "desc" },
      take: 200,
    });
    const capIds = [...new Set(passes.map((p) => p.capabilityId).filter(Boolean))] as string[];
    const stories = await prisma.story.findMany({ where: { capabilityId: { in: capIds } } });
    const summaryByCap = new Map(
      stories.map((s) => [
        s.capabilityId,
        (s.parsed as { capability?: { summary?: string } })?.capability?.summary ?? "",
      ]),
    );
    const who = modelMatch ? modelMatch[0] : "the tested models";
    const results = capIds.slice(0, 8).map((c) => {
      const st = stories.find((s) => s.capabilityId === c);
      return {
        label: summaryByCap.get(c) || `${c.slice(0, 14)}…`,
        href: st?.cell ? `/wish/${st.cell}` : "/board",
      };
    });
    return {
      answer:
        capIds.length === 0
          ? `No capability has a passing attestation from ${who} yet.`
          : `${who} has cleared ${capIds.length} capabilit${capIds.length === 1 ? "y" : "ies"}.`,
      cite: `${passes.length} passing checks in the run log`,
      results,
    };
  }

  return searchStories(q);
}

async function modelNamesByHash(): Promise<Map<string, string>> {
  const rows = await prisma.runEntry.findMany({
    where: { kind: "capability-check" },
    distinct: ["model"],
    select: { model: true },
  });
  return new Map(
    rows
      .filter((r) => r.model !== "-")
      .map((r) => [keccak256(toHex(r.model)).toLowerCase(), r.model]),
  );
}

async function capabilitySummaries(capIds: string[]): Promise<Map<string, string>> {
  const stories = await prisma.story.findMany({
    where: { capabilityId: { in: capIds } },
  });
  const map = new Map<string, string>();
  for (const s of stories) {
    const summary = (s.parsed as { capability?: { summary?: string } })?.capability
      ?.summary;
    if (s.capabilityId && summary) map.set(s.capabilityId, summary);
  }
  return map;
}

async function searchStories(q: string): Promise<AskAnswer> {

  const term = q.replace(/^(search|find|wishes?|for)\s+/i, "").trim() || q;
  const stories = await prisma.story.findMany({
    where: { prose: { contains: term, mode: "insensitive" } },
    take: 8,
  });
  return {
    answer:
      stories.length === 0
        ? `No wishes mention “${term}”.`
        : `${stories.length} wish${stories.length === 1 ? "" : "es"} mention “${term}”.`,
    cite: "matched against wish stories",
    results: stories.map((s) => ({
      label: s.prose.slice(0, 70) + (s.prose.length > 70 ? "…" : ""),
      href: s.cell ? `/wish/${s.cell}` : "/explore",
    })),
  };
}
