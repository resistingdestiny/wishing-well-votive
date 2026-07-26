import { shortAddr } from "@/lib/format";
import { humanBacking, standingFor } from "@/lib/chainReads";
import { isHumanBacked } from "@/core/world/humanId";
import { HumanBadge } from "@/app/agents/HumanBadge";
import { ReadFailure } from "@/app/ui/ReadFailure";
import type { RegisteredAgent } from "./RegisterAgentForm";

export interface RosterAgent extends RegisteredAgent {
  createdAt: string;
  /** How many keys are live. Never *which* — see below. */
  liveKeys: number;
}

/** `AssuranceTiers.sol`: NONE 0, DEVICE 1, SELFIE 2, ORB 3. */
const TIERS = ["Unverified", "Device", "Selfie", "Orb"] as const;
const tierLabel = (n: number): string => TIERS[n] ?? `tier ${n}`;

/**
 * Who is registered, and what the chain currently says about each of them.
 *
 * **Nothing here is cached.** Backing and standing are read on every request,
 * because both can change without us: the attestor can revoke a binding and the
 * ledger can bar a human, and a `verified` column in Postgres would go on
 * displaying a green badge over a wallet the chain had already disowned. That is
 * the repo's own rule — history is written, state is read — and it is the
 * difference between a register and a rumour.
 *
 * **A failed read is never drawn as a zero.** Each row reports its own state, and
 * when every row fails the same way (an unset registry address, an endpoint that
 * is down) that is said once at the top instead of eighteen times. The thing this
 * exists to prevent is a table of "Unverified" that is really a table of "we did
 * not ask".
 *
 * **Key ids are absent on purpose.** A count is here because a count enables
 * nothing; the ids are not, because an id is all it takes to drive an honest
 * agent's credential into the escalating lockout and hold it there. They are shown
 * to whoever already holds a live key for that agent, at `/api/agents/me`, and
 * nowhere else.
 *
 * Nothing from `next/*` is imported here, and that is load-bearing rather than
 * incidental: Playwright's ESM loader cannot resolve those export maps, so one
 * `next/link` would put this component permanently beyond reach of a test — and
 * the property most worth testing is exactly the one above, that a failed read
 * renders as a failure and never as "no human bound". The page keeps the
 * cross-links; this keeps the honesty.
 */
export async function AgentRoster({ agents }: { agents: RosterAgent[] }) {
  const rows = await Promise.all(
    agents.map(async (agent) => {
      const backing = await humanBacking(agent.wallet);
      const standing =
        backing.ok && isHumanBacked(backing.value.humanId)
          ? await standingFor(backing.value.humanId)
          : null;
      return { agent, backing, standing };
    }),
  );

  const firstFailure = rows.find((r) => !r.backing.ok);
  const allFailed = rows.length > 0 && rows.every((r) => !r.backing.ok);

  return (
    <section className="stack" style={{ marginTop: "1.5rem" }}>
      <div>
        <h2 style={{ margin: 0 }}>The register</h2>
        <p className="muted" style={{ margin: "0.3rem 0 0", maxWidth: "66ch" }}>
          Every agent that has signed for a record here, with the human backing and
          standing read live from Base Sepolia at the moment you loaded this page.
        </p>
      </div>

      {allFailed && firstFailure && !firstFailure.backing.ok ? (
        <ReadFailure
          what="human backing for any agent in the register"
          because={firstFailure.backing.degraded}
          testId="roster-read-failure"
        />
      ) : null}

      {agents.length === 0 ? (
        <div className="panel emptyState" data-testid="roster-empty">
          <h3>Nobody has registered yet</h3>
          <p className="muted" style={{ margin: 0, maxWidth: "52ch" }}>
            The register read cleanly and came back empty — this is a statement
            about the register, not about the database. Yours would be the first.
          </p>
        </div>
      ) : (
        <div className="panel tableWrap" data-reveal data-testid="agent-roster">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Wallet</th>
                <th>Human backing</th>
                <th>Standing</th>
                <th>Keys</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ agent, backing, standing }) => {
                const backed = backing.ok && isHumanBacked(backing.value.humanId);
                return (
                  <tr key={agent.id} data-testid="roster-row">
                    <td>
                      <div>{agent.displayName}</div>
                      {agent.status !== "active" ? (
                        <span className="badge fail">{agent.status}</span>
                      ) : null}
                    </td>
                    <td className="mono">{shortAddr(agent.wallet)}</td>
                    <td>
                      {!backing.ok ? (
                        <span className="muted" title={backing.degraded} data-testid="roster-backing-unknown">
                          could not read
                        </span>
                      ) : backed ? (
                        <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
                          <HumanBadge label={tierLabel(backing.value.assurance)} />
                          {backing.value.walletCount > 1 ? (
                            <span className="badge waiting" title="Wallets attested by the same human">
                              {backing.value.walletCount} wallets
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <span className="muted">no human bound</span>
                      )}
                    </td>
                    <td>
                      {standing === null ? (
                        <span className="muted">—</span>
                      ) : !standing.ok ? (
                        <span className="muted" title={standing.degraded}>
                          could not read
                        </span>
                      ) : (
                        <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
                          {/* Verified and barred at once is a real state and both
                              show: a bar zeroes the multiplier without lowering
                              the evidence tier that earned the badge beside it. */}
                          {standing.value.barred ? (
                            <span className="badge fail" data-testid="roster-barred">barred</span>
                          ) : null}
                          <span className="mono" title="Standing multiplier">
                            ×{(Number(standing.value.multiplierBps) / 10_000).toFixed(2)}
                          </span>
                          <span className="muted" style={{ fontSize: "0.8rem" }}>
                            {standing.value.fulfilments} filled / {standing.value.failures} failed
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="muted">
                      {agent.liveKeys === 0 ? "none issued" : `${agent.liveKeys} live`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
