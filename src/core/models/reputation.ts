import type { RunLogEntry } from "../runlog/verify.js";

/**
 * Reputation-weighted allocation (off-chain by the operator's rule: compute
 * spend and track record are off-chain concerns). Deterministic, computed from
 * the signed run log only — same entries, same numbers, every time.
 *
 * Signals per model:
 *  - Wilson lower bound of the pass rate on capability checks, with near-misses
 *    (score ≥ 0.5 but failed) counted as HALF a pass — "it got quite close" is a
 *    real signal, not a miss;
 *  - current consecutive-pass streak (capped);
 *  - fulfilments (pass=true fulfilment attempts — real resolutions, not evals).
 * Cold start (no checks) is neutral 0.5, so a brand-new model gets the base
 * budget, neither boosted nor throttled. The multiplier is bounded [0.5, 2.0]:
 * a proven agent earns up to 2× the per-wish budget; a consistently failing one
 * decays to half. Default OFF everywhere (WELL_REPUTATION_ENABLED).
 */

export const REPUTATION_MIN_MULTIPLIER = 0.5;
export const REPUTATION_MAX_MULTIPLIER = 2.0;
const WILSON_Z = 1.96;
const STREAK_CAP = 5;
const FULFIL_CAP = 5;
const NEAR_MISS_SCORE = 0.5;

export interface ModelReputation {
  model: string;
  checks: number;
  passes: number;
  nearMisses: number;
  wilson: number;
  streak: number;
  fulfilments: number;
  /** 0..1 composite: 0.6·wilson + 0.2·streakScore + 0.2·fulfilScore. */
  score: number;
  budgetMultiplier: number;
}

/** Wilson score lower bound (same gate math as the sweep's pass@k rule). */
export function wilsonLowerBound(successes: number, trials: number, z: number = WILSON_Z): number {
  if (trials === 0) return 0.5; // cold start → neutral
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return (center - margin) / denom;
}

export function computeReputation(entries: RunLogEntry[]): Map<string, ModelReputation> {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const acc = new Map<
    string,
    { checks: number; effPasses: number; passes: number; nearMisses: number; streak: number; fulfilments: number }
  >();
  const slot = (m: string) => {
    let a = acc.get(m);
    if (!a) {
      a = { checks: 0, effPasses: 0, passes: 0, nearMisses: 0, streak: 0, fulfilments: 0 };
      acc.set(m, a);
    }
    return a;
  };

  for (const e of sorted) {
    if (e.kind === "capability-check") {
      const a = slot(e.model);
      a.checks += 1;
      if (e.pass === true) {
        a.passes += 1;
        a.effPasses += 1;
        a.streak += 1;
      } else {
        const near = (e.score ?? 0) >= NEAR_MISS_SCORE;
        if (near) {
          a.nearMisses += 1;
          a.effPasses += 0.5;
        }
        a.streak = 0;
      }
    } else if (e.kind === "fulfilment-attempt" && e.pass === true) {
      slot(e.model).fulfilments += 1;
    }
  }

  const out = new Map<string, ModelReputation>();
  for (const [model, a] of acc) {
    const wilson = wilsonLowerBound(a.effPasses, a.checks);
    const streakScore = Math.min(a.streak, STREAK_CAP) / STREAK_CAP;
    const fulfilScore = Math.min(a.fulfilments, FULFIL_CAP) / FULFIL_CAP;
    const score = 0.6 * wilson + 0.2 * streakScore + 0.2 * fulfilScore;
    const budgetMultiplier = Math.min(
      REPUTATION_MAX_MULTIPLIER,
      Math.max(REPUTATION_MIN_MULTIPLIER, REPUTATION_MIN_MULTIPLIER + score * 1.5),
    );
    out.set(model, {
      model,
      checks: a.checks,
      passes: a.passes,
      nearMisses: a.nearMisses,
      wilson,
      streak: a.streak,
      fulfilments: a.fulfilments,
      score,
      budgetMultiplier,
    });
  }
  return out;
}
