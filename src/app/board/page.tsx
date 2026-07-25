import Link from "next/link";
import { prisma } from "@/lib/db";
import { shortAddr } from "@/lib/format";
import { WatchButton } from "@/app/WatchButton";
import { computeCostRaw } from "@/core/models/costLedger";
import { formatUsd } from "@/core/models/pricing";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Capability backlog · Votive",
  description:
    "The public record of what today's models can and can't do for the wishes in Votive: every check signed, attested, failures included.",
};

interface PairState {
  latestPass: boolean;
  latestTs: Date;
  everFailed: boolean;
  flippedToPass: boolean;
  checks: number;

  passRate?: number;
  streak?: number;
  required?: number;
}

interface CheckDetail {
  passK?: { passRate?: number };
  streak?: { count?: number; required?: number };
}

export default async function Board() {
  const checks = await prisma.runEntry
    .findMany({ where: { kind: "capability-check" }, orderBy: { seq: "asc" } })
    .catch(() => []);
  const attempts = await prisma.runEntry
    .findMany({
      where: { kind: "fulfilment-attempt" },
      orderBy: { seq: "desc" },
      take: 25,
    })
    .catch(() => []);
  const stories = await prisma.story.findMany().catch(() => []);
  const storyByCapability = new Map(stories.map((s) => [s.capabilityId, s]));

  const pairs = new Map<string, PairState>();
  const models = new Set<string>();
  const capabilities = new Set<string>();
  for (const c of checks) {
    if (!c.capabilityId) continue;
    models.add(c.model);
    capabilities.add(c.capabilityId);
    const key = `${c.capabilityId}|${c.model}`;
    const prev = pairs.get(key);
    const d = (c.detail ?? {}) as CheckDetail;
    pairs.set(key, {
      latestPass: c.pass === true,
      latestTs: c.ts,
      everFailed: (prev?.everFailed ?? false) || c.pass === false,
      flippedToPass:
        (prev?.flippedToPass ?? false) ||
        (c.pass === true && prev !== undefined && !prev.latestPass && prev.everFailed),
      checks: (prev?.checks ?? 0) + 1,
      passRate: d.passK?.passRate ?? prev?.passRate,
      streak: d.streak?.count ?? prev?.streak,
      required: d.streak?.required ?? prev?.required,
    });
  }
  const modelList = [...models].sort();
  const capabilityList = [...capabilities].sort((a, b) => {

    const aPassed = modelList.some((m) => pairs.get(`${a}|${m}`)?.latestPass);
    const bPassed = modelList.some((m) => pairs.get(`${b}|${m}`)?.latestPass);
    return Number(aPassed) - Number(bPassed);
  });

  const moved = [...pairs.entries()].filter(([, v]) => v.flippedToPass);
  const totalChecks = checks.length;
  const failedChecks = checks.filter((c) => c.pass === false).length;

  const costRows = await prisma.runEntry
    .findMany({ select: { model: true, provider: true, inputTokens: true, outputTokens: true, capabilityId: true } })
    .catch(() => []);
  const cost = computeCostRaw(costRows);

  return (
    <main>
      <SectionNav section="research" />
      <PageHead
        title="The capability backlog"
        description="Every capability wishes are waiting on, as a model × capability pass/fail matrix: failures are the benchmark. A wish fulfils after three consecutive passing sweeps."
      />
      <p className="muted" data-testid="serve-pointer">
        Provide the other half of the protocol: an agent instead of money. First to
        prove a capability earns half the 8% performance fee.{" "}
        <Link href="/agents/serve">Serve a model →</Link>
      </p>

      <h2>At a glance</h2>
      <div className="grid cols-3">
        <div className="panel stat">
          <div className="value">{capabilityList.length}</div>
          <div className="label">capabilities under watch</div>
        </div>
        <div className="panel stat">
          <div className="value">{modelList.length}</div>
          <div className="label">model releases tested</div>
        </div>
        <div className="panel stat">
          <div className="value">
            {totalChecks}
            <span className="muted" style={{ fontSize: "0.9rem" }}>
              {" "}
              ({failedChecks} failed)
            </span>
          </div>
          <div className="label">checks recorded</div>
        </div>
        <div className="panel stat" data-testid="board-compute-cost">
          <div className="value">{formatUsd(cost.totalUsd)}</div>
          <div className="label">
            compute spent proving the frontier
            {Object.keys(cost.byProvider).length > 1 ? (
              <span className="muted"> · {Object.keys(cost.byProvider).length} providers</span>
            ) : null}
          </div>
        </div>
      </div>

      <h2>What moved</h2>
      {moved.length === 0 ? (
        <p className="muted">
          Nothing has flipped from fail to pass yet. When a new model release
          unlocks a waiting wish, it shows up here.
        </p>
      ) : (
        <div className="panel">
          <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
            {moved.map(([key]) => {
              const [capabilityId, model] = key.split("|");
              const story = storyByCapability.get(capabilityId!);
              return (
                <li key={key}>
                  <span className="mono">{model}</span> unlocked{" "}
                  {story ? (
                    <em>{story.parsed && (story.parsed as { capability?: { summary?: string } }).capability?.summary}</em>
                  ) : (
                    <span className="mono">{capabilityId!.slice(0, 14)}…</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <h2>The matrix</h2>
      <p className="muted">
        The latest verdict per capability × model. Every check is an open, verifiable
        dataset row → <Link href="/bench">Votive Bench</Link>.
      </p>
      {capabilityList.length === 0 ? (
        <p className="muted">No sweeps recorded yet.</p>
      ) : (
        <div className="panel tableWrap" data-reveal>
          <table className="boardTable" data-testid="board-table">
            <thead>
              <tr>
                <th>Capability</th>
                {modelList.map((m) => (
                  <th key={m} className="mono">
                    {m}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {capabilityList.map((capId) => {
                const story = storyByCapability.get(capId);
                return (
                  <tr key={capId}>
                    <td>
                      {story ? (
                        <>
                          {(story.parsed as { capability?: { summary?: string } })
                            .capability?.summary ?? "(no summary)"}
                          {story.cell ? (
                            <div>
                              <Link href={`/wish/${story.cell}`} className="mono muted">
                                {shortAddr(story.cell)}
                              </Link>
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span className="mono">{capId.slice(0, 18)}…</span>
                      )}
                      {cost.byCapability[capId] ? (
                        <div className="muted" style={{ fontSize: "0.72rem", marginTop: "0.2rem" }}>
                          {formatUsd(cost.byCapability[capId]!.usd)} compute ·{" "}
                          {cost.byCapability[capId]!.entries} checks
                        </div>
                      ) : null}
                      <div style={{ marginTop: "0.4rem", display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
                        <WatchButton kind="capability" target={capId} label="Watch" />
                        <a
                          href={`/api/bench/${capId}?download=1`}
                          className="muted"
                          style={{ fontSize: "0.72rem" }}
                          data-testid="download-benchmark"
                        >
                          ↓ benchmark
                        </a>
                      </div>
                    </td>
                    {modelList.map((m) => {
                      const pair = pairs.get(`${capId}|${m}`);
                      return (
                        <td key={m}>
                          {!pair ? (
                            <span className="muted">not tested</span>
                          ) : pair.latestPass ? (
                            <span className="badge pass">pass</span>
                          ) : (
                            <span className="badge fail">fail</span>
                          )}
                          {pair ? (
                            <div className="muted" style={{ fontSize: "0.75rem" }}>
                              {pair.checks} check{pair.checks === 1 ? "" : "s"}
                              {typeof pair.passRate === "number"
                                ? ` · ${Math.round(pair.passRate * 100)}% pass@k`
                                : ""}
                              {typeof pair.streak === "number" && pair.required
                                ? ` · streak ${pair.streak}/${pair.required}`
                                : ""}
                            </div>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>Recent fulfilment attempts</h2>
      {attempts.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <div className="panel tableWrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Wish</th>
                <th>Model</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.seq}>
                  <td className="muted">
                    {a.ts.toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td>
                    {a.cell ? (
                      <Link href={`/wish/${a.cell}`} className="mono">
                        {shortAddr(a.cell)}
                      </Link>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="mono">{a.model}</td>
                  <td>
                    {a.pass ? (
                      <span className="badge pass">condition met</span>
                    ) : (
                      <span className="badge fail">condition not met</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
