/**
 * Release the bounty on an approved solution.
 *
 * **Anyone may call this, because it decides nothing.** The community already
 * decided, by voting or by silence, when the window closed; settlement only moves
 * the money that decision authorised. There is no signature and no agent key here
 * on purpose — gating a permissionless payout behind a credential would let a
 * sulking loser withhold a reward the clock already granted. What it is *not* is
 * unconditional: it runs only when the derived status is `approved`, and every
 * parameter comes from the stored row, so it cannot be pointed at a different
 * bounty or a larger amount than the one that was approved.
 *
 * **The row is written from the chain, not from intent.** `settledAt` is stamped
 * only after `settleSolution` returns a mined, successful release — so a submission
 * reads `settled` because money moved, never because a transaction was sent. A
 * partial result (attested, release still pending) records the attestation hash and
 * stays unsettled, which is the honest state: the job is resumable by anyone and
 * the page must not claim it is done.
 */
import { deriveStatus, mayRelease } from "@/core/submissions/status";
import { toPublicSubmission } from "@/core/submissions/view";
import { settleSolution, settlementConfigured } from "@/lib/settle";
import { burstCheck, tooManyAttempts } from "@/lib/credentialLimit";
import { clientIp } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import type { TxChain } from "@/lib/txLog";
import { json, fail, loadSubmission } from "../../_shared";

export const dynamic = "force-dynamic";

const SETTLES_PER_MINUTE_PER_CALLER = 6;

function ballotsOf(votes: { choice: string; weightBps: string }[]) {
  return votes.map((v) => ({
    choice: v.choice === "reject" ? ("reject" as const) : ("approve" as const),
    weightBps: BigInt(v.weightBps),
  }));
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const budget = burstCheck("settle", clientIp(req.headers), SETTLES_PER_MINUTE_PER_CALLER);
  if (!budget.ok) return tooManyAttempts(budget.retryAfter);

  const row = await loadSubmission(params.id).catch(() => null);
  if (!row) return fail("no such submission", 404);

  if (row.kind !== "solution") {
    return fail("only a wish solution has a bounty to release", 400);
  }
  if (row.settledAt) {
    // Already settled. Not an error — the caller gets the finished row back — but
    // nothing is sent, so a retry cannot double-release.
    return json({ ok: true, alreadySettled: true, submission: toPublicSubmission(row) });
  }
  if (!row.railAddress || row.bountyId === null || !row.resultHash || !row.wish) {
    return fail("this solution is missing the rail, bounty, milestone or wish it needs to settle", 422);
  }

  const derived = deriveStatus(
    { decidesAt: row.decidesAt, settledAt: null, ballots: ballotsOf(row.votes) },
    new Date(),
  );
  if (!mayRelease(derived.status)) {
    return fail(
      `this solution is ${derived.status}; only an approved solution can be released`,
      409,
    );
  }

  if (!settlementConfigured()) {
    return fail(
      "this deployment has no attestor key, so an approved solution cannot be released automatically",
      503,
    );
  }

  const result = await settleSolution({
    railAddress: row.railAddress as `0x${string}`,
    bountyId: row.bountyId,
    milestoneHash: row.resultHash as `0x${string}`,
    chain: "base-sepolia" as TxChain,
    wish: row.wish,
    amountWei: row.amountWei,
  });

  if (!result.ok) {
    // A release that attested but did not land records the attestation so the job
    // is resumable, and stays unsettled. The status stays `approved`, truthfully.
    return fail(`settlement did not complete: ${result.detail}`, 502);
  }

  // Written only now, from a confirmed release. `settledAt` is the one status the
  // schema proves with a chain fact rather than the clock.
  const updated = await prisma.submission.update({
    where: { id: row.id },
    data: {
      attestTxHash: result.attestTxHash,
      releaseTxHash: result.releaseTxHash,
      settledAt: new Date(),
    },
    include: { votes: { orderBy: { createdAt: "asc" } } },
  });

  return json({
    ok: true,
    alreadyReleased: result.alreadyReleased,
    evidenceHash: result.evidenceHash,
    evidencePreimage: result.evidencePreimage,
    submission: toPublicSubmission(updated),
  });
}
