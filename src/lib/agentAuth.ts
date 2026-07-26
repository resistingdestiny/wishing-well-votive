/**
 * Server-side verification of the agent secret.
 *
 * This is the function that stands between an anonymous POST and a wish solution
 * or a resource request. Every agent-authenticated route calls it as its first
 * statement, and nothing downstream re-checks — so the rules it enforces are the
 * only ones there are.
 *
 * **One refusal, whatever went wrong.** Unknown key id, wrong secret, revoked
 * key, locked key, disabled agent: all of them return the same `401
 * {"error":"unauthorized"}`. Each distinction is a fact an attacker would like,
 * and answering them separately turns this endpoint into a directory of which key
 * ids exist and which are still live.
 *
 * **An unknown key id costs the same as a known one.** A key id that names no row
 * is checked against a decoy digest anyway. Skipping the HMAC would make a miss
 * measurably faster than a hit, which is the same oracle by a different route.
 *
 * **The secret never leaves the header.** It is not accepted in a query string or
 * a body — a URL ends up in access logs, browser history and referrer headers —
 * and it is never logged, never returned, and never stored: only the digest is.
 */
import { prisma } from "@/lib/db";
import {
  agentKeyMatches,
  decoyMaterial,
  generateAgentKey,
  HASH_VERSION,
  hashAgentKey,
  parseAgentKey,
} from "@/core/agents/agentKey";
import {
  ATTEMPT_LIMIT,
  burstCheck,
  escalateFailure,
  FAILURE_LIMIT,
  isLocked,
  tooManyAttempts,
  unauthorized,
} from "@/lib/credentialLimit";
import { clientIp } from "@/lib/rateLimit";

export interface AuthedAgent {
  agentId: string;
  keyId: string;
  wallet: string;
  displayName: string;
  status: string;
}

export type AuthResult =
  | { ok: true; agent: AuthedAgent }
  | { ok: false; response: Response };

const DEV_PEPPER = "dev-only-agent-key-pepper-not-for-production";

/**
 * Whether keys can be issued at all.
 *
 * A missing pepper in development falls back to a fixed string so the demo runs;
 * in production it is refused outright, because a pepper everybody can read from
 * the source is not a pepper and would make a leaked database dump directly
 * usable. Issuing routes answer 503 rather than quietly minting weak keys.
 */
export function agentKeysConfigured(): boolean {
  if (process.env.WELL_AGENT_KEY_PEPPER) return true;
  return process.env.NODE_ENV !== "production";
}

function pepper(): string {
  const configured = process.env.WELL_AGENT_KEY_PEPPER;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("WELL_AGENT_KEY_PEPPER is required in production");
  }
  return DEV_PEPPER;
}

/**
 * Minted once per process, from random bytes, so it is neither a recognisable
 * constant nor recomputed per request.
 */
let decoy: { hash: string; salt: string } | null = null;
function decoyFor(p: string): { hash: string; salt: string } {
  if (!decoy) decoy = decoyMaterial(p);
  return decoy;
}

/**
 * The one refusal, and the budget it spends.
 *
 * Every rejected presentation routes through here, whatever was wrong with it,
 * and every one of them takes a unit from the same caller-keyed bucket. That
 * uniformity is the point: a 429 that arrived only for *some* causes would let an
 * attacker separate "no such key id" from "wrong secret" by watching which
 * requests eventually rate-limit, which is the oracle the identical 401 exists to
 * deny. Successful authentication spends nothing, so an exhausted bucket cannot
 * lock out an agent holding a correct key.
 */
function refuse(caller: string): Response {
  const budget = burstCheck("failure", caller, FAILURE_LIMIT);
  return budget.ok ? unauthorized() : tooManyAttempts(budget.retryAfter);
}

function bearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m) return m[1]!;
  }
  return req.headers.get("x-votive-agent-key");
}

