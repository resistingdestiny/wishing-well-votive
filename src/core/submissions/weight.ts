/**
 * What one human's vote is worth, and how a tally adds up.
 *
 * Pure on purpose: the weight of a vote is decided by the chain (a human's
 * standing multiplier at a block), but *how* those weights combine into an
 * approve/reject decision is policy, and policy belongs somewhere it can be tested
 * without a node and read without one either.
 *
 * **Weight is the standing multiplier, floored at parity for a fresh human.** A
 * verified person who has never worked sits at the ledger's parity (10000 bps) and
 * their objection counts for one whole vote — not zero. Standing earns you *more*
 * than one vote; it never takes away the first one, because the point of the
 * Sybil floor is that a real human always gets a real say. A barred human is the
 * one exception: their weight is zero, because a bar is the community having
 * already decided their say is forfeit.
 *
 * **The tie goes to the objection.** Approval is the optimistic default of
 * *silence*, not of a contested vote — so once anyone has objected, the claim is
 * only approved if approvals strictly outweigh rejections. An exact tie is a live
 * dispute, and a live dispute is not an approval.
 */

/** The ledger's neutral point, mirrored from `StandingLedger` / `VotiveOpcodes`. */
export const PARITY_BPS = 10_000n;

/**
 * The weight of a single vote, in basis points, from the voter's on-chain standing.
 *
 * @param multiplierBps the human's `multiplierBpsOf` at the snapshot block
 * @param barred        whether the human was barred at the snapshot block
 */
export function voteWeightBps(multiplierBps: bigint, barred: boolean): bigint {
  if (barred) return 0n;
  // A verified human below parity (penalised but not barred) still gets a floor of
  // one whole vote: conduct short of a bar reduces the bonus, not the franchise.
  return multiplierBps < PARITY_BPS ? PARITY_BPS : multiplierBps;
}

export interface Ballot {
  choice: "approve" | "reject";
  weightBps: bigint;
}

export interface Tally {
  approveBps: bigint;
  rejectBps: bigint;
  approvals: number;
  rejections: number;
  /** True once anyone has objected — the switch from optimistic to contested. */
  contested: boolean;
  /**
   * Whether the weighted vote, on its own, favours approval. This is *not* the
   * final verdict: silence with no votes at all is also an approval, and that is
   * decided by the clock in `status.ts`, not here.
   */
  approvesOnVotes: boolean;
}

export function tally(ballots: Ballot[]): Tally {
  let approveBps = 0n;
  let rejectBps = 0n;
  let approvals = 0;
  let rejections = 0;
  for (const b of ballots) {
    if (b.choice === "approve") {
      approveBps += b.weightBps;
      approvals += 1;
    } else {
      rejectBps += b.weightBps;
      rejections += 1;
    }
  }
  return {
    approveBps,
    rejectBps,
    approvals,
    rejections,
    contested: rejections > 0,
    // Strictly greater: an exact tie is an unresolved objection, not an approval.
    approvesOnVotes: approveBps > rejectBps,
  };
}
