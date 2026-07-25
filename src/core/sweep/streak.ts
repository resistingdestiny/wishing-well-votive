import type { SignedRunLogEntry } from "../runlog/runlog.js";
import type { EvalResult } from "../evals/harness.js";

/**
 * The `detail` payload of a capability-check run-log entry. Carries the full
 * pass@k evidence (every trial's transcript) and the streak state at the moment
 * of the check, so the log alone reconstructs why the on-chain verdict flipped.
 */
export interface CapabilityCheckDetail {
  summary: string;
  passK: {
    k: number;
    passes: number;
    passRate: number;
    wilsonLower: number;
    threshold: number;
    z: number;
    /** Did pass@k clear the Wilson gate on *this* sweep? */
    cleared: boolean;
  };
  streak: {
    /** Consecutive sweeps this model has cleared, up to and including this one. */
    count: number;
    required: number;
    /** count >= required — i.e. what we attest on chain. */
    satisfied: boolean;
  };
  trials: { transcript: EvalResult["transcript"]; pass: boolean; score: number }[];
}

function isCapabilityCheckDetail(d: unknown): d is CapabilityCheckDetail {
  return (
    typeof d === "object" &&
    d !== null &&
    "passK" in d &&
    typeof (d as { passK?: unknown }).passK === "object"
  );
}

/**
 * Trailing run of consecutive `cleared` sweeps for one (capability, model),
 * read from the signed run log. History is authoritative: a single failed
 * sweep in the middle resets the count to zero. Entries are assumed appended in
 * sequence order (they always are); we still sort by seq to be safe.
 */
export function passingStreak(
  entries: SignedRunLogEntry[],
  capabilityId: `0x${string}`,
  model: string,
): number {
  const history = entries
    .filter(
      (e) =>
        e.entry.kind === "capability-check" &&
        e.entry.capabilityId === capabilityId &&
        e.entry.model === model,
    )
    .sort((a, b) => a.entry.seq - b.entry.seq);

  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const detail = history[i]!.entry.detail;
    const cleared = isCapabilityCheckDetail(detail) && detail.passK.cleared === true;
    if (!cleared) break;
    streak++;
  }
  return streak;
}
