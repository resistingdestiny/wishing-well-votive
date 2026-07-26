/**
 * Mint a secret, hand it over once, and never be able to produce it again.
 *
 * After `issueAgentKey` returns, the only copy of the token in existence is in
 * this response body. What persists is `HMAC-SHA-256(pepper, salt ‖ secret)`, from
 * which the secret cannot be recovered — and which cannot even be *checked*
 * against a guess by someone holding the database but not the pepper. Nothing here
 * logs the token, and it is not written to the verification row, so a support
 * request to "resend the key" has exactly one honest answer: issue a new one and
 * revoke the old.
 *
 * **Why this needs its own signature even though the wallet just signed to
 * register.** Consent has to name what it authorises. The message for this purpose
 * says a key is being issued; the message for registration does not. If one
 * signature covered both, a wallet that agreed to appear in a public register
 * would have agreed to a credential being minted, and the register route could be
 * replayed into a key factory.
 */
import { IssueKeyBody } from "@/core/agents/registration";
import { consumeChallenge } from "@/lib/challenge";
import { agentKeysConfigured, issueAgentKey } from "@/lib/agentAuth";
import { burstCheck, tooManyAttempts } from "@/lib/credentialLimit";
import { clientIp } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { challengeRefusal, invalid, json, ownsAgent } from "../_shared";

export const dynamic = "force-dynamic";

const ISSUES_PER_MINUTE = 6;

/**
 * How many live keys one agent may hold at once.
 *
 * Rotation has to overlap — a long-running agent is redeployed without a gap, so
 * the new key must work before the old one stops — which is why this is not one.
 * It is not unbounded either: every live key is another credential that can leak,
 * and an agent with forty of them has lost track of which machines can act as it.
 */
const MAX_LIVE_KEYS = 5;

export async function POST(req: Request) {
  if (!agentKeysConfigured()) {
    return json(
      {
        error:
          "agent keys are not configured on this deployment (WELL_AGENT_KEY_PEPPER is unset)",
      },
      { status: 503 },
    );
  }

  const budget = burstCheck("issue-key", clientIp(req.headers), ISSUES_PER_MINUTE);
  if (!budget.ok) return tooManyAttempts(budget.retryAfter);

  const parsed = IssueKeyBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message);

  const { nonce, signature, agentId, label } = parsed.data;

  const consumed = await consumeChallenge({ nonce, signature, purpose: "issue-key" });
  if (!consumed.ok) return challengeRefusal(consumed.reason);

  // The challenge route derives `Subject:` from the agent being named, and the
  // wallet signed a message with that line in it. Re-checking it here is what
  // stops a signature collected for one agent being spent on another: without
  // this, an owner of two agents signs for the harmless one and the request names
  // the valuable one.
  if (consumed.subject !== agentId) {
    return json(
      { error: "that challenge authorises a different agent" },
      { status: 400 },
    );
  }

  try {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) return json({ error: "no such agent" }, { status: 404 });

    if (!ownsAgent(agent, consumed.wallet)) {
      return json(
        { error: "that wallet does not administer this agent" },
        { status: 403 },
      );
    }
    if (agent.status !== "active") {
      return json(
        { error: "this agent is disabled, so it cannot be given a new key" },
        { status: 409 },
      );
    }

    const live = await prisma.agentKey.count({ where: { agentId, revokedAt: null } });
    if (live >= MAX_LIVE_KEYS) {
      return json(
        {
          error: `this agent already holds ${live} live keys (the limit is ${MAX_LIVE_KEYS}) — revoke one first`,
        },
        { status: 409 },
      );
    }

    const issued = await issueAgentKey(agentId, label);

    await prisma.agentVerification
      .update({
        where: { id: consumed.verificationId },
        // The key id, which names the row. Never the token, which opens it.
        data: { outcome: "ok", subject: issued.keyId },
      })
      .catch(() => {
        // Bookkeeping on a key that has already been minted. Failing the request
        // now would tell the caller nothing was issued when something was.
      });

    return json(
      {
        ok: true,
        keyId: issued.keyId,
        token: issued.token,
        label,
        // Said in the response as well as on the page, because the page is not
        // the only thing that calls this.
        notice:
          "This is the only time this token is shown. It is stored as a salted, peppered digest and cannot be recovered.",
      },
      {
        status: 201,
        // A secret in a shared cache is a secret in someone else's hands.
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (e) {
    console.error("agents/keys POST:", (e as Error).message);
    return json({ error: "internal error" }, { status: 500 });
  }
}
