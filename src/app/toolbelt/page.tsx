import Link from "next/link";
import { agentDataDir } from "@/lib/ingest";
import { prisma } from "@/lib/db";
import { ResourceStore } from "@/core/resources/store";
import { StrategyStore } from "@/core/agents/strategyStore";
import { computeResourceAttribution } from "@/core/resources/attribution";
import { toPublic } from "@/core/resources/resource";
import { ResourceCard } from "@/app/ResourceCard";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";
import { CommitResourceForm } from "./CommitResourceForm";
import { PoolPanel } from "./PoolPanel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "The shared toolbelt · Votive",
  description:
    "Resources every wish's agent can draw on: tools, data sources, and scoped credentials, published to a shared registry. Secrets stay in a vault; only a reference is stored.",
};

export default async function Toolbelt() {
  const shared = new ResourceStore(agentDataDir()).shared().map(toPublic);
  const pending = shared.filter((r) => r.status === "pending");
  const live = shared.filter((r) => r.status !== "pending");
  const active = live.filter((r) => !r.revoked && r.status !== "rejected");

  let attribution = new Map<string, { consults: number; cells: string[]; usd: number }>();
  try {
    const rows = await prisma.runEntry.findMany({
      where: { OR: [{ kind: "fulfilment-attempt" }, { kind: "sweep-note" }] },
      select: { kind: true, cell: true, model: true, detail: true, inputTokens: true, outputTokens: true },
    });
    const strategies = new StrategyStore(agentDataDir());
    attribution = computeResourceAttribution(
      rows as unknown as Parameters<typeof computeResourceAttribution>[0],
      { strategyResources: (m) => strategies.get(m)?.resourceIds },
    );
  } catch {

  }

  return (
    <main>
      <SectionNav section="build" />
      <PageHead
        title="The shared toolbelt"
        description="Tools, MCP servers, data and credentials that wishes' agents can draw on: shared, or scoped to one wish. Anyone can commit a resource; a curator reviews it before anything draws on it."
      />

      <div className="stack">
        <CommitResourceForm />
        <PoolPanel />
      </div>

      {live.length > 0 ? (
        <div className="kpiRow">
          <div className="panel stat">
            <div className="value">{active.length}</div>
            <div className="label">resources live in the toolbelt</div>
          </div>
          <div className="panel stat">
            <div className="value">{new Set(active.map((r) => r.kind)).size}</div>
            <div className="label">kinds (tool / data / MCP / credential)</div>
          </div>
          <div className="panel stat">
            <div className="value">{active.filter((r) => r.hasCredential).length}</div>
            <div className="label">vault-backed credentials</div>
          </div>
        </div>
      ) : null}

      {pending.length > 0 ? (
        <>
          <h2>Pending review</h2>
          <div className="ledger-grid" data-testid="toolbelt-pending">
            {pending.map((r) => (
              <ResourceCard key={r.id} r={r} />
            ))}
          </div>
        </>
      ) : null}

      {live.length === 0 && pending.length === 0 ? (
        <div className="panel emptyState" data-testid="toolbelt-empty">
          <h3>The toolbelt is empty</h3>
          <p className="muted" style={{ margin: 0, maxWidth: "48ch" }}>
            Resources published here (tools, data sources, MCP servers, scoped
            credentials) become available to every wish&rsquo;s agent, and to the
            strategy agents people build. Secrets stay in the vault; only a reference
            is stored. Commit the first one above.
          </p>
          <div className="row" style={{ justifyContent: "center" }}>
            <Link href="/agents" className="pill pillPrimary">
              Build an agent that uses tools
            </Link>
            <Link href="/bench" className="pill">
              See the run log
            </Link>
          </div>
        </div>
      ) : live.length > 0 ? (
        <div className="ledger-grid">
          {live.map((r) => (
            <ResourceCard key={r.id} r={r} stats={attribution.get(r.id)} />
          ))}
        </div>
      ) : null}

      <p className="muted" style={{ marginTop: "1.5rem" }}>
        Resources are consulted by the executor when it attempts a wish; each consult is
        recorded in the signed <Link href="/bench">run log</Link>. Grants extend the agent&rsquo;s
        token / USD budget for that wish. Secrets live in a vault; only a reference is ever stored, so
        nothing sensitive touches the run log or the chain. Agents built on{" "}
        <Link href="/agents">the Agents page</Link> pick their tools from this toolbelt.
      </p>
    </main>
  );
}

