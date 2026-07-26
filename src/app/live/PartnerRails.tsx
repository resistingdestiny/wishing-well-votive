import { hederaProof, worldProof } from "@/lib/partnerProof";

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/**
 * The two partner rails, read from their own chains on every load.
 *
 * Same contract as the rest of this page: nothing here is a claim about an
 * integration, it is the integration answering. Hedera is the bounty rail's own
 * counters over the public relay; World is the same AgentBook lookup the verify
 * flow runs. A rail that stops answering renders as exactly that.
 */
export async function PartnerRails() {
  const [hedera, world] = await Promise.all([hederaProof(), worldProof()]);

  return (
    <section style={{ marginBottom: 34 }}>
      <h2>Partner rails, read live</h2>
      <p className="dim" style={{ fontSize: 13, marginTop: 0 }}>
        Asked on this page load — Hedera over its public JSON-RPC relay,{" "}
        World via the same AgentBook lookup a real verification runs. Not cached,
        not a screenshot.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
        <div className="panel stack" data-testid="hedera-proof">
          <h3 style={{ margin: 0 }}>Hedera — agentic payments</h3>
          {!hedera.configured ? (
            <p className="dim" style={{ margin: 0 }}>No Hedera rail is configured on this deployment.</p>
          ) : !hedera.answering ? (
            <p className="error" style={{ margin: 0 }}>
              The rail could not be read just now — that is a failed read, not an empty rail.
            </p>
          ) : (
            <>
              <p style={{ margin: 0 }}>
                The escrow rail is answering on Hedera testnet:{" "}
                <strong>{hedera.bounties}</strong> {hedera.bounties === 1 ? "bounty" : "bounties"} posted,{" "}
                <strong>{hedera.escrowedHbar} ℏ</strong> currently escrowed.
              </p>
              {hedera.latest ? (
                <p className="dim" style={{ margin: 0, fontSize: 13 }}>
                  Latest bounty #{hedera.latest.id}: {hedera.latest.totalHbar} ℏ,{" "}
                  {hedera.latest.agent === "0x0000000000000000000000000000000000000000"
                    ? "unclaimed"
                    : `claimed by ${short(hedera.latest.agent)}`}
                  , {hedera.latest.paidHbar} ℏ released{hedera.latest.closed ? ", closed" : ""}.
                  Milestones release one attestation at a time — Hedera&rsquo;s fees make
                  paying in increments reasonable.
                </p>
              ) : null}
              <p style={{ margin: 0, fontSize: 13 }}>
                <a href={hedera.explorer} target="_blank" rel="noreferrer">
                  The rail on HashScan ↗
                </a>{" "}
                · <a href="/rail">post &amp; claim from the app →</a>
              </p>
            </>
          )}
        </div>

        <div className="panel stack" data-testid="world-proof">
          <h3 style={{ margin: 0 }}>World — human verification</h3>
          {!world.configured ? (
            <p className="dim" style={{ margin: 0 }}>World verification is disabled on this deployment.</p>
          ) : world.state === "unreachable" ? (
            <p className="error" style={{ margin: 0 }}>{world.detail}</p>
          ) : (
            <p style={{ margin: 0 }}>{world.detail}</p>
          )}
          <p className="dim" style={{ margin: 0, fontSize: 13 }}>
            Standing here is keyed to a verified human, not a wallet — an agent
            cannot rotate keypairs past a bar. Verification mirrors AgentBook onto
            the human-backing registry this protocol&rsquo;s gates read.
          </p>
          <p style={{ margin: 0, fontSize: 13 }}>
            <a href={world.explorer} target="_blank" rel="noreferrer">
              AgentBook on World Chain ↗
            </a>{" "}
            · <a href="/agents/register">verify an agent →</a>
          </p>
        </div>
      </div>
    </section>
  );
}
