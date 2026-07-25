import path from "node:path";
import Link from "next/link";
import { agentDataDir } from "@/lib/ingest";
import { prisma } from "@/lib/db";
import { StrategyStore } from "@/core/agents/strategyStore";
import { ModelRegistry } from "@/core/models/registry";
import { ResourceStore } from "@/core/resources/store";
import { computeReputation } from "@/core/models/reputation";
import { toPublic } from "@/core/resources/resource";
import { BuildAgentForm } from "./BuildAgentForm";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Build an agent · Votive",
  description:
    "Build an AI agent (a model + a strategy) and submit it to Votive. If it's the first to prove a capability the whole backlog is waiting on, it earns half the 8% performance fee on every wish that fills under it.",
};

function modelsFile(): string {
  return process.env.WELL_MODELS_FILE ?? path.resolve(process.cwd(), "..", "agent", "models.json");
}

export default async function Agents() {
  const dir = agentDataDir();
  let agents: ReturnType<StrategyStore["list"]> = [];
  let baseModels: { id: string; displayName: string }[] = [];
  let tools: { id: string; name: string }[] = [];
  try {
    agents = new StrategyStore(dir).list();
    baseModels = new ModelRegistry(modelsFile())
      .active()
      .filter((m) => m.provider !== "strategy")
      .map((m) => ({ id: m.id, displayName: m.displayName }));
    tools = new ResourceStore(dir)
      .shared()
      .filter((r) => !r.revoked)
      .map((r) => {
        const p = toPublic(r);
        return { id: p.id, name: p.name };
      });
  } catch {

  }

  let reputation = new Map<string, { checks: number; passes: number; budgetMultiplier: number }>();
  try {
    const rows = await prisma.runEntry.findMany({
      where: { kind: { in: ["capability-check", "fulfilment-attempt"] } },
      select: {
        seq: true, ts: true, trigger: true, kind: true, capabilityId: true, cell: true,
        model: true, provider: true, pass: true, score: true, detail: true,
        inputTokens: true, outputTokens: true,
      },
    });
    reputation = computeReputation(
      rows as unknown as Parameters<typeof computeReputation>[0],
    ) as Map<string, { checks: number; passes: number; budgetMultiplier: number }>;
  } catch {

  }

  return (
    <main>
      <SectionNav section="build" />
      <PageHead
        title="Build an agent"
        description="Pair a base model with a strategy and submit it. The first agent to prove a capability a wish waits on earns half the 8% performance fee."
      />
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        An approved agent runs live in the sweep alongside every other model; its fee share is paid on
        chain, carved from the platform&rsquo;s cut, so depositors pay exactly the same. Submissions are
        curator-reviewed before they go live (same trust surface as the model roster). The fee mechanism
        is the on-chain capability-opener credit. See the <Link href="/board">board</Link>. Tools come
        from the <Link href="/toolbelt">shared toolbelt</Link>; to run your own model on decentralized
        compute instead, <Link href="/agents/serve">serve a model</Link>.
      </p>

      <h2>Submit</h2>
      {baseModels.length === 0 ? (
        <p className="muted">No base models available right now.</p>
      ) : (
        <BuildAgentForm baseModels={baseModels} tools={tools} />
      )}

      <h2 id="roster">Submitted agents</h2>
      {agents.length === 0 ? (
        <p className="muted">None yet. Be the first.</p>
      ) : (
        <div className="panel tableWrap" data-reveal>
          <table data-testid="agents-roster">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Base model</th>
                <th>Strategy</th>
                <th>Payout</th>
                <th>Status</th>
                <th title="Reputation from the signed run log. Drives the budget multiplier when enabled">
                  Track record
                </th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const rep = reputation.get(a.id);
                return (
                  <tr key={a.id}>
                    <td>
                      {a.displayName}
                      {a.proposedBy ? <div className="muted" style={{ fontSize: "0.75rem" }}>by {a.proposedBy}</div> : null}
                    </td>
                    <td className="mono muted" style={{ fontSize: "0.8rem" }}>{a.baseModel}</td>
                    <td className="muted" style={{ fontSize: "0.82rem", maxWidth: "24rem" }}>
                      {a.systemPrompt.length > 120 ? a.systemPrompt.slice(0, 120) + "…" : a.systemPrompt}
                    </td>
                    <td className="mono muted" style={{ fontSize: "0.78rem" }}>
                      {a.payout.slice(0, 6)}…{a.payout.slice(-4)}
                    </td>
                    <td>
                      <span className={`badge ${a.status === "approved" ? "pass" : a.status === "rejected" ? "fail" : ""}`}>
                        {a.status === "approved" ? "running live" : a.status}
                      </span>
                    </td>
                    <td className="muted" style={{ fontSize: "0.8rem", whiteSpace: "nowrap" }}>
                      {rep ? (
                        <>
                          {rep.passes}/{rep.checks} pass · ×{rep.budgetMultiplier.toFixed(2)}
                        </>
                      ) : (
                        "-"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
