/**
 * The public shape of a submission, and the one place its status is computed.
 *
 * Every route and page that shows a submission goes through `toPublicSubmission`,
 * so the derived status, the tally, and the time remaining are calculated once,
 * the same way, from the stored row and its votes. Nothing here is a secret: a
 * submission is a public claim by design, votes are public objections, and the
 * only identifier a vote carries is the one-way `humanId` the chain already
 * exposes. There is no agent key, no wallet secret, and no vote signature in the
 * output — the signature proved the vote at write time and has no reason to be
 * read back.
 */
import type { Submission, SubmissionVote } from "@prisma/client";
import { deriveStatus, type SubmissionStatus } from "./status";
import type { Ballot } from "./weight";

export interface PublicVote {
  humanId: string;
  voter: string;
  choice: "approve" | "reject";
  weightBps: string;
  assurance: number;
  reason: string | null;
  createdAt: string;
}

export interface PublicSubmission {
  id: string;
  kind: "solution" | "resource-request";
  agentId: string;
  agentWallet: string;
  wish: string | null;
  railAddress: string | null;
  bountyId: number | null;
  amountWei: string | null;
  resourceId: string | null;
  resourceKind: string | null;
  title: string;
  body: string;
  resultHash: string | null;
  submittedAt: string;
  decidesAt: string;
  settledAt: string | null;
  attestTxHash: string | null;
  releaseTxHash: string | null;
  reportTxHash: string | null;

  status: SubmissionStatus;
  live: boolean;
  msRemaining: number;
  tally: {
    approveBps: string;
    rejectBps: string;
    approvals: number;
    rejections: number;
    contested: boolean;
  };
  votes: PublicVote[];
}

function ballotsOf(votes: SubmissionVote[]): Ballot[] {
  return votes.map((v) => ({
    choice: v.choice === "reject" ? "reject" : "approve",
    // Stored as a decimal string precisely so a weight above 2^53 survives; parse
    // it back to a bigint for the tally rather than through a lossy Number.
    weightBps: BigInt(v.weightBps),
  }));
}

export function toPublicSubmission(
  row: Submission & { votes: SubmissionVote[] },
  now: Date = new Date(),
): PublicSubmission {
  const derived = deriveStatus(
    { decidesAt: row.decidesAt, settledAt: row.settledAt, ballots: ballotsOf(row.votes) },
    now,
  );

  return {
    id: row.id,
    kind: row.kind === "resource-request" ? "resource-request" : "solution",
    agentId: row.agentId,
    agentWallet: row.agentWallet,
    wish: row.wish,
    railAddress: row.railAddress,
    bountyId: row.bountyId,
    amountWei: row.amountWei,
    resourceId: row.resourceId,
    resourceKind: row.resourceKind,
    title: row.title,
    body: row.body,
    resultHash: row.resultHash,
    submittedAt: row.submittedAt.toISOString(),
    decidesAt: row.decidesAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
    attestTxHash: row.attestTxHash,
    releaseTxHash: row.releaseTxHash,
    reportTxHash: row.reportTxHash,
    status: derived.status,
    live: derived.live,
    msRemaining: derived.msRemaining,
    tally: {
      approveBps: derived.tally.approveBps.toString(),
      rejectBps: derived.tally.rejectBps.toString(),
      approvals: derived.tally.approvals,
      rejections: derived.tally.rejections,
      contested: derived.tally.contested,
    },
    votes: row.votes.map((v) => ({
      humanId: v.humanId,
      voter: v.voter,
      choice: v.choice === "reject" ? "reject" : "approve",
      weightBps: v.weightBps,
      assurance: v.assurance,
      reason: v.reason,
      createdAt: v.createdAt.toISOString(),
    })),
  };
}
