import Link from "next/link";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";
import { contractLinks, operatorStanding, votivePositions } from "@/lib/protocolState";
import { recentTxs, type RecordedTx, type TxTrack } from "@/lib/txLog";
import { readAquaPosition } from "@/lib/aquaPosition";
import { AquaPanel } from "@/app/AquaPanel";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Live proof · Votive",
  description:
    "Every transaction the protocol has sent, and the state of every position read straight from the contracts.",
};

const TRACK_LABEL: Record<TxTrack, string> = {
  votive: "Votive",
  world: "World — human backing, standing, commons",
  hedera: "Hedera — agentic payments",
  aqua: "1inch Aqua",
};

const eth = (v: bigint, symbol = "ETH"): string => {
  const whole = v / 10n ** 18n;
  const frac = ((v % 10n ** 18n) * 10_000n) / 10n ** 18n;
  return `${whole}.${frac.toString().padStart(4, "0")} ${symbol}`;
};

const short = (a: string): string => `${a.slice(0, 8)}…${a.slice(-4)}`;

const KINDS = ["Release on condition", "Real-world task", "Share with everyone waiting"];

/**
 * The page for somebody who wants to check rather than be told.
 *
 * Two halves, and the split is the point. **What happened** comes from our own
 * record, written the moment each transaction was broadcast — complete, instant,
 * and not at the mercy of an endpoint that caps how far back it will look.
 * **What is true now** comes from the contracts' own view functions on every
 * load, because a cached balance is a wrong balance as soon as anybody transacts
 * without us.
 */
export default async function LivePage() {
  const demoWallet = process.env.DEMO_WALLET_ADDRESS as `0x${string}` | undefined;

  const [txs, positions, standing, aqua] = await Promise.all([
    recentTxs(200).catch((): RecordedTx[] => []),
    votivePositions(50).catch(() => []),
    demoWallet ? operatorStanding(demoWallet).catch(() => null) : Promise.resolve(null),
    readAquaPosition().catch(() => null),
  ]);

  const byTrack = (t: TxTrack) => txs.filter((x) => x.track === t);
  const links = contractLinks();

  return (
    <main>
      <SectionNav section="research" />
      <PageHead
        title="Everything this protocol has actually done"
        description="Transactions from our own record, written as each was sent. Positions and standing read from the contracts on every load — never cached."
      />

      <section className="cards" style={{ marginBottom: 24 }}>
        <div className="card">
          <span className="card-label">Transactions recorded</span>
          <span className="card-value">{txs.length}</span>
        </div>
        <div className="card">
          <span className="card-label">Wishes open</span>
          <span className="card-value">{positions.length}</span>
        </div>
        <div className="card">
          <span className="card-label">Chains</span>
          <span className="card-value">2</span>
        </div>
        <div className="card">
          <span className="card-label">Integrations</span>
          <span className="card-value">3</span>
        </div>
      </section>

      {/* -------------------------------------------------- positions, live */}
      <section style={{ marginBottom: 34 }}>
        <h2>Positions, read from the contracts</h2>
        <p className="dim" style={{ fontSize: 13, marginTop: 0 }}>
          <code>factory.allVotives()</code>, then <code>state()</code>,{" "}
          <code>principal()</code>, <code>parked()</code> and{" "}
          <code>pendingStream()</code> on each. One call per fact, no cache, no
          event replay.
        </p>
        {positions.length === 0 ? (
          <p className="empty">No wishes open on this deployment yet.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Wish</th>
                <th>State</th>
                <th>Kind</th>
                <th>Principal</th>
                <th>Parked</th>
                <th>Stream owed</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.address}>
                  <td>
                    <Link href={`/wish/${p.address}`}>
                      <code>{short(p.address)}</code>
                    </Link>
                  </td>
                  <td>{p.stateName}</td>
                  <td className="dim">{KINDS[p.kind] ?? "?"}</td>
                  <td>{eth(p.principal)}</td>
                  <td>{eth(p.parked)}</td>
                  <td className="dim">{eth(p.pendingStream)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ------------------------------------------------ standing, live */}
      {standing && (
        <section style={{ marginBottom: 34 }}>
          <h2>The demo operator, read from the contracts</h2>
          <p className="dim" style={{ fontSize: 13, marginTop: 0 }}>
            One wallet, asked of <code>HumanBackingRegistry</code>,{" "}
            <code>StandingLedger</code>, <code>CommonsPool</code> and the access
            gate. There is no way to enumerate humans from the chain — that is the
            privacy property working, not a gap.
          </p>
          <table className="grid">
            <tbody>
              <tr>
                <td>Wallet</td>
                <td>
                  <code>{standing.wallet}</code>
                </td>
              </tr>
              <tr>
                <td>Human behind it</td>
                <td>
                  {standing.humanId ? (
                    <code>{short(standing.humanId)}</code>
                  ) : (
                    <span className="dim">not verified</span>
                  )}
                </td>
              </tr>
              <tr>
                <td>Assurance tier</td>
                <td>{["none", "device", "selfie", "orb"][standing.assurance] ?? "?"}</td>
              </tr>
              <tr>
                <td>Wallets this human holds</td>
                <td>{standing.walletCount.toString()}</td>
              </tr>
              <tr>
                <td>Barred</td>
                <td>{standing.barred ? "yes" : "no"}</td>
              </tr>
              <tr>
                <td>Standing multiplier</td>
                <td>{Number(standing.multiplierBps) / 100}% of base</td>
              </tr>
              <tr>
                <td>Delivered / failed / reported</td>
                <td>
                  {standing.fulfilments} / {standing.failures} / {standing.reports}
                </td>
              </tr>
              <tr>
                <td>Commons allowance this epoch</td>
                <td>
                  {eth(standing.remaining)} left of {eth(standing.ceiling)}
                </td>
              </tr>
              <tr>
                <td>Admitted by the access gate</td>
                <td>{standing.admitted ? "yes" : "no"}</td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {/* --------------------------------------------------- what happened */}
      {(["votive", "world", "hedera"] as TxTrack[]).map((track) => {
        const rows = byTrack(track);
        return (
          <section key={track} style={{ marginBottom: 34 }}>
            <h2>{TRACK_LABEL[track]}</h2>
            {rows.length === 0 ? (
              <p className="empty">
                Nothing recorded on this deployment yet. This page shows only real
                transactions, so it stays empty until there are some.
              </p>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>What happened</th>
                    <th>Detail</th>
                    <th>Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.txHash}-${row.what}`}>
                      <td>{row.what}</td>
                      <td className="dim">
                        <code style={{ fontSize: 12 }}>{row.detail}</code>
                      </td>
                      <td>
                        <a href={row.explorerUrl} target="_blank" rel="noreferrer">
                          <code>
                            {row.txHash.slice(0, 10)}…{row.txHash.slice(-6)}
                          </code>
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      <AquaPanel position={aqua} />

      {/* ------------------------------------------------------- addresses */}
      <section style={{ marginBottom: 24 }}>
        <h2>Deployed contracts</h2>
        <table className="grid">
          <tbody>
            {links.map((c) => (
              <tr key={c.address}>
                <td>{c.label}</td>
                <td className="dim">{c.chain}</td>
                <td>
                  <a href={c.explorerUrl} target="_blank" rel="noreferrer">
                    <code>{c.address}</code>
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="note">
        Contract sources are in <code>contracts/</code> and <code>aqua/</code>; the
        deployment record is <code>deployments/testnet.md</code> and the
        requirement-by-requirement writeup is{" "}
        <code>docs/prize-compliance.md</code>.
      </p>
    </main>
  );
}
