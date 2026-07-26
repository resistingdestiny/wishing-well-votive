/**
 * What the four submission routes do the same way, in one place.
 *
 * The same reasoning as `api/agents/_shared`: a shared refusal table cannot drift
 * between endpoints, and the App Router takes a plain `Response`, which is also the
 * only shape the Playwright-loader tests can exercise without a live server. These
 * re-export the agent helpers rather than reinvent them, and add the two lookups
 * every submission route needs — the row, and the human behind a signer.
 */
import { prisma } from "@/lib/db";
import { humanBacking } from "@/lib/chainReads";
import type { Submission, SubmissionVote } from "@prisma/client";

export { json, fail, invalid, challengeRefusal } from "@/app/api/agents/_shared";

export type SubmissionWithVotes = Submission & { votes: SubmissionVote[] };

/** The row and its votes, or null. Votes are ordered oldest-first for a stable tally. */
export async function loadSubmission(id: string): Promise<SubmissionWithVotes | null> {
  return prisma.submission.findUnique({
    where: { id },
    include: { votes: { orderBy: { createdAt: "asc" } } },
  });
}

/**
 * The human a signer speaks for, resolved on chain — never taken from a body.
 *
 * A vote and a report both count under a `humanId`, and a wallet is free while a
 * verified human is not, so the identity that matters is the one the chain binds to
 * the signing wallet. This returns the whole backing so the caller can snapshot the
 * assurance beside the humanId, and it keeps `Read`'s honest failure rather than
 * turning an RPC outage into "no human".
 */
export { humanBacking };
