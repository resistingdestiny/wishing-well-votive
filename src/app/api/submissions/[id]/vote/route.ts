/**
 * Cast a vote on a submission — a wallet signature, deliberately not an agent key.
 *
 * **A vote is authorised by a human's wallet, never by an agent secret.** The key
 * proves which agent is speaking, and a tally keyed on agents would let one
 * operator's fleet outvote everyone — so voting uses the same signed-challenge path
 * every other human act does, and the count is keyed on the `humanId` the chain
 * binds to the signer. `@@unique([submissionId, humanId])` is the whole Sybil
 * defence: one verified human, one vote, however many wallets they hold.
 *
 * **The weight is snapshotted, because a vote is a past act.** It is cast with the
 * standing the chain gave that human at a block, and that block is recorded beside
 * it — re-reading standing at settlement would let someone barred on day three
 * silently rewrite a tally from day one. This is the one place the codebase writes
 * state instead of reading it, and the schema calls it the deliberate exception.
 *
 * **Only an open or contested window takes a vote.** Once the clock has run out the
 * decision is made, and a late vote cannot reopen it; a settled row takes none at
 * all. A barred human may sign — the ledger still knows them — but their weight is
 * zero, so the objection is recorded and counts for nothing, which is the bar doing
 * exactly what it is for.
 */
import { Prisma } from "@prisma/client";
import { VoteBody } from "@/core/submissions/schema";
import { toPublicSubmission } from "@/core/submissions/view";
import { deriveStatus, acceptsVotes } from "@/core/submissions/status";
import { voteWeightBps } from "@/core/submissions/weight";
import { consumeChallenge } from "@/lib/challenge";
import { humanBacking, standingFor, currentBlock } from "@/lib/chainReads";
import { isHumanBacked } from "@/core/world/humanId";
import { burstCheck, tooManyAttempts } from "@/lib/credentialLimit";
import { clientIp } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { json, fail, invalid, challengeRefusal, loadSubmission } from "../../_shared";

export const dynamic = "force-dynamic";

const VOTES_PER_MINUTE_PER_CALLER = 30;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const budget = burstCheck("vote", clientIp(req.headers), VOTES_PER_MINUTE_PER_CALLER);
  if (!budget.ok) return tooManyAttempts(budget.retryAfter);

  const parsed = VoteBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
  const { nonce, signature, choice, reason, category } = parsed.data;

  const row = await loadSubmission(params.id).catch(() => null);
  if (!row) return fail("no such submission", 404);

  // The window is checked before the signature is spent, so a vote arriving after
  // the clock has run out is turned away without burning the nonce.
  const status = deriveStatus(
    { decidesAt: row.decidesAt, settledAt: row.settledAt, ballots: [] },
    new Date(),
  ).status;
  if (!acceptsVotes(status)) {
    return fail(`this submission is ${status}; its window has closed`, 409);
  }

  const consumed = await consumeChallenge({ nonce, signature, purpose: "vote" });
  if (!consumed.ok) return challengeRefusal(consumed.reason);

  // The challenge names the submission it is for. A signature for one submission
  // must not be replayable onto another, so the subject has to be this row's id.
  if (consumed.subject !== row.id) {
    return fail("that challenge authorises a vote on a different submission", 400);
  }

  const voter = consumed.wallet;

  // Who this wallet votes as, resolved on chain. An unbacked wallet cannot vote —
  // the whole point of the Sybil floor is that a vote costs a verified human, and
  // an anonymous wallet is free. An RPC outage is reported as such, not as "no
  // human", so nobody is told they are not a person because an endpoint was down.
  const backing = await humanBacking(voter);
  if (!backing.ok) {
    return fail(`could not read the human behind this wallet: ${backing.degraded}`, 502);
  }
  if (!isHumanBacked(backing.value.humanId)) {
    return fail("only a human-backed wallet can vote; verify with World first", 403);
  }
  const humanId = backing.value.humanId;

  // Standing and the block it was read at, snapshotted together. A barred human's
  // weight is zero; a fresh human sits at parity. `readAtBlock` is what makes the
  // snapshot checkable by anyone later.
  const [standing, block] = await Promise.all([standingFor(humanId), currentBlock()]);
  if (!standing.ok) {
    return fail(`could not read this human's standing: ${standing.degraded}`, 502);
  }
  if (!block.ok) {
    return fail(`could not read the block to pin the vote to: ${block.degraded}`, 502);
  }
  const weightBps = voteWeightBps(standing.value.multiplierBps, standing.value.barred);

  try {
    await prisma.submissionVote.create({
      data: {
        submissionId: row.id,
        humanId,
        voter,
        choice,
        weightBps: weightBps.toString(),
        assurance: backing.value.assurance,
        readAtBlock: block.value.toString(),
        reason: reason ?? null,
        category: category ?? null,
        signature: signature.slice(0, 400),
      },
    });
  } catch (e) {
    // `@@unique([submissionId, humanId])`: this human has already voted here. A
    // vote is final — allowing an update would let someone approve, watch the
    // tally, and flip to reject at the last second — so the second attempt is
    // refused rather than overwriting the first.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return fail("this human has already voted on this submission", 409);
    }
    console.error("submissions vote POST:", (e as Error).message);
    return fail("internal error", 500);
  }

  // The first objection is the switch from optimistic to contested, and it is
  // stamped once. Recorded, not derived, because it is the moment silence stopped
  // being enough — a fact about when, not a recomputation of the tally.
  if (choice === "reject" && !row.contestedAt) {
    await prisma.submission
      .update({ where: { id: row.id }, data: { contestedAt: new Date() } })
      .catch(() => {
        // Cosmetic: `contestedAt` is a convenience for display. The tally itself
        // decides contested-ness and is recomputed from the votes every read.
      });
  }

  const fresh = await loadSubmission(row.id);
  return json(
    { ok: true, submission: fresh ? toPublicSubmission(fresh) : null },
    { status: 201 },
  );
}
