import path from "node:path";
import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";
import { agentDataDir } from "@/lib/ingest";
import { StrategyStore } from "@/core/agents/strategyStore";
import { ModelRegistry } from "@/core/models/registry";
import { ResourceStore } from "@/core/resources/store";
import { isActive, toPublic } from "@/core/resources/resource";

export const dynamic = "force-dynamic";

function modelsFile(): string {
  return process.env.WELL_MODELS_FILE ?? path.resolve(process.cwd(), "..", "agent", "models.json");
}

export async function GET() {
  const dir = agentDataDir();
  const agents = new StrategyStore(dir).list();
  const baseModels = new ModelRegistry(modelsFile())
    .active()
    .filter((m) => m.provider !== "strategy")
    .map((m) => ({ id: m.id, displayName: m.displayName }));
  const tools = new ResourceStore(dir)
    .shared()
    .filter(isActive)
    .map((r) => ({ id: toPublic(r).id, name: toPublic(r).name, kind: toPublic(r).kind }));
  return NextResponse.json({ agents, baseModels, tools });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    displayName?: string;
    baseModel?: string;
    systemPrompt?: string;
    resourceIds?: string[];
    payout?: string;
    proposedBy?: string;
  };
  const displayName = (body.displayName ?? "").trim();
  const systemPrompt = (body.systemPrompt ?? "").trim();
  if (displayName.length < 3 || displayName.length > 80) {
    return NextResponse.json({ error: "displayName must be 3–80 chars" }, { status: 400 });
  }
  if (systemPrompt.length < 1 || systemPrompt.length > 8000) {
    return NextResponse.json({ error: "systemPrompt required (≤8000 chars)" }, { status: 400 });
  }
  if (!body.payout || !isAddress(body.payout)) {
    return NextResponse.json({ error: "valid payout address required" }, { status: 400 });
  }

  const base = new ModelRegistry(modelsFile()).get(body.baseModel ?? "");
  if (!base || base.provider === "strategy" || !base.active) {
    return NextResponse.json({ error: "baseModel must be an active platform model" }, { status: 400 });
  }
  const agent = new StrategyStore(agentDataDir()).propose({
    displayName,
    baseModel: base.id,
    systemPrompt,
    resourceIds: Array.isArray(body.resourceIds) ? body.resourceIds.slice(0, 20) : [],
    payout: getAddress(body.payout),
    proposedBy: (body.proposedBy ?? "").slice(0, 80),
  });
  return NextResponse.json({ ok: true, agent });
}
