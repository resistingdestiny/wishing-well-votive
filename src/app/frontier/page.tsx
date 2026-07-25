import Link from "next/link";
import { prisma } from "@/lib/db";
import { readSignedRunLog } from "@/lib/runlog";
import { buildFrontierReport } from "@/core/frontier/report";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "The Frontier Report: what AI just unlocked, what it still can't do",
  description:
    "A per-sweep state of the AI frontier from Votive: what flipped fail→pass this release, the demand-weighted backlog of what remains, and how many sweeps a capability takes to unlock.",
};

export default async function Frontier() {
  const entries = readSignedRunLog();
  const grouped = await prisma.story
    .groupBy({ by: ["capabilityId"], _count: { _all: true } })
    .catch(() => [] as { capabilityId: string; _count: { _all: number } }[]);
  const demand = new Map(grouped.map((g) => [g.capabilityId, g._count._all]));
  const r = buildFrontierReport(entries, demand);

  return (
    <main className="frontier-report">
      <SectionNav section="research" />
      <PageHead
        title="The Frontier Report"
        description="What the latest model releases just made possible, what's still out of reach, and how long wishes typically wait. Regenerated on every sweep."
      />

      <div className="grid cols-3" data-stagger>
        <div className="panel stat">
          <div className="value" data-count={r.totals.cleared}>{r.totals.cleared}</div>
          <div className="label">capabilities unlocked</div>
        </div>
        <div className="panel stat">
          <div className="value" data-count={r.totals.backlog}>{r.totals.backlog}</div>
          <div className="label">still out of reach</div>
        </div>
        <div className="panel stat">
          <div className="value" data-count={r.medianSweepsToUnlock ?? undefined}>
            {r.medianSweepsToUnlock ?? "-"}
          </div>
          <div className="label">median sweeps to unlock</div>
        </div>
      </div>

      <h2>What just moved</h2>
      {r.flips.length === 0 ? (
        <p className="muted">Nothing has flipped fail→pass yet. When a release unlocks a wish, it lands here.</p>
      ) : (
        <div className="panel" data-reveal>
          <ul style={{ margin: 0, paddingLeft: "1.2rem", lineHeight: 1.8 }}>
            {r.flips.slice(0, 12).map((f) => (
              <li key={`${f.capabilityId}-${f.model}`}>
                <span className="mono">{f.model}</span> unlocked{" "}
                <strong>{f.summary ?? `${f.capabilityId.slice(0, 12)}…`}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2>The backlog: what still can&rsquo;t be done</h2>
      <p className="muted">Ranked by demand: how many wishes are waiting on each capability.</p>
      {r.backlog.length === 0 ? (
        <p className="muted">Every demanded capability has been cleared by some model.</p>
      ) : (
        <div className="panel tableWrap" data-reveal>
          <table data-testid="frontier-backlog">
            <thead>
              <tr>
                <th>Capability</th>
                <th>Wishes waiting</th>
                <th>Checks</th>
                <th>Models that failed</th>
              </tr>
            </thead>
            <tbody>
              {r.backlog.map((c) => (
                <tr key={c.capabilityId}>
                  <td>{c.summary ?? <span className="mono">{c.capabilityId.slice(0, 16)}…</span>}</td>
                  <td>{c.demand}</td>
                  <td>{c.checks}</td>
                  <td className="mono muted" style={{ fontSize: "0.78rem" }}>
                    {c.models.map((m) => m.model).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {r.cleared.length > 0 ? (
        <>
          <h2>Recently within reach</h2>
          <div className="panel tableWrap" data-reveal>
            <table>
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>Wishes</th>
                  <th>Sweeps to unlock</th>
                  <th>Cleared by</th>
                </tr>
              </thead>
              <tbody>
                {r.cleared.map((c) => (
                  <tr key={c.capabilityId}>
                    <td>{c.summary ?? <span className="mono">{c.capabilityId.slice(0, 16)}…</span>}</td>
                    <td>{c.demand}</td>
                    <td>{c.sweepsToUnlock ?? "-"}</td>
                    <td className="mono muted" style={{ fontSize: "0.78rem" }}>
                      {c.models.filter((m) => m.latestPass).map((m) => m.model).join(", ") || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <p className="muted" style={{ marginTop: "1.5rem" }}>
        As of run-log seq #{r.generatedAtSeq} · {r.totals.checks} signed checks across{" "}
        {r.totals.models} models. Print this page to save a PDF snapshot. See the{" "}
        <Link href="/board">live board</Link>, download the{" "}
        <Link href="/bench">open dataset</Link>, or <Link href="/embed">embed this on your site</Link>.
      </p>
    </main>
  );
}
