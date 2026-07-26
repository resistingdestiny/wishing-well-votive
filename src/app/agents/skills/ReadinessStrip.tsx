/**
 * What this deployment has, right now, in one strip.
 *
 * The point of putting it at the top of the page rather than burying it per-skill
 * is that a builder's first question is not "how do I call this" — it is "will
 * any of this work where I am pointed". Answering that with a live read costs one
 * round of `eth_call`s and removes an hour of debugging somebody else's
 * misconfiguration.
 *
 * Every row is one of three states and says which. `unknown` is rendered in the
 * failure colour rather than a neutral one on purpose: a builder who reads
 * "unknown" as "probably fine" has been misled by the styling even when the words
 * were honest.
 */
import { probeBadge, probeWord, summarise, type Probe } from "@/core/skills/readiness";

export function ReadinessStrip({ probes }: { probes: Probe[] }) {
  const totals = summarise(probes);

  return (
    <section className="panel" data-reveal data-testid="skills-readiness">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ margin: 0 }}>What this deployment has</h2>
        <span className="mono muted" style={{ fontSize: "0.78rem" }}>
          {totals.ready} ready · {totals.notConfigured} not configured
          {totals.unknown > 0 ? ` · ${totals.unknown} unknown` : ""}
        </span>
      </div>
      <p className="muted" style={{ maxWidth: "72ch", marginTop: "0.4rem" }}>
        Read from the chain and this server&rsquo;s environment when the page
        loaded &mdash; not from a config file. A row that says{" "}
        <em>unknown</em> means the read failed: it is a statement about us, and
        nothing should be inferred about the contract from it.
      </p>

      <div className="tableWrap" style={{ marginTop: "0.9rem" }}>
        <table>
          <thead>
            <tr>
              <th>Capability</th>
              <th>State</th>
              <th>What we read</th>
            </tr>
          </thead>
          <tbody>
            {probes.map((probe) => (
              <tr key={probe.key} data-testid={`probe-${probe.key}`} data-state={probe.state}>
                <td style={{ whiteSpace: "nowrap" }}>{probe.label}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <span className={`badge ${probeBadge(probe.state)}`}>
                    {probeWord(probe.state)}
                  </span>
                  {probe.caveat ? (
                    <span className="badge waiting" style={{ marginLeft: "0.35rem" }}>
                      caveat
                    </span>
                  ) : null}
                </td>
                <td className="muted" style={{ fontSize: "0.82rem" }}>
                  {probe.detail}
                  {probe.caveat ? (
                    <>
                      {" "}
                      <strong style={{ color: "var(--ink)" }}>{probe.caveat}</strong>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
