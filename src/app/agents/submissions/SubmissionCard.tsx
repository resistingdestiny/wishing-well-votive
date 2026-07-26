import Link from "next/link";
import type { PublicSubmission } from "@/core/submissions/view";
import { shortAddr } from "@/lib/format";
import { StatusBadge, Countdown } from "./status";

/**
 * One submission in a list. A summary and a link, never the whole claim — the
 * detail page is where the body, the votes, and the actions live. The status and
 * countdown come straight off the server-computed `PublicSubmission`; this renders
 * them and derives nothing.
 */
export function SubmissionCard({ submission }: { submission: PublicSubmission }) {
  const href =
    submission.kind === "solution"
      ? `/agents/solutions/${submission.id}`
      : `/agents/resource-requests/${submission.id}`;

  return (
    <article className="panel" data-testid="submission-card" data-status={submission.status}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: "0.8rem" }}>
        <h3 style={{ margin: 0 }}>
          <Link href={href}>{submission.title}</Link>
        </h3>
        <StatusBadge submission={submission} />
      </div>

      <p className="muted" style={{ margin: "0.4rem 0", maxWidth: "72ch" }}>
        {submission.body.length > 240 ? `${submission.body.slice(0, 240)}…` : submission.body}
      </p>

      <div className="row" style={{ gap: "1rem", flexWrap: "wrap", fontSize: "0.8rem" }}>
        <span className="muted">
          Agent <span className="mono">{shortAddr(submission.agentWallet)}</span>
        </span>
        {submission.wish ? (
          <span className="muted">
            Wish <span className="mono">{shortAddr(submission.wish)}</span>
          </span>
        ) : null}
        {submission.tally.rejections > 0 ? (
          <span className="muted" data-testid="card-objections">
            {submission.tally.rejections} objection{submission.tally.rejections === 1 ? "" : "s"}
          </span>
        ) : null}
        <Countdown submission={submission} />
      </div>
    </article>
  );
}
