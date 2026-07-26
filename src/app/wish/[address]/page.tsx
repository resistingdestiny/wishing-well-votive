import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isAddress, getAddress } from "viem";
import {
  readCell,
  chainConfig,
  publicClient,
  factoryAbi,
  registryAbi,
  cellNumber,
  RESOLVER_KIND,
} from "@/lib/chain";
import { prisma } from "@/lib/db";
import { explainBlocker, readAquaPosition } from "@/lib/aquaPosition";
import { AquaPanel } from "@/app/AquaPanel";
import { AquaActions } from "./AquaActions";
import { TakePosition } from "./TakePosition";
import { SolvePanel } from "./SolvePanel";
import { amount, shortAddr, days, wishTag, usdEquivalent } from "@/lib/format";
import { OwnerActions } from "./OwnerActions";
import { OnchainHistory } from "./OnchainHistory";
import { WatchButton } from "@/app/WatchButton";
import { ShareButton } from "./ShareButton";
import { SectionNav } from "@/app/SectionNav";
import { agentDataDir } from "@/lib/ingest";
import { ResourceStore } from "@/core/resources/store";
import { toPublic } from "@/core/resources/resource";
import { ResourceCard } from "@/app/ResourceCard";

export async function generateMetadata({
  params,
}: {
  params: { address: string };
}): Promise<Metadata> {
  if (!isAddress(params.address)) return { title: "Wish · Votive" };
  const address = getAddress(params.address);
  try {
    const [num, cell, story] = await Promise.all([
      cellNumber(address),
      readCell(address),
      prisma.story.findUnique({ where: { cell: address } }).catch(() => null),
    ]);
    const summary =
      (story?.parsed as { capability?: { summary?: string } })?.capability?.summary ?? "";
    const title = `Wish ${wishTag(num, address)} · ${summary || cell.kindName} · Votive`;
    const excerpt = story?.prose ? `“${story.prose.slice(0, 120)}${story.prose.length > 120 ? "…" : ""}” ` : "";
    const description = `${excerpt}${amount(cell.balance, cell.assetDecimals, cell.assetSymbol, 3)} parked · ${cell.stateName.toLowerCase()}.`;
    return {
      title,
      description,
      openGraph: { title, description, type: "website" },
      twitter: { card: "summary_large_image", title, description },
    };
  } catch {
    return { title: "Wish · Votive" };
  }
}

export const dynamic = "force-dynamic";

