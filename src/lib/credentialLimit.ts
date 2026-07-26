/**
 * Brute-force resistance for credential checks.
 *
 * **Why this is not `enforceRateLimit`.** That helper returns `null` the moment
 * it sees `WELL_RATELIMIT_DISABLED === "1"` — and that variable *is set* in this
 * deployment's `.env.local`. A guard on a secret that an operator can switch off
 * with an environment variable, or that a mistaken copy of a config file can
 * switch off by accident, is not a guard. Nothing in this module reads that
 * variable. It is deliberately not configurable off.
 *
 * **Why the caller is not the only axis.** `clientIp()` falls back to the literal
 * string `"unknown"` when there is no proxy header, so behind a direct connection
 * every caller in the world shares one bucket and an attacker with two addresses
 * halves the cost. It is used below, but only to ration *refusals* — never to
 * ration successful requests, so a shared bucket cannot deny an agent holding a
 * correct key. What actually stops a search is the durable per-key lockout, which
 * does not care where the attempts came from.
 *
 * Three layers, and they answer different questions:
 *
 *   The **burst limit** below is in-memory, per process, and bounds how fast a
 *   single key id can be tried right now. It is cheap and it forgets, which is
 *   correct for absorbing a flood but useless against patience — a restart clears
 *   it, and a horizontal scale-out multiplies it.
 *
 *   The **lockout**, whose policy is computed by {@link escalateFailure} and
 *   whose counters live on the `AgentKey` row, is what actually stops a slow
 *   search. It survives a restart and it is shared by every instance, because it
 *   is in Postgres.
 */
import { rateLimit } from "@/lib/rateLimit";

/**
 * Two buckets on two different axes, because a request and a failure are not the
 * same thing and are not bounded by the same question.
 *
 * `ATTEMPT_LIMIT` is keyed on the **key id** and consumed by every presentation,
 * right or wrong. It keeps a flood aimed at one credential off the database. It
 * has to be generous: an agent submitting results and polling its own status is
 * not an attacker, and a limit tight enough to stop guessing would throttle the
 * product.
 *
 * `FAILURE_LIMIT` is keyed on the **caller** and consumed by every credential
 * presentation that is refused — unknown key id, wrong secret, revoked, locked,
 * disabled, malformed, all of them. Two properties come from that:
 *
 *   It bounds something real. A budget keyed on the key id cannot bound guessing,
 *   because the key id is chosen by the person guessing: a fresh id is a fresh
 *   bucket, so the limit is never reached and the flood is unbounded.
 *
 *   Every refusal costs the same. If only *some* causes spent the budget, an
 *   attacker could tell them apart by watching which requests eventually turn
 *   into a 429 — which would hand back exactly the "does this key id exist?"
 *   oracle that the single uniform 401 exists to deny.
 *
 * Only failures are rationed, so exhausting this cannot deny service to a caller
 * presenting a correct key — a genuine agent never touches it.
 */
export const ATTEMPT_LIMIT = 120;
export const FAILURE_LIMIT = 10;
export const BURST_WINDOW_MS = 60_000;

/** Consecutive wrong secrets on one key before it is locked. */
export const MAX_FAILED_ATTEMPTS = 5;
/** First lockout. Each subsequent one doubles. */
export const LOCKOUT_BASE_MS = 60_000;
/** Ceiling on the doubling: 2^6 × 1 min ≈ 64 minutes. */
export const LOCKOUT_MAX_DOUBLINGS = 6;

export interface BurstDecision {
  ok: boolean;
  /** Seconds the caller should wait. Zero when `ok`. */
  retryAfter: number;
}

/**
 * Take one unit from a bucket, and say whether there was one to take.
 *
 * `scope` separates unrelated uses of the same counter store — a submission
 * endpoint and a key-revocation endpoint should not deplete each other, and
 * neither should the attempt and guess budgets for one key.
 */
export function burstCheck(
  scope: string,
  subject: string,
  limit: number,
  windowMs: number = BURST_WINDOW_MS,
  now: number = Date.now(),
): BurstDecision {
  const res = rateLimit(`credential:${scope}:${subject}`, limit, windowMs, now);
  return { ok: res.ok, retryAfter: res.retryAfter };
}

export interface FailureState {
  failedAttempts: number;
  lockouts: number;
  lockedUntil: Date | null;
}

/**
 * What a wrong secret costs, given what this key has already cost.
 *
 * Pure, so the policy can be tested without a database and read without one
 * either. The escalation is exponential rather than fixed because a fixed
 * penalty is a throughput limit, not a deterrent: an attacker willing to wait
 * pays it once per attempt forever. Doubling turns a sustained search into
 * something that runs out of hours before it runs out of key space.
 *
 * `failedAttempts` resets when the lock is applied — the counter's job is to
 * measure the run since the last consequence, not since the beginning of time.
 * `lockouts` is what never resets, and it is what makes the next lock longer.
 */
export function escalateFailure(current: FailureState, now = new Date()): FailureState {
  const failed = current.failedAttempts + 1;
  if (failed < MAX_FAILED_ATTEMPTS) {
    return { failedAttempts: failed, lockouts: current.lockouts, lockedUntil: current.lockedUntil };
  }
  const doublings = Math.min(current.lockouts, LOCKOUT_MAX_DOUBLINGS);
  const duration = LOCKOUT_BASE_MS * 2 ** doublings;
  return {
    failedAttempts: 0,
    lockouts: current.lockouts + 1,
    lockedUntil: new Date(now.getTime() + duration),
  };
}

/** Whether a lock recorded on a row is still in force. */
export function isLocked(lockedUntil: Date | null | undefined, now = new Date()): boolean {
  return lockedUntil instanceof Date && lockedUntil.getTime() > now.getTime();
}

/**
 * The one refusal a credential path ever gives.
 *
 * Deliberately identical whatever went wrong — unknown key id, wrong secret,
 * revoked key, locked key, disabled agent. Each of those is a fact an attacker
 * would like to learn, and answering them separately is how an endpoint gets
 * turned into a directory of valid key ids.
 *
 * The one exception is the burst refusal, which says 429 and `retry-after`,
 * because that is a statement about our rate and not about their guess.
 */
export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

export function tooManyAttempts(retryAfter: number): Response {
  return new Response(
    JSON.stringify({ error: "too many attempts — slow down", retryAfter }),
    {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(retryAfter) },
    },
  );
}
