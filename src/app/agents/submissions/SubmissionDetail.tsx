import Link from "next/link";
import type { PublicSubmission } from "@/core/submissions/view";
import { shortAddr, shortHash } from "@/lib/format";
import { explorerTx, explorerAddress } from "@/lib/txLog";
import { StatusBadge, Countdown } from "./status";
import { VotePanel } from "./VotePanel";
import { SettlePanel } from "./SettlePanel";
import { ReportPanel } from "./ReportPanel";

/**
 * The whole of one submission: the claim, where it stands, who objected, and the
 * actions still open on it.
 *
 * Everything shown is off the server-computed `PublicSubmission` — the status, the
 * tally, the time remaining. The interactive parts (`VotePanel`, `SettlePanel`) are
 * client islands that each decide for themselves whether they apply, so this
 * component stays a straight render of facts and never has to branch on state to
 * decide what to offer.
 *
 * The transaction hashes are shown when they exist and linked to the explorer, and
 * a settled row says settled because `settledAt` is set — a chain fact — not because
 * a window closed.
 */
export function SubmissionDetail({ submission }: { submission: PublicSubmission }) {
  const s = submission;
  const backHref =
    s.kind === "solution" ? "/agents/solutions" : "/agents/resource-requests";
  const backLabel = s.kind === "solution" ? "All solutions" : "All resource requests";

  return (
    <div className="stack">
      <p style={{ margin: 0 }}>
        <Link href={backHref} className="muted">
          ← {backLabel}
        </Link>
      </p>

      <div className="panel stack">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: "0.8rem" }}>
          <h2 style={{ margin: 0 }}>{s.title}</h2>
          <StatusBadge submission={s} />
        </div>
        <Countdown submission={s} />

        <p style={{ whiteSpace: "pre-wrap", maxWidth: "76ch", margin: "0.4rem 0" }}>{s.body}</p>

        <div className="tableWrap">
          <table>
            <tbody>
              <tr>
                <td style={{ whiteSpace: "nowrap" }}>Agent</td>
                <td className="mono">{s.agentWallet}</td>
              </tr>
              {s.wish ? (
                <tr>
                  <td>Wish</td>
                  <td className="mono">
                    <a href={explorerAddress("base-sepolia", s.wish)} target="_blank" rel="noreferrer">
                      {s.wish}
                    </a>
                  </td>
                </tr>
              ) : null}
              {s.railAddress ? (
                <tr>
                  <td>Rail / bounty</td>
                  <td className="mono">
                    <a href={explorerAddress("base-sepolia", s.railAddress)} target="_blank" rel="noreferrer">
                      {shortAddr(s.railAddress)}
                    </a>{" "}
                    #{s.bountyId}
                  </td>
                </tr>
              ) : null}
              {s.resultHash ? (
                <tr>
                  <td>Milestone</td>
                  <td className="mono" style={{ wordBreak: "break-all" }}>{s.resultHash}</td>
                </tr>
              ) : null}
              {s.resourceKind ? (
                <tr>
                  <td>Resource</td>
                  <td>
                    <span className="badge">{s.resourceKind}</span>{" "}
                    {s.resourceId ? <span className="mono">{s.resourceId}</span> : <span className="muted">the wish principal</span>}
                  </td>
                </tr>
              ) : null}
              {s.amountWei ? (
                <tr>
                  <td>Amount</td>
                  <td className="mono">{s.amountWei} wei</td>
                </tr>
              ) : null}
              <tr>
                <td>Submitted</td>
                <td>{new Date(s.submittedAt).toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* The tally: what the votes add up to, weighted. */}
      <div className="panel stack" data-testid="tally">
        <h3 style={{ margin: 0 }}>Where it stands</h3>
        <div className="row" style={{ gap: "1.5rem", flexWrap: "wrap" }}>
          <div>
            <div className="muted" style={{ fontSize: "0.75rem" }}>Approving weight</div>
            <div className="mono" data-testid="tally-approve">{s.tally.approveBps} bps</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: "0.75rem" }}>Objecting weight</div>
            <div className="mono" data-testid="tally-reject">{s.tally.rejectBps} bps</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: "0.75rem" }}>Votes</div>
            <div className="mono">{s.tally.approvals} approve · {s.tally.rejections} object</div>
          </div>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: "0.82rem", maxWidth: "70ch" }}>
          Weight is each human&rsquo;s standing at the block they signed, floored at
          parity for a verified human and zero for a barred one. A contested claim is
          approved only if approving weight strictly outweighs objecting weight; an
          uncontested one is approved by silence when the window closes.
        </p>
      </div>

      <VotePanel submission={s} />
      <SettlePanel submission={s} />
      <ReportPanel submission={s} />

      {/* On-chain record, shown only once it exists. Never intent — these are hashes. */}
      {s.attestTxHash || s.releaseTxHash || s.reportTxHash ? (
        <div className="panel stack" data-testid="onchain-record">
          <h3 style={{ margin: 0 }}>On chain</h3>
          <ul className="stack" style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {s.attestTxHash ? (
              <li>
                Milestone attested:{" "}
                <a className="mono" href={explorerTx("base-sepolia", s.attestTxHash)} target="_blank" rel="noreferrer">
                  {shortHash(s.attestTxHash)}
                </a>
              </li>
            ) : null}
            {s.releaseTxHash ? (
              <li>
                Bounty released:{" "}
                <a className="mono" href={explorerTx("base-sepolia", s.releaseTxHash)} target="_blank" rel="noreferrer">
                  {shortHash(s.releaseTxHash)}
                </a>
              </li>
            ) : null}
            {s.reportTxHash ? (
              <li>
                Conduct reported:{" "}
                <a className="mono" href={explorerTx("base-sepolia", s.reportTxHash)} target="_blank" rel="noreferrer">
                  {shortHash(s.reportTxHash)}
                </a>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {/* The objections, in the open. Approvals are counted; objections are read. */}
      {s.votes.some((v) => v.choice === "reject") ? (
        <div className="panel stack" data-testid="objections">
          <h3 style={{ margin: 0 }}>Objections</h3>
          {s.votes
            .filter((v) => v.choice === "reject")
            .map((v) => (
              <div key={v.humanId} style={{ borderTop: "1px solid var(--hairline)", paddingTop: "0.6rem" }}>
                <div className="row" style={{ gap: "0.6rem", fontSize: "0.8rem" }}>
                  <span className="mono muted">{shortAddr(v.voter)}</span>
                  <span className="muted">{v.weightBps} bps</span>
                  <span className="muted">{new Date(v.createdAt).toLocaleString()}</span>
                </div>
                {v.reason ? <p style={{ margin: "0.3rem 0 0", maxWidth: "72ch" }}>{v.reason}</p> : null}
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}
