/**
 * The milestone hash, derived rather than typed.
 *
 * `AgentBountyRail.release(id, milestoneHash, amount)` pays once per
 * `(bounty, milestoneHash)` pair, and `settle` attests exactly the hash stored on
 * the submission. So the hash is the identity of the thing being claimed, and it
 * has two jobs that pull in opposite directions:
 *
 *   - Two agents claiming **the same milestone** must produce the **same** hash.
 *     That is what makes `@@unique([railAddress, bountyId, resultHash])` refuse a
 *     double-claim before it costs gas, and what makes the chain's own
 *     `milestoneReleased` guard bite.
 *   - Two agents claiming **different milestones** of one bounty must produce
 *     **different** hashes, or the second is refused as a duplicate of the first.
 *
 * Deriving it from the claim prose satisfies neither: two agents describing the
 * same delivered milestone in their own words would collide with nobody and pass
 * both guards. So the preimage names the rail, the bounty and a short milestone
 * label, and nothing else — no prose, no timestamp, no author. Same milestone,
 * same hash, whoever is claiming it and whenever.
 *
 * The preimage is returned alongside the hash and published, so anybody can
 * recompute the commitment instead of taking it on trust. That is the same
 * bargain `api/agents/verify` makes with `evidencePreimage`: a hash on chain that
 * nobody can reproduce is decoration.
 */

/**
 * What a milestone label may be.
 *
 * Deliberately narrow. The label is part of a hash preimage, which means it is
 * part of an identity that has to be reproducible by a stranger reading the
 * submission — so `final`, `Final` and `final ` must not be three milestones. It
 * is lowercased and trimmed before hashing for exactly that reason, and anything
 * outside this shape is refused rather than normalised into a guess.
 */
export const MILESTONE_LABEL = /^[a-z0-9][a-z0-9 ._-]{0,48}$/;

/** What a bounty's single, whole-job milestone is called when nobody says. */
export const DEFAULT_MILESTONE = "final";

export interface MilestoneRef {
  railAddress: string;
  bountyId: number;
  /** Short label naming which slice of the bounty this is. */
  milestone: string;
}

/**
 * Normalise a label, or explain why it cannot be used.
 *
 * Returns the reason as a string rather than throwing, because every caller is a
 * request boundary that has to turn this into a 400 with something a builder can
 * act on.
 */
export function normaliseMilestone(raw: string | undefined): { ok: true; label: string } | { ok: false; why: string } {
  const label = (raw ?? DEFAULT_MILESTONE).trim().toLowerCase();
  if (label === "") return { ok: false, why: "a milestone label cannot be empty" };
  if (!MILESTONE_LABEL.test(label)) {
    return {
      ok: false,
      why:
        "a milestone label is 1-49 characters of lowercase letters, digits, spaces, dots, " +
        `underscores or hyphens, starting with a letter or digit — got ${JSON.stringify(raw)}`,
    };
  }
  return { ok: true, label };
}

/**
 * The exact bytes the hash commits to.
 *
 * Versioned in its first line so a later change to what a milestone is keyed on
 * cannot silently collide with hashes already released on chain. The rail is
 * lowercased because a checksummed and an unchecksummed spelling of one address
 * are the same rail and must not be two milestones.
 */
export function milestonePreimage(ref: MilestoneRef): string {
  return [
    "votive:milestone:v1",
    `rail: ${ref.railAddress.trim().toLowerCase()}`,
    `bounty: ${ref.bountyId}`,
    `milestone: ${ref.milestone.trim().toLowerCase()}`,
  ].join("\n");
}
