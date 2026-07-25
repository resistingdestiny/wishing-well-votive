import { graphWishTimeline } from "@/lib/graph";
import { chainConfig } from "@/lib/chain";

export async function OnchainHistory({ address }: { address: `0x${string}` }) {
  const timeline = await graphWishTimeline(address);
  if (!timeline || timeline.events.length === 0) return null;

  const { chainId } = chainConfig();
  const txUrl =
    chainId === 84532
      ? (tx: string) => `https://sepolia.basescan.org/tx/${tx}`
      : null;

  return (
    <>
      <h2>On-chain history</h2>
      <div className="panel" data-testid="onchain-history" data-reveal>
        <p className="muted" style={{ marginTop: 0 }}>
          Event-sourced from the cell&rsquo;s own logs, indexed by The Graph
          (block #{timeline.block}). Fees and payouts here are the transparency
          ledger: nothing leaves a cell without a row below.
        </p>
        <div className="timeline">
          {timeline.events.map((e) => (
            <div key={e.id} className={`tlItem ${tlTone(e.label)}`.trim()}>
              <div>
                <span>{e.label}</span>{" "}
                <span className="muted" style={{ fontSize: "0.82rem" }}>
                  {new Date(e.at * 1000).toISOString().replace("T", " ").slice(0, 19)}
                </span>
              </div>
              <div className="muted" style={{ fontSize: "0.85rem" }}>
                {e.detail ? <>{e.detail} · </> : null}
                <span className="mono">
                  {txUrl ? (
                    <a href={txUrl(e.tx)} target="_blank" rel="noreferrer">
                      {e.tx.slice(0, 10)}…
                    </a>
                  ) : (
                    <>{e.tx.slice(0, 10)}…</>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function tlTone(label: string): string {
  if (/→ (Fulfilled|Claimable|Closed)|payout|claimed|swept|fee (collected|taken)/i.test(label))
    return "gold";
  if (/accrued|attested/i.test(label)) return "dim";
  return "";
}
