/**
 * A submission's status, derived — never stored.
 *
 * The schema says it and means it: there is no `status` column, because this repo
 * runs no scheduler, and a stored status is a status nothing would ever flip. A
 * window that closed at 3am does not fire a job; it is simply *past* the next time
 * anyone reads the row. So the status is a pure function of three things the row
 * does hold — the frozen `decidesAt`, the votes, and whether settlement has
 * already run — evaluated against the clock at read time.
 *
 * The states, and the one-way arrows between them:
 *
 *   open        — inside the window, nobody has objected. Silence is winning.
 *   contested   — inside the window, at least one objection stands. Silence is not
 *                 enough now; the weighted vote has to come down on approval.
 *   approved    — the window has closed and the vote (or the silence) favours it.
 *                 For a solution this is the state in which the bounty may be
 *                 released; the release itself is a separate, recorded step.
 *   rejected    — the window has closed and objections outweigh approvals. Nothing
 *                 is clawed back, because no function could — a funder recovers by
 *                 refunding after the bounty's own deadline.
 *   settled     — a solution whose release transaction has landed. Terminal, and
 *                 the only state proven by a chain fact rather than the clock.
 *
 * `approved` is deliberately not `settled`: approval is the community's answer and
 * happens by the clock; settlement is money moving and happens only when someone
 * calls `release` and it confirms. Collapsing them would paint a submission as
 * paid the instant its window closed, which is exactly the confident-but-false
 * state the rest of this codebase is written to avoid.
 */
import { tally, type Ballot, type Tally } from "./weight";

export type SubmissionStatus =
  | "open"
  | "contested"
  | "approved"
  | "rejected"
  | "settled";

export interface StatusInput {
  decidesAt: Date;
  /** Set once a solution's release has confirmed on chain. */
  settledAt: Date | null;
  ballots: Ballot[];
}

export interface DerivedStatus {
  status: SubmissionStatus;
  tally: Tally;
  /** True while the window is still open (approve/reject not yet final). */
  live: boolean;
  /** Milliseconds until `decidesAt`; zero once past. */
  msRemaining: number;
}

export function deriveStatus(input: StatusInput, now: Date = new Date()): DerivedStatus {
  const t = tally(input.ballots);
  const msRemaining = Math.max(0, input.decidesAt.getTime() - now.getTime());
  const windowClosed = msRemaining === 0;

  // A recorded settlement is a fact about the chain and outranks the clock: once
  // the money has moved the argument is over, however the votes later read.
  if (input.settledAt) {
    return { status: "settled", tally: t, live: false, msRemaining: 0 };
  }

  if (!windowClosed) {
    return {
      status: t.contested ? "contested" : "open",
      tally: t,
      live: true,
      msRemaining,
    };
  }

  // Window closed. Silence — no votes at all — approves, which is the whole of the
  // optimistic promise. A contested vote approves only if approvals strictly win.
  const approved = t.contested ? t.approvesOnVotes : true;
  return {
    status: approved ? "approved" : "rejected",
    tally: t,
    live: false,
    msRemaining: 0,
  };
}

/** Whether a solution in this state is eligible to have its bounty released. */
export function mayRelease(status: SubmissionStatus): boolean {
  return status === "approved";
}

/** Whether new votes still count. Closed windows and settled rows take no more. */
export function acceptsVotes(status: SubmissionStatus): boolean {
  return status === "open" || status === "contested";
}
