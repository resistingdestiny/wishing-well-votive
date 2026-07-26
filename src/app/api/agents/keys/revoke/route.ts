/**
 * Destroy a key, by either half of the pair that can prove a right to.
 *
 * **The owner's signature** revokes a key by id — the path for "that laptop is
 * gone" or "the contractor's contract ended", where the token itself is no longer
 * to hand.
 *
 * **The token itself** revokes without a wallet, a browser or a signature. This is
 * the fail-safe, and it is deliberately one-directional: whoever holds a leaked
 * secret can always burn it, and can never mint a replacement with it. So a thief
 * can destroy what they stole — which is a nuisance the owner recovers from with
 * one signature — and can never lock the owner out of their own agent. Between
 * "the person who lost control of a credential cannot revoke it quickly" and
 * "someone who stole a credential can also throw it away", the second is by far
 * the cheaper failure.
 *
 * Neither path is gated on `WELL_AGENT_KEY_PEPPER`. A deployment that cannot mint
 * keys must still be able to destroy them; a revocation route that answers 503
 * during a misconfiguration is offline exactly when it is needed.
 */
import { RevokeKeyBody } from "@/core/agents/registration";
import { consumeChallenge } from "@/lib/challenge";
import { revokeAgentKey, revokeAgentKeyByToken } from "@/lib/agentAuth";
import { burstCheck, tooManyAttempts } from "@/lib/credentialLimit";
import { clientIp } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { challengeRefusal, invalid, json, ownsAgent } from "../../_shared";

export const dynamic = "force-dynamic";

const REVOKES_PER_MINUTE = 20;

/**
 * One answer for "no such key", "not your key" and "already revoked".
 *
 * All three are the same fact from where the caller stands — there is nothing
 * live here that is theirs — and separating them would let a wallet enumerate
 * which key ids exist. A key id is enough to drive an honest agent's credential
 * into the escalating lockout and hold it there, so which ids are real is worth
 * keeping quiet even though the id itself opens nothing.
 */
function nothingToRevoke(): Response {
  return json({
    ok: true,
    revoked: false,
    detail: "nothing live under that key id for this wallet",
  });
}

export async function POST(req: Request) {
  const budget = burstCheck("revoke-key", clientIp(req.headers), REVOKES_PER_MINUTE);
  if (!budget.ok) return tooManyAttempts(budget.retryAfter);

  const parsed = RevokeKeyBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message);

  const { keyId, nonce, signature, token } = parsed.data;

  // The token path first: it needs no wallet, and it is the one a leak is
  // reported through. `revokeAgentKeyByToken` runs its own constant-time
  // comparison against a decoy for an unknown id and its own per-key budget, so
  // a wrong token costs the same as a right one and tells the caller nothing.
  if (token) {
    const revoked = await revokeAgentKeyByToken(token);
    return json(
      {
        ok: true,
        revoked,
        detail: revoked
          ? "that key is revoked and will not authenticate again"
          : "nothing live matched that key",
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  // `RevokeKeyBody` refuses a body with neither half, so reaching here means all
  // three signature fields are present; the guard is for the type, not the case.
  if (!keyId || !nonce || !signature) {
    return invalid("provide either a signed challenge for a keyId, or the key itself");
  }

  const consumed = await consumeChallenge({ nonce, signature, purpose: "revoke-key" });
  if (!consumed.ok) return challengeRefusal(consumed.reason);

  // The wallet signed a message naming this key id. A signature collected for one
  // key must not spend on another.
  if (consumed.subject !== keyId) {
    return json(
      { error: "that challenge authorises a different key" },
      { status: 400 },
    );
  }

  try {
    const row = await prisma.agentKey.findUnique({
      where: { keyId },
      include: { agent: true },
    });
    if (!row) return nothingToRevoke();
    if (!ownsAgent(row.agent, consumed.wallet)) return nothingToRevoke();

    const revoked = await revokeAgentKey(keyId);
    return json({
      ok: true,
      revoked,
      detail: revoked
        ? "that key is revoked and will not authenticate again"
        : "that key was already revoked",
    });
  } catch (e) {
    console.error("agents/keys/revoke POST:", (e as Error).message);
    return json({ error: "internal error" }, { status: 500 });
  }
}
