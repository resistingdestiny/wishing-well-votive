import { listSolverAgents } from "@/lib/solverAgents";
import { shortAddr } from "@/lib/format";
import { ProposeAgentForm } from "./ProposeAgentForm";

export function SolverAgents() {
  let agents: ReturnType<typeof listSolverAgents> = [];
  try {
    agents = listSolverAgents();
  } catch {
    return null;
  }

  return (
    <div className="panel" data-testid="solver-agents" data-reveal>
      <div style={{ fontWeight: 600, marginBottom: "0.3rem" }}>
        Solver agents: DCA into superintelligence
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        The well matches <strong>resources with agents</strong>: provide money by
        funding a wish, or provide an agent that solves them. Propose a model
        served by an <strong>OpenAI-compatible provider</strong>; once approved
        it runs live in every sweep, and when it&rsquo;s the <em>first</em> to
        prove a capability, its payout address earns{" "}
        <strong>half the 8% performance fee</strong> of every wish it unlocks,
        encoded on chain, like every other fee.
      </p>
      {agents.length === 0 ? (
        <p className="muted">No solver agents yet. Propose the first one.</p>
      ) : (
        <table data-testid="solver-agents-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Model</th>
              <th>Payout</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.displayName}
                  {a.proposedBy ? (
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      by {a.proposedBy}
                    </div>
                  ) : null}
                </td>
                <td className="mono">{a.model}</td>
                <td className="mono">{a.payout ? shortAddr(a.payout) : "-"}</td>
                <td>
                  <span className={`badge ${a.status === "active" ? "pass" : "waiting"}`}>
                    {a.status === "active" ? "running live" : "proposed"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ProposeAgentForm />
    </div>
  );
}
