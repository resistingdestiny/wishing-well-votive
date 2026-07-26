/**
 * The two things every agent route does identically, in one place.
 *
 * Not a route: only `route.ts` is, so this file is invisible to the router and
 * sits beside the four handlers that import it. It exists because the alternative
 * is four copies of the same refusal table, and a refusal table that drifts is how
 * one endpoint ends up saying "expired" where another says "unauthorized" for the
 * same event — which teaches an attacker more than either sentence does alone.
 */
import type { Agent, AgentKey } from "@prisma/client";
import type { AgentPublic } from "@/core/agents/registration";
import type { ConsumeFailure } from "@/lib/challenge";
import { isLocked } from "@/lib/credentialLimit";

/**
 * A JSON response, without `next/server`.
 *
 * The App Router accepts a plain `Response` from a route handler, and slice A's
 * `unauthorized()` and `tooManyAttempts()` already return one — so this is the
 * house shape for anything on a credential path, not a departure from it.
 *
 * It also buys the only way these handlers can be tested. The suite runs under
 * Playwright's ESM loader, which cannot resolve `next/server`'s export map, so a
 * handler that imports `NextResponse` can only be exercised through a live HTTP
 * server. Importing the function and handing it a `Request` needs neither a server
 * nor a port, which matters here: the one on `:3100` belongs to another worktree.
 */
export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** The house error shape: `{ error }` with a status. */
export function fail(error: string, status: number): Response {
  return json({ error }, { status });
}

/**
 * What an agent looks like from outside.
 *
 * Nothing here can open anything. `keyId` names a row and does not unlock it,
 * `keyHash` and `salt` never leave the database, and there is no field a caller
 * could combine into a credential. The only reason this is a function rather than
 * a `select` is that forgetting a `select` is silent, and forgetting it once here
 * would ship the digest to a browser.
 */
export function agentPublic(agent: Agent, keys: AgentKey[]): AgentPublic {
  return {
    id: agent.id,
    wallet: agent.wallet,
    ownerWallet: agent.ownerWallet,
    displayName: agent.displayName,
    summary: agent.summary,
    status: agent.status,
    createdAt: agent.createdAt.toISOString(),
    keys: keys.map((k) => ({
      keyId: k.keyId,
      label: k.label,
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
      locked: isLocked(k.lockedUntil),
    })),
  };
}

/**
 * Why a signed challenge was not accepted.
 *
 * Unlike the agent secret, these are said plainly. The distinctions are not worth
 * hiding and hiding them costs a great deal: whoever is reading this message was
 * issued the nonce moments ago, so "it expired" tells them nothing they could not
 * work out from a clock, while a uniform refusal would leave someone whose wallet
 * took too long to open with no idea why the button did nothing. The one that is
 * genuinely about credentials — a signature that did not come from the wallet —
 * is the one that answers 401.
 */
export function challengeRefusal(reason: ConsumeFailure): Response {
  switch (reason) {
    case "unknown-nonce":
      return fail("that challenge is not one we issued — ask for a new one", 400);
    case "already-used":
      return fail("that challenge has already been presented — ask for a new one", 400);
    case "expired":
      return fail("that challenge expired before it was signed — ask for a new one", 400);
    case "wrong-purpose":
      return fail("that challenge authorises something else", 400);
    case "bad-signature":
      return fail("that signature did not come from the wallet the challenge names", 401);
  }
}

/** The first zod complaint, rather than the whole issue tree. */
export function invalid(message: string | undefined): Response {
  return fail(message ?? "invalid request", 400);
}

/**
 * A signature proved control of `signer`; this says whether that is the wallet
 * allowed to administer `agent`.
 *
 * `ownerWallet` and not `wallet`: the schema separates them precisely so the
 * address doing the work can stop being the address authorised to rotate its key,
 * and checking `wallet` here would quietly undo that. They are equal for every
 * agent registered without an explicit owner, so the common case is unchanged.
 */
export function ownsAgent(agent: Agent, signer: string): boolean {
  return agent.ownerWallet === signer;
}