export default async function WishDetail({
  params,
}: {
  params: { address: string };
}) {
  if (!isAddress(params.address)) notFound();
  const address = getAddress(params.address);
  const { factory } = chainConfig();
  if (!factory) notFound();

  const isCell = (await publicClient().readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "isVotive",
    args: [address],
  })) as boolean;
  if (!isCell) notFound();

  const cell = await readCell(address);
  const num = await cellNumber(address).catch(() => 0);
  const story = await prisma.story
    .findUnique({ where: { cell: address } })
    .catch(() =>
      prisma.story.findUnique({ where: { cell: address.toLowerCase() } }).catch(() => null),
    );
  const runs = await prisma.runEntry
    .findMany({
      where: {
        OR: [{ cell: address }, { capabilityId: cell.capabilityId }],
      },
      orderBy: { seq: "desc" },
      take: 50,
    })
    .catch(() => []);

  const uncollected = cell.feesAccrued + cell.pendingFees;

  let beneCount = 0;
  if (cell.hasBeneficiaries) {
    const { wishBeneficiaries } = await import("@/lib/claims");
    beneCount = (await wishBeneficiaries(address)).length;
  }
  const isClaimable = cell.state === 6;

  // The Aqua position for this wish, if one has been shipped. Null is the normal
  // case — most wishes are never made tradeable — so the panel says so rather
  // than showing somebody else's position.
  const aquaPosition = await readAquaPosition(cell.address).catch(() => null);

  const { registry } = chainConfig();
  let resolverBinding: { kind: string; met: boolean } | null = null;
  // The capability gate, read for the same reason the condition is: the Solve
  // panel needs to know which of the two attestations are already in place so it
  // can skip the ones the registry has recorded rather than reverting on them.
  let capabilityOpen = false;
  if (registry) {
    try {
      const pc = publicClient();
      // Our attestation registry answers the condition itself rather than
      // pointing at a resolver contract, so there is no binding to look up first
      // — one call replaces two, and there is no "bound but unmet" state to
      // represent because an unattested condition simply reads false.
      const [met, capOpen] = await Promise.all([
        pc.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "isConditionMet",
          args: [cell.address, cell.conditionHash],
        }) as Promise<boolean>,
        pc.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "isCapabilityOpen",
          args: [cell.capabilityId],
        }) as Promise<boolean>,
      ]);
      resolverBinding = { kind: "attested condition", met };
      capabilityOpen = capOpen;
    } catch {
      resolverBinding = null;
    }
  }

  return (
    <main>
      <SectionNav section="wishes" />
      <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
        <Link href="/explore">← All wishes</Link>
      </p>
      <div style={{ marginBottom: 20 }}>
        {aquaPosition ? <AquaPanel position={aquaPosition} /> : null}
        {/* Shown whether or not a position exists: with one it offers closing,
            without one it offers opening. Only the founder sees either. */}
        <AquaActions
          votive={cell.address}
          founder={cell.wisher}
          positionOpen={Boolean(aquaPosition?.open)}
        />
        {/* Everybody else's half. The founder opens and closes; anyone at all
            takes the other side, which is the point of a wish being tradable
            rather than a box that has to be waited out. */}
        <TakePosition
          votive={cell.address}
          positionOpen={Boolean(aquaPosition?.open)}
          fillable={Boolean(aquaPosition?.fillable)}
          blockerText={
            aquaPosition && aquaPosition.blocker !== "none"
              ? explainBlocker(aquaPosition.blocker)
              : undefined
          }
        />
        {/* Only a Waiting wish can be solved: the gate has to be openable, the
            condition attestable, and the cell in the one state from which
            beginAttempt → fulfil is legal. Every later state has already
            resolved. */}
        {cell.state === 1 ? (
          <SolvePanel
            votive={cell.address}
            capabilityId={cell.capabilityId}
            conditionHash={cell.conditionHash}
            capabilityOpen={capabilityOpen}
            conditionMet={Boolean(resolverBinding?.met)}
          />
        ) : null}
      </div>
      <div
        className={`wishHero${cell.state === 3 || cell.state === 6 ? " fulfilled" : ""}`}
        data-reveal
      >
        <div
          className={`orb ${
            cell.state === 3 || cell.state === 6
              ? "orb-granted"
              : cell.state === 1 || cell.state === 2
                ? "orb-bloom"
                : ""
          }`}
          aria-hidden="true"
        />
        <div className="heroMeta">
          <h1 style={{ marginTop: 0, marginBottom: "0.3rem" }}>
            Wish {wishTag(num, cell.address)}{" "}
            <span className={`badge ${cell.stateName.toLowerCase()}`}>{cell.stateName}</span>
            {cell.isSealed ? (
              <span className="badge sealed" data-testid="sealed-badge">
                🔒 Sealed
              </span>
            ) : null}
          </h1>
          <div className="heroAddr">
            {cell.kindName} · {cell.address}
          </div>
        </div>
      </div>
      <div className="row" style={{ alignItems: "center", gap: "1rem" }}>
        <WatchButton kind="cell" target={cell.address} label="Watch this wish" />
        <ShareButton />
      </div>

      {story ? (
        <>
          <h2>Story</h2>
          <div className="panel" data-reveal>
            <p style={{ whiteSpace: "pre-wrap", marginTop: 0 }}>{story.prose}</p>
            <p className="muted" style={{ marginBottom: 0 }}>
              Kept as interpretive context for amendments. Execution runs off the
              signed schema below, never this prose. On-chain hash:{" "}
              <span className="mono">{cell.storyHash.slice(0, 18)}…</span>
            </p>
          </div>
          {story.fullStory ? (
            <div className="panel" data-testid="full-story" data-reveal>
              <div style={{ fontWeight: 600, marginBottom: "0.4rem" }}>The full story</div>
              <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{story.fullStory}</p>
              <p className="muted" style={{ marginBottom: 0, marginTop: "0.6rem" }}>
                The complete vision the depositor wrote, handed to the agent as context
                when it executes or amends this wish.
              </p>
            </div>
          ) : null}
        </>
      ) : null}

      <h2>Funds &amp; fees</h2>
      {cell.kindName === "DistributeToActive" ? (
        <p className="muted" data-testid="distribute-note" style={{ margin: "0 0 0.5rem", fontSize: "0.85rem" }}>
          <strong>Securities-safe distribution:</strong> at resolution your principal returns to
          you and only the realised overflow above it is routed to a transparent public
          destination. No one profits from another depositor&rsquo;s effort. Pooling proceeds
          pro-rata to contributors is an accredited-only option (KYC + a signed risk attestation).
        </p>
      ) : null}
      {!cell.assetIsNative ? (
        <p className="muted" data-testid="funding-asset" style={{ margin: "0 0 0.5rem" }}>
          Funded in <strong>{cell.assetSymbol}</strong>{" "}
          <span className="mono">({shortAddr(cell.asset)})</span>, a segregated ERC-20 cell.
        </p>
      ) : null}
      <div className="grid cols-3" data-reveal>
        <div className="panel stat">
          <div className="value">{amount(cell.balance, cell.assetDecimals, cell.assetSymbol)}</div>
          <div className="label">
            cell balance (segregated)
            {(() => {
              const usd = usdEquivalent(cell.balance, cell.assetDecimals, cell.assetSymbol, cell.assetIsNative);
              return usd ? <span className="muted"> · {usd}</span> : null;
            })()}
          </div>
        </div>
        <div className="panel stat">
          <div className="value">{amount(cell.principal, cell.assetDecimals, cell.assetSymbol)}</div>
          <div className="label">principal at creation</div>
        </div>
        <div className="panel stat">
          <div className="value">{amount(cell.parked, cell.assetDecimals, cell.assetSymbol)}</div>
          <div className="label">parked (net of streamed fees)</div>
        </div>
        <div className="panel stat">
          <div className="value">{amount(uncollected, cell.assetDecimals, cell.assetSymbol, 6)}</div>
          <div className="label">2%/yr stream fee accrued</div>
        </div>
        <div className="panel stat">
          <div className="value">{amount(cell.extraProceeds, cell.assetDecimals, cell.assetSymbol, 6)}</div>
          <div className="label">extra proceeds (8% fee at resolution)</div>
        </div>
        <div className="panel stat">
          <div className="value">{amount(cell.perfFeeTaken, cell.assetDecimals, cell.assetSymbol, 6)}</div>
          <div className="label">performance fee taken</div>
        </div>
        {cell.distributionRoot !==
        "0x0000000000000000000000000000000000000000000000000000000000000000" ? (
          <div className="panel stat" data-testid="distribution-pot">
            <div className="value">
              {amount(
                cell.distributionTotal - cell.distributionClaimed,
                cell.assetDecimals,
                cell.assetSymbol,
              )}
            </div>
            <div className="label">
              distribution pot unclaimed (of{" "}
              {amount(cell.distributionTotal, cell.assetDecimals, cell.assetSymbol)}). Pull yours below
            </div>
          </div>
        ) : null}
      </div>

      {cell.hasBeneficiaries ? (
        <div className="panel stack" data-testid="claim-panel" data-reveal style={{ marginTop: "1rem" }}>
          <div>
            <span className={`badge ${cell.stateName.toLowerCase()}`}>{cell.stateName}</span>{" "}
            <strong>Named-beneficiary wish</strong>
          </div>
          {isClaimable ? (
            <>
              <p className="lede" style={{ margin: 0 }}>
                This wish resolved to {beneCount} named {beneCount === 1 ? "beneficiary" : "beneficiaries"}. They
                claim by proving who they are (KYC + a match against the descriptor the depositor signed). Personal
                data never goes on chain, only its hash.
              </p>
              <div className="grid cols-3">
                <div className="panel stat">
                  <div className="value">{amount(cell.claimUnclaimed, cell.assetDecimals, cell.assetSymbol)}</div>
                  <div className="label">
                    claim pot unclaimed (of {amount(cell.claimTotal, cell.assetDecimals, cell.assetSymbol)})
                  </div>
                </div>
                <div className="panel stat">
                  <div className="value" data-count={beneCount}>{beneCount}</div>
                  <div className="label">named beneficiaries</div>
                </div>
                <div className="panel stat">
                  <div className="value">
                    {amount(cell.claimClaimed, cell.assetDecimals, cell.assetSymbol)}
                  </div>
                  <div className="label">claimed so far</div>
                </div>
              </div>
              <p className="muted" style={{ margin: 0 }}>
                Each named beneficiary received a private claim invitation link. A close-but-inexact match routes to
                a guardian for manual review; whatever is never claimed escheats when the claim window closes.
              </p>
            </>
          ) : (
            <p className="lede" style={{ margin: 0 }}>
              Payout is set aside for {beneCount} {beneCount === 1 ? "person" : "people"} named by identity. When the
              wish is granted it enters a Claimable state and each of them claims their share after KYC: via a bank
              account or a wallet, no crypto required.
            </p>
          )}
        </div>
      ) : null}

      <h2>Manage this wish</h2>
      <OwnerActions address={cell.address} />

      <h2>Schema (what actually executes)</h2>
      <div className="panel tableWrap" data-reveal>
        <table>
          <tbody>
            <tr>
              <th>Depositor</th>
              <td className="mono">{cell.wisher}</td>
            </tr>
            <tr>
              <th>Guardian</th>
              <td className="mono">
                {cell.guardian === "0x0000000000000000000000000000000000000000"
                  ? "none"
                  : cell.guardian}
              </td>
            </tr>
            <tr>
              <th>Amendment</th>
              <td>
                {cell.isSealed
                  ? "sealed: irrevocable; can never be amended or revoked, only fulfilled or escheated"
                  : "amendable by the depositor (or guardian after inactivity)"}
              </td>
            </tr>
            <tr>
              <th>Escheat destination</th>
              <td>
                {cell.positioned ? (
                  <>
                    the position holder <span className="mono">{shortAddr(cell.payee)}</span>
                  </>
                ) : cell.fallbackBeneficiary === "0x0000000000000000000000000000000000000000" ? (
                  "platform (backstop)"
                ) : (
                  <span className="mono">{cell.fallbackBeneficiary}</span>
                )}
              </td>
            </tr>
            {/* Only when the beneficiary is a registry that makes the claim
                transferable. This row used to render on every wish and name an
                ERC-721 that no contract in this repo implements — `positioned`
                was an address cast to a boolean, so it was true for everyone.
                No such registry is deployed, so today it renders for nobody. */}
            {cell.positioned ? (
              <tr data-testid="position-row">
                <th>Payout claim</th>
                <td>
                  Held by the position registry at{" "}
                  <span className="mono">{cell.payee}</span>, which pays whoever holds
                  the claim at fulfilment. Amendment stays with the depositor&rsquo;s key.
                </td>
              </tr>
            ) : null}
            <tr>
              <th>Beneficiary</th>
              <td className="mono">
                {cell.positioned
                  ? "the position registry (above)"
                  : cell.beneficiary === "0x0000000000000000000000000000000000000000"
                    ? "depositor"
                    : cell.beneficiary}
              </td>
            </tr>
            <tr>
              <th>Capability required</th>
              <td>
                <span className="mono">{cell.capabilityId.slice(0, 18)}…</span>
                {story ? (
                  <div className="muted">
                    {(story.parsed as { capability?: { summary?: string } })?.capability
                      ?.summary ?? ""}
                  </div>
                ) : null}
              </td>
            </tr>
            <tr>
              <th>Resolution condition</th>
              <td>
                {resolverBinding ? (
                  <div data-testid="resolver-badge" style={{ marginBottom: "0.25rem" }}>
                    <span className={`badge ${resolverBinding.met ? "fulfilled" : "waiting"}`}>
                      Trustless · {resolverBinding.kind} · {resolverBinding.met ? "met" : "not yet met"}
                    </span>{" "}
                    <span className="muted">resolved on chain, no oracle attestation.</span>
                  </div>
                ) : null}
                <span className="mono">{cell.conditionHash.slice(0, 18)}…</span>
                {story ? (
                  <div className="muted">
                    {(story.parsed as { condition?: { summary?: string } })?.condition
                      ?.summary ?? ""}
                  </div>
                ) : null}
              </td>
            </tr>
            <tr>
              <th>Timeouts</th>
              <td>
                guardian amend after {days(cell.timeouts.amendAfter)} inactivity ·
                escheat after {days(cell.timeouts.escheatAfter)} · attempt expiry{" "}
                {days(cell.timeouts.attemptAfter)}
              </td>
            </tr>
            {cell.actionBudget > 0n ? (
              <tr>
                <th>Action budget</th>
                <td>{amount(cell.actionBudget, cell.assetDecimals, cell.assetSymbol)} (experimental off-chain action)</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <OnchainHistory address={cell.address} />

      {(() => {
        const resources = new ResourceStore(agentDataDir()).forCell(address).map(toPublic);
        return resources.length > 0 ? (
          <>
            <h2>Agent resources</h2>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              What this wish&rsquo;s agent may draw on (wish-scoped grants + the shared toolbelt).
              Grants extend its token / USD budget; each use is logged below.
            </p>
            <div className="ledger-grid">
              {resources.map((r) => (
                <ResourceCard key={r.id} r={r} />
              ))}
            </div>
          </>
        ) : null;
      })()}

      <h2>Agent activity</h2>
      {runs.length === 0 ? (
        <p className="muted">No sweeps have touched this wish yet.</p>
      ) : (
        <div className="panel tableWrap" data-reveal>
          <table data-testid="activity-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Model</th>
                <th>Result</th>
                <th>Tokens</th>
                <th>Evidence hash</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.seq}>
                  <td className="muted">{r.ts.toISOString().replace("T", " ").slice(0, 19)}</td>
                  <td>{r.kind}</td>
                  <td className="mono">{r.model}</td>
                  <td>
                    {r.pass === null ? (
                      <span className="muted">-</span>
                    ) : r.pass ? (
                      <span className="badge pass">pass</span>
                    ) : (
                      <span className="badge fail">fail</span>
                    )}
                    {r.score !== null ? (
                      <span className="muted"> {Math.round((r.score ?? 0) * 100)}%</span>
                    ) : null}
                  </td>
                  <td className="muted">{r.inputTokens + r.outputTokens}</td>
                  <td className="mono muted">
                    <a href={`/proof/${r.hash}`} title="Verify this attestation">
                      {r.hash.slice(0, 12)}…
                    </a>
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
