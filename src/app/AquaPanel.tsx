import { explainBlocker, type AquaPosition } from "@/lib/aquaPosition";

/**
 * The Aqua position, read from the chain like everything else here.
 *
 * The official Aqua contract is not deployed on Base Sepolia, so we deployed it —
 * the bytecode is the package's, unmodified — which means the position is a thing
 * with an address that anyone can query rather than something that only exists
 * inside a script run.
 *
 * The gates shown are read from the same attestation registry the VM reads. That
 * is the whole claim of this integration: a position that cannot be filled until
 * the frontier reaches the job the wish was opened for, and the page cannot say
 * otherwise than the VM would.
 */
export function AquaPanel({ position }: { position: AquaPosition | null }) {
  if (!position) {
    return (
      <section style={{ marginBottom: 34 }}>
        <h2>1inch Aqua</h2>
        <p className="empty">
          No Aqua position is configured for this deployment. Ship one with{" "}
          <code>aqua/script/ShipVotivePosition.s.sol</code>.
        </p>
      </section>
    );
  }

  const token = (v: bigint, symbol: string): string => {
    const whole = v / 10n ** 18n;
    const frac = ((v % 10n ** 18n) * 10_000n) / 10n ** 18n;
    return `${whole}.${frac.toString().padStart(4, "0")} ${symbol}`;
  };

  return (
    <section style={{ marginBottom: 34 }}>
      <h2>
        1inch Aqua{" "}
        <span className="dim" style={{ fontWeight: 400, fontSize: "0.75em" }}>
          on Base Sepolia
        </span>
      </h2>
      <p className="dim" style={{ fontSize: 13, marginTop: 0 }}>
        A wish as a position somebody else can take the other side of. Priced by{" "}
        {position.opcodeCount} SwapVM instructions appended to the official set at
        index {position.opcodeBase} — nothing official is replaced, so a program
        the Aqua SDK encodes runs here byte-identically.
      </p>

      <p className={position.fillable ? "note" : "note note-warn"}>
        {explainBlocker(position.blocker)}
      </p>

      <table className="grid">
        <tbody>
          <tr>
            <td>Priced off</td>
            <td>
              <a href={position.explorer.votive} target="_blank" rel="noreferrer">
                <code>{position.votive}</code>
              </a>
            </td>
          </tr>
          <tr>
            <td>Fee threshold (the votive&rsquo;s own principal)</td>
            <td>{token(position.principal, "ETH")}</td>
          </tr>
          <tr>
            <td>Capability demonstrated by some model</td>
            <td>{position.capabilityOpen ? "yes" : "not yet"}</td>
          </tr>
          <tr>
            <td>This wish attested true</td>
            <td>{position.conditionMet ? "yes" : "not yet"}</td>
          </tr>
          <tr>
            <td>Fillable</td>
            <td>{position.fillable ? "yes" : "no"}</td>
          </tr>
          <tr>
            <td>
              In the Aqua vault for this strategy
              <br />
              <span className="dim" style={{ fontSize: 12 }}>
                <code>safeBalances(maker, router, strategy, tokenA, tokenB)</code>
              </span>
            </td>
            <td>
              {token(position.makerTokenA, position.symbolA)}
              {" · "}
              {token(position.makerTokenB, position.symbolB)}
            </td>
          </tr>
          <tr>
            <td>Taker holds</td>
            <td>{token(position.takerTokenB, position.symbolB)}</td>
          </tr>
          <tr>
            <td>Performance fee taken, on the surplus only</td>
            <td>{token(position.treasuryTokenA, position.symbolA)}</td>
          </tr>
          <tr>
            <td>Aqua (official)</td>
            <td>
              <a href={position.explorer.aqua} target="_blank" rel="noreferrer">
                <code>{position.aqua}</code>
              </a>
            </td>
          </tr>
          <tr>
            <td>VotiveAquaRouter</td>
            <td>
              <a href={position.explorer.router} target="_blank" rel="noreferrer">
                <code>{position.router}</code>
              </a>
            </td>
          </tr>
          <tr>
            <td>Strategy</td>
            <td>
              <code style={{ fontSize: 12 }}>{position.strategy}</code>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
