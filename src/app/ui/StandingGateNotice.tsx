/**
 * Whether the rail on this page actually checks standing before letting an agent
 * take work on — asked, not asserted.
 *
 * `/rail` has been stating the gate as a fact while pointed at the Hedera rail,
 * whose `standing()` getter returns nothing: that bytecode predates the check,
 * `standing` is immutable and the contract has no owner, so it cannot be fixed in
 * place. The Base rail does gate, through the adapter. One sentence cannot be
 * true of both, and a page has no business guessing which rail it is on.
 *
 * So this renders one of exactly three things, and the third is not a softened
 * version of the first two: gated by a named adapter, not gated (with the reason
 * the bytecode gives), or *we could not check* — which is a statement about our
 * endpoint and must never be dressed up as a statement about the contract.
 *
 * The distinction is harder than it looks, which is why {@link readStandingGate}
 * corroborates a claimed revert with a second call before believing it.
 */
import type { TxChain } from "@/lib/txLog";
import { adapterKnowsRail } from "@/lib/chainReads";
import { explorerAddress } from "@/lib/txLog";
import { readStandingGate } from "@/lib/skillReadiness";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function StandingGateNotice({
  rail,
  chain,
  testId,
}: {
  rail: string;
  chain: TxChain;
  /** Only needed when a page renders this more than once — two rails on one page
   *  would otherwise share an id, and a test asserting on it would match
   *  whichever came first. */
  testId?: string;
}) {
  const id = testId ?? "standing-gate-notice";

  if (!ADDRESS_RE.test(rail)) {
    return (
      <p className="muted" data-testid={id} data-gate="no-rail">
        No bounty rail is configured for this deployment, so there is nothing to
        check.
      </p>
    );
  }

  const address = rail as `0x${string}`;
  const gate = await readStandingGate(address, chain);

  if (gate.state === "unknown") {
    return (
      <p className="muted" data-testid={id} data-gate="unknown">
        <span className="badge fail">unknown</span> Could not check whether this
        rail gates claims on standing — treat the question as open, not as a no.{" "}
        <span className="mono">{gate.because}</span>
      </p>
    );
  }

  if (gate.state === "ungated") {
    return (
      <p className="muted" data-testid={id} data-gate="ungated">
        <span className="badge waiting">not gated</span>{" "}
        {gate.reverted
          ? "This rail has no standing() function, so its bytecode predates the standing check. Claims here are not gated on human backing, and cannot be — standing is immutable and the contract has no owner."
          : "This rail was deployed without a standing adapter, so claims here are not gated on human backing."}{" "}
        Standing still governs the resource commons and the shared capital; it just
        does not govern taking work on <em>this</em> rail.
      </p>
    );
  }

  const knows = await adapterKnowsRail(gate.adapter, address);

  return (
    <p className="muted" data-testid={id} data-gate="gated">
      <span className="badge pass">gated</span> Claims on this rail revert unless a
      verified human backs the wallet and is not barred, checked through the
      standing adapter at{" "}
      <a
        className="mono"
        href={explorerAddress(chain, gate.adapter)}
        rel="noreferrer noopener"
        target="_blank"
      >
        {gate.adapter.slice(0, 10)}…{gate.adapter.slice(-6)}
      </a>
      {knows.ok
        ? knows.value
          ? ", which recognises this rail as one it records outcomes for."
          : ". The adapter does not recognise this rail, so the gate holds but fulfilments and failures recorded from here would be refused."
        : ". Whether that adapter recognises this rail could not be read."}
    </p>
  );
}
