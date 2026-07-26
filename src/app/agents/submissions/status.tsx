"use client";

/**
 * The one place a submission's status is turned into a badge and a countdown.
 *
 * The status itself is computed on the server by `deriveStatus` and arrives on the
 * `PublicSubmission` — this component never re-derives it, it only renders it, with
 * one honest exception: while a window is open it ticks the remaining time down
 * from `msRemaining` so a viewer sees the clock move. When that clock reaches zero
 * the badge does *not* silently flip to "approved"; it says the window has closed
 * and asks for a refresh, because whether silence approved or a late tally rejected
 * is the server's call from the votes, not something the browser may assume.
 */
import { useEffect, useState } from "react";
import type { PublicSubmission } from "@/core/submissions/view";

const WORD: Record<PublicSubmission["status"], string> = {
  open: "Open — silence is approving",
  contested: "Contested — an objection stands",
  approved: "Approved",
  rejected: "Rejected",
  settled: "Settled — paid on chain",
};

const BADGE: Record<PublicSubmission["status"], string> = {
  open: "pass",
  contested: "warn",
  approved: "pass",
  rejected: "fail",
  settled: "pass",
};

function humanRemaining(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function StatusBadge({ submission }: { submission: PublicSubmission }) {
  return (
    <span className={`badge ${BADGE[submission.status]}`} data-testid="submission-status">
      {WORD[submission.status]}
    </span>
  );
}

/**
 * A live countdown while the window is open, and a plain "closed, refresh to see
 * the result" once it is not. It starts from the server's `msRemaining` so it is
 * seeded correctly even before the first tick.
 */
export function Countdown({ submission }: { submission: PublicSubmission }) {
  const [remaining, setRemaining] = useState(submission.msRemaining);

  useEffect(() => {
    if (!submission.live) return;
    const target = Date.now() + submission.msRemaining;
    const id = setInterval(() => {
      setRemaining(Math.max(0, target - Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [submission.live, submission.msRemaining]);

  if (submission.status === "settled") {
    return (
      <span className="muted" style={{ fontSize: "0.82rem" }}>
        Settled {new Date(submission.settledAt ?? submission.decidesAt).toLocaleString()}
      </span>
    );
  }

  if (!submission.live) {
    return (
      <span className="muted" style={{ fontSize: "0.82rem" }} data-testid="window-closed">
        Window closed {new Date(submission.decidesAt).toLocaleString()} — refresh to see the result the votes settled on.
      </span>
    );
  }

  return (
    <span className="mono" style={{ fontSize: "0.82rem" }} data-testid="countdown">
      {humanRemaining(remaining)} left to object
    </span>
  );
}
