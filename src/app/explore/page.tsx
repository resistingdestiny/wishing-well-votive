import Link from "next/link";
import { Suspense } from "react";
import { listAllCells } from "@/lib/chain";
import { prisma } from "@/lib/db";
import { amount, eth, shortAddr, usdEquivalent } from "@/lib/format";
import { GraphStats } from "./GraphStats";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";
import { EmptyState } from "@/app/ui/EmptyState";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "All wishes · Votive",
  description: "Every wish in Votive: one segregated on-chain cell each, live balances and fees.",
};

export default async function Explore() {
  let cells: Awaited<ReturnType<typeof listAllCells>> = [];
  let chainError: string | undefined;
  try {
    cells = await listAllCells();
  } catch (e) {
    chainError = (e as Error).message;
  }
  const stories = await prisma.story
    .findMany({ where: { cell: { not: null } } })
    .catch(() => []);
  const storyByCell = new Map(stories.map((s) => [s.cell!.toLowerCase(), s]));

  const inWell = cells.filter((c) => c.state === 1 || c.state === 2).length;
  const executed = cells.filter((c) => c.state === 3).length;

  const parked = cells
    .filter((c) => (c.state === 1 || c.state === 2) && c.assetIsNative)
    .reduce((sum, c) => sum + c.balance, 0n);

  return (
    <main>
      <SectionNav section="wishes" />
      <PageHead
        title="All wishes"
        description="Every wish on the platform, one segregated cell each, with its lifecycle state, balance and accrued fees. Open any row for the full picture."
      />

      {cells.length > 0 ? (
        <div className="kpiRow" data-stagger>
          <div className="panel stat">
            <div className="value" data-count={inWell}>{inWell}</div>
            <div className="label">wishes in Votive</div>
          </div>
          <div className="panel stat">
            <div className="value">{eth(parked, 3)}</div>
            <div className="label">
              value parked{" "}
              <span className="muted">({usdEquivalent(parked, 18, "ETH", true)}, ETH cells)</span>
            </div>
          </div>
          <div className="panel stat">
            <div className="value" data-count={executed}>{executed}</div>
            <div className="label">executed to date</div>
          </div>
        </div>
      ) : null}
      <Suspense
        fallback={
          <div className="panel" aria-hidden="true">
            <div className="skeleton" style={{ width: "64%", marginBottom: "0.55rem" }} />
            <div className="skeleton" style={{ width: "41%" }} />
          </div>
        }
      >
        <GraphStats />
      </Suspense>
      {chainError ? (
        <p className="error">Chain unreachable: {chainError}</p>
      ) : cells.length === 0 ? (
        <EmptyState
          testId="explore-empty"
          title="Votive is empty"
          body="Every wish gets its own segregated cell. The first one starts the record."
          action={
            <>
              <Link href="/create" className="pill pillPrimary">
                Make the first wish
              </Link>
              <Link href="/guide" className="pill">
                See how it works
              </Link>
            </>
          }
        />
      ) : (
        <div className="panel tableWrap" data-reveal>
          <table data-testid="cells-table">
            <thead>
              <tr>
                <th>Wish</th>
                <th>State</th>
                <th>Type</th>
                <th>Depositor</th>
                <th>Principal</th>
                <th>Balance</th>
                <th>Fees accrued</th>
              </tr>
            </thead>
            <tbody>
              {cells.map((c) => {
                const story = storyByCell.get(c.address.toLowerCase());
                return (
                  <tr key={c.address}>
                    <td>
                      <Link href={`/wish/${c.address}`} className="mono">
                        {shortAddr(c.address)}
                      </Link>
                      {story ? (
                        <div className="muted" style={{ maxWidth: "28ch" }}>
                          {story.prose.slice(0, 80)}
                          {story.prose.length > 80 ? "…" : ""}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <span className={`badge ${c.stateName.toLowerCase()}`}>
                        {c.stateName}
                      </span>
                    </td>
                    <td>{c.kindName}</td>
                    <td className="mono">{shortAddr(c.wisher)}</td>
                    <td>{amount(c.principal, c.assetDecimals, c.assetSymbol)}</td>
                    <td>
                      {amount(c.balance, c.assetDecimals, c.assetSymbol)}
                      {(() => {
                        const usd = usdEquivalent(c.balance, c.assetDecimals, c.assetSymbol, c.assetIsNative);
                        return usd ? <div className="muted" style={{ fontSize: "0.8em" }}>{usd}</div> : null;
                      })()}
                    </td>
                    <td>{amount(c.feesAccrued + c.pendingFees, c.assetDecimals, c.assetSymbol, 6)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
