import path from "node:path";
import { NextResponse } from "next/server";
import { createWalletClient, http, parseAbi, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentDataDir } from "@/lib/ingest";
import { chainConfig } from "@/lib/chain";
import { StrategyStore } from "@/core/agents/strategyStore";
import { ModelRegistry } from "@/core/models/registry";

export const dynamic = "force-dynamic";

const setSolverAbi = parseAbi(["function setSolver(bytes32 modelId, address payout)"]);

function modelsFile(): string {
  return process.env.WELL_MODELS_FILE ?? path.resolve(process.cwd(), "..", "agent", "models.json");
}

export async function POST(req: Request) {
  const expected = process.env.WELL_CURATOR_TOKEN;
  if (!expected) return NextResponse.json({ error: "approval disabled" }, { status: 503 });
  if (req.headers.get("x-curator-token") !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const store = new StrategyStore(agentDataDir());
  const agent = store.get(id);
  if (!agent) return NextResponse.json({ error: "no such agent" }, { status: 404 });

  const now = new Date().toISOString().slice(0, 10);
  new ModelRegistry(modelsFile()).add({
    id: agent.id,
    provider: "strategy",
    displayName: agent.displayName,
    released: now,
    tier: "mid",
    active: true,
    solverPayout: agent.payout,
    proposedBy: agent.proposedBy,
  });
  store.setStatus(id, "approved");

  let solverTx: string | null = null;
  const ownerPk = process.env.WELL_SOLVER_OWNER_PK as `0x${string}` | undefined;
  const cfg = chainConfig();
  if (ownerPk && cfg.registry) {
    try {
      const account = privateKeyToAccount(ownerPk);
      const wallet = createWalletClient({ account, chain: cfg.chain, transport: http(cfg.rpcUrl) });
      solverTx = await wallet.writeContract({
        address: cfg.registry,
        abi: setSolverAbi,
        functionName: "setSolver",
        args: [keccak256(toHex(agent.id)), agent.payout as `0x${string}`],
      });
    } catch (e) {

      return NextResponse.json({ ok: true, agent: store.get(id), solverTx: null, onchainError: (e as Error).message });
    }
  }
  return NextResponse.json({ ok: true, agent: store.get(id), solverTx });
}
