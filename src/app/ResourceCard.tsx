import type { PublicResource } from "@/core/resources/resource";

const KIND_LABEL: Record<PublicResource["kind"], string> = {
  tool: "🛠 tool",
  mcp: "🔌 MCP",
  data: "📚 data",
  credential: "🔑 credential",
  budget: "💰 budget",
};

export function ResourceCard({
  r,
  stats,
}: {
  r: PublicResource;

  stats?: { consults: number; cells: string[]; usd: number };
}) {
  const dimmed = r.revoked || r.status === "rejected";
  return (
    <article className="panel hoverable" data-testid="resource-card" style={{ opacity: dimmed ? 0.5 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", alignItems: "baseline" }}>
        <strong>{r.name}</strong>
        <span style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {r.status === "pending" ? <span className="badge waiting">pending review</span> : null}
          {r.status === "rejected" ? <span className="badge fail">rejected</span> : null}
          <span className="muted" style={{ fontSize: "0.75rem" }}>
            {KIND_LABEL[r.kind]} · {r.scope}
            {r.revoked ? " · revoked" : ""}
          </span>
        </span>
      </div>
      {r.description ? <p style={{ margin: "0.4rem 0", fontSize: "0.9rem" }}>{r.description}</p> : null}
      <div className="muted" style={{ fontSize: "0.8rem", lineHeight: 1.6 }}>
        {r.provider ? (
          <>
            by <strong>{r.provider}</strong>
            {r.payout ? (
              <>
                {" "}
                · payout{" "}
                <span className="mono">
                  {r.payout.slice(0, 6)}…{r.payout.slice(-4)}
                </span>
              </>
            ) : null}{" "}
            ·{" "}
          </>
        ) : null}
        {r.hasCredential ? <>🔒 vault-backed credential (reference only) · </> : null}
        {r.tokenGrant ? <>+{r.tokenGrant.toLocaleString()} token budget · </> : null}
        {r.spendCapUsd ? <>${r.spendCapUsd} spend cap · </> : null}
        {r.allowedTools?.length ? <>tools: {r.allowedTools.join(", ")}</> : null}
      </div>
      {stats && stats.consults > 0 ? (
        <div className="muted" style={{ fontSize: "0.78rem", marginTop: "0.35rem" }} data-testid="resource-stats">
          consulted {stats.consults}× across {stats.cells.length}{" "}
          {stats.cells.length === 1 ? "wish" : "wishes"} · ${stats.usd.toFixed(4)} attributed compute
        </div>
      ) : null}
    </article>
  );
}