export async function authenticateAgent(req: Request): Promise<AuthResult> {
  let p: string;
  try {
    p = pepper();
  } catch {
    // Misconfigured server. Say so plainly rather than refusing every agent with
    // a 401 that reads, to the agent's operator, as "your key is wrong".
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: "agent keys are not configured on this deployment" }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
    };
  }

  const caller = clientIp(req.headers);
  const presented = bearer(req);
  const parsed = presented ? parseAgentKey(presented) : null;

  // A malformed token costs only a regex, so no database is touched — but it is
  // still a refused presentation and is rationed exactly like every other one.
  if (!parsed) return { ok: false, response: refuse(caller) };

  // Consumed by every presentation of this key id, right or wrong. It exists to
  // keep a flood aimed at one credential off the database; it is not the guard.
  const attempt = burstCheck("verify", parsed.keyId, ATTEMPT_LIMIT);
  if (!attempt.ok) return { ok: false, response: tooManyAttempts(attempt.retryAfter) };

  const row = await prisma.agentKey.findUnique({
    where: { keyId: parsed.keyId },
    include: { agent: true },
  });

  if (!row) {
    const d = decoyFor(p);
    // Result discarded on purpose: this exists to spend the same time a real
    // comparison would, so that "no such key" and "wrong secret" are the same
    // observation from outside.
    agentKeyMatches(d.hash, parsed.secret, d.salt, p);
    return { ok: false, response: refuse(caller) };
  }

  const now = new Date();

  // The secret is still checked for a revoked, locked or disabled key, before
  // any of those are allowed to decide the answer. Returning early on them would
  // make those states detectable by timing without knowing the secret at all.
  const secretOk = agentKeyMatches(row.keyHash, parsed.secret, row.salt, p);

  if (isLocked(row.lockedUntil, now)) return { ok: false, response: refuse(caller) };
  if (row.revokedAt) return { ok: false, response: refuse(caller) };
  if (row.agent.status !== "active") return { ok: false, response: refuse(caller) };

  if (!secretOk) {
    // The durable counter is written before the refusal is chosen, and whether
    // the caller's budget is exhausted has no bearing on whether it is written.
    // Otherwise an attacker could sidestep the lockout entirely by pacing
    // themselves just under the burst limit.
    const next = escalateFailure(
      {
        failedAttempts: row.failedAttempts,
        lockouts: row.lockouts,
        lockedUntil: row.lockedUntil,
      },
      now,
    );
    await prisma.agentKey
      .update({
        where: { id: row.id },
        data: {
          failedAttempts: next.failedAttempts,
          lockouts: next.lockouts,
          lockedUntil: next.lockedUntil,
          lastFailedAt: now,
        },
      })
      .catch(() => {
        // A counter we could not write is a weaker guard, not a reason to admit
        // the request. The refusal below stands either way.
      });
    return { ok: false, response: refuse(caller) };
  }

  await prisma.agentKey
    .update({
      where: { id: row.id },
      data: { lastUsedAt: now, failedAttempts: 0 },
    })
    .catch(() => {
      // Bookkeeping. Never a reason to refuse a request that authenticated.
    });

  return {
    ok: true,
    agent: {
      agentId: row.agentId,
      keyId: row.keyId,
      wallet: row.agent.wallet,
      displayName: row.agent.displayName,
      status: row.agent.status,
    },
  };
}

/**
 * Mint and store a key.
 *
 * Returns the token exactly once. Nothing in this function logs it, and nothing
 * that persists can reproduce it — after this returns, the only copy in the world
 * is the caller's.
 */
export async function issueAgentKey(
  agentId: string,
  label: string,
): Promise<{ keyId: string; token: string }> {
  const p = pepper();
  const issued = generateAgentKey();
  await prisma.agentKey.create({
    data: {
      agentId,
      keyId: issued.keyId,
      keyHash: hashAgentKey(issued.secret, issued.salt, p),
      salt: issued.salt,
      hashVersion: HASH_VERSION,
      label: label.slice(0, 80),
    },
  });
  return { keyId: issued.keyId, token: issued.token };
}

/** Idempotent: revoking an already-revoked key answers `false`, not an error. */
export async function revokeAgentKey(keyId: string): Promise<boolean> {
  const res = await prisma.agentKey.updateMany({
    where: { keyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count > 0;
}

/**
 * Revoke a key by presenting the key itself.
 *
 * The fail-safe path: whoever is holding a leaked secret — including its rightful
 * owner, from a machine with no wallet on it — can always burn it. It deliberately
 * cannot do the opposite. A thief can destroy the credential they stole but can
 * never mint a replacement, so this can never be used to lock an owner out of
 * their own agent.
 */
export async function revokeAgentKeyByToken(token: string): Promise<boolean> {
  const parsed = parseAgentKey(token);
  if (!parsed) return false;
  let p: string;
  try {
    p = pepper();
  } catch {
    return false;
  }
  // Keyed on the key id rather than the caller: this path is reached by whoever
  // holds the secret, from wherever they hold it, and the thing worth bounding is
  // how fast one credential can be probed through it.
  const burst = burstCheck("revoke", parsed.keyId, FAILURE_LIMIT);
  if (!burst.ok) return false;

  const row = await prisma.agentKey.findUnique({ where: { keyId: parsed.keyId } });
  if (!row) {
    const d = decoyFor(p);
    agentKeyMatches(d.hash, parsed.secret, d.salt, p);
    return false;
  }
  if (!agentKeyMatches(row.keyHash, parsed.secret, row.salt, p)) return false;
  return revokeAgentKey(parsed.keyId);
}
