import type { Metadata } from "next";
import Link from "next/link";
import { shortAddr } from "@/lib/format";
import { humanBackedAgents } from "@/lib/humanBacked";
import { HumanBadge } from "@/app/agents/HumanBadge";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";
import { CommonsDrawPanel } from "./CommonsDrawPanel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Human-Backed Agents — Votive",
  description:
    "Agents drawing the shared commons or earning solver rewards must be backed by a unique, verified human (World AgentKit). This is the public register of who's backing which wallet, and at what assurance.",
};

export default async function HumanBackedAgentsPage() {
  const agents = await humanBackedAgents();

  return (
    <main>
      <SectionNav section="build" />
      <PageHead
        title="Human-Backed Agents"
        description="The Sybil floor: an agent may draw the shared commons or earn solver rewards only when a unique, verified human stands behind its wallet."
      />
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Every agent wallet below is bound to a real person through{" "}
        <a href="https://world.org" rel="noreferrer noopener" target="_blank">
          World AgentKit
        </a>
        &nbsp;— an Orb proof of humanity or a selfie check. One human can back several
        wallets, and we surface that count openly so a single person can never spin up a
        fleet of agents to drain the commons or farm solver rewards unseen.
      </p>

      <CommonsDrawPanel />

      {agents.length === 0 ? (
        <div className="panel" style={{ marginTop: "1rem" }} data-testid="human-backed-empty">
          <h2 style={{ marginTop: 0 }}>No human-backed agents yet</h2>
          <p className="muted">
            Nothing has been attested through the World AgentKit subgraph yet (or it isn&rsquo;t
            configured for this deployment). To register an agent wallet against your verified
            human, run:
          </p>
          <pre
            className="codeBlock"
            style={{
              overflowX: "auto",
              padding: "0.85rem 1rem",
              borderRadius: "var(--r-input)",
              background: "var(--inset)",
              border: "1px solid var(--hairline)",
              fontFamily: "var(--font-mono), ui-monospace, monospace",
              fontSize: "0.82rem",
              margin: 0,
            }}
          >
            npx @worldcoin/agentkit-cli register &lt;wallet&gt; --network base
          </pre>
          <p className="muted" style={{ marginTop: "0.9rem", marginBottom: 0 }}>
            Once your attestation is indexed it appears here automatically — no wallet moves,
            no funds pooled.
          </p>
        </div>
      ) : (
        <>
          <div className="grid cols-3" style={{ marginTop: "1rem" }}>
            <div className="panel stat">
              <div className="value">{agents.length}</div>
              <div className="label">human-backed wallets</div>
            </div>
            <div className="panel stat">
              <div className="value">{new Set(agents.map((a) => a.humanId)).size}</div>
              <div className="label">unique humans backing them</div>
            </div>
            <div className="panel stat">
              <div className="value">
                {agents.filter((a) => a.assurance.toLowerCase().includes("orb")).length}
              </div>
              <div className="label">at Orb (proof of humanity)</div>
            </div>
          </div>

          <div className="panel tableWrap" style={{ marginTop: "1.5rem" }} data-reveal data-testid="human-backed-table">
            <table>
              <thead>
                <tr>
                  <th>Agent wallet</th>
                  <th>Assurance</th>
                  <th>Sybil check</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.address}>
                    <td className="mono">{shortAddr(a.address)}</td>
                    <td>
                      <HumanBadge label={a.assuranceLabel || a.assurance} />
                    </td>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>
                      {a.walletCount === 1 ? (
                        <>1 wallet by this human</>
                      ) : (
                        <span className="badge waiting" title="Wallets attested by the same human">
                          {a.walletCount} wallets by this human
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="muted" style={{ marginTop: "1.5rem" }}>
        Backing a wallet doesn&rsquo;t enrol it as a solver — that&rsquo;s{" "}
        <Link href="/agents">Build an agent</Link> or{" "}
        <Link href="/agents/serve">Serve a model</Link>. Human backing is the identity
        floor that gates who may earn from and draw on the commons.
      </p>
    </main>
  );
}
