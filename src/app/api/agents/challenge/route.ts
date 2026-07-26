/**
 * Hand out the exact words a wallet is asked to sign.
 *
 * The client sends who it is and what it wants to do; it never sends the message.
 * `challengeMessage` builds that from the row we just wrote, and the consuming
 * route rebuilds it from the same row — so there is no point at which a caller
 * gets to choose what its own signature says. Supplying the text would let someone
 * sign "register this wallet" and present it where "issue a key for agent X" was
 * required, with a valid nonce and a correct address on both.
 *
 * **The subject is derived here, never accepted.** `Subject:` is the line in the
 * message that names *which* agent or *which* key the signature is for, so taking
 * it from the request would put the one load-bearing detail back under the
 * caller's control. For each purpose it is computed from the thing being acted on,
 * and the consuming route asserts the subject it gets back is the target it is
 * about to act on. `vote` is the exception: slice D owns what a vote is about, and
 * passes its own submission id through.
 */
import { ChallengeBody } from "@/core/agents/registration";
import { mintChallenge, type ChallengePurpose } from "@/lib/challenge";
import { burstCheck, tooManyAttempts } from "@/lib/credentialLimit";
import { clientIp } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { invalid, json } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * Every challenge is a database row, and rows are the thing worth bounding here —
 * a signature cannot be brute-forced, so this is backpressure and not a guard.
 *
 * `burstCheck` rather than `enforceRateLimit`: that helper returns `null` on sight
 * of `WELL_RATELIMIT_DISABLED=1`, which is set in this deployment, so it would
 * bound nothing at all.
 */
const CHALLENGES_PER_MINUTE = 20;

const KEY_ID_RE = /^[0-9a-f]{16}$/;

export async function POST(req: Request) {
  const budget = burstCheck("challenge", clientIp(req.headers), CHALLENGES_PER_MINUTE);
  if (!budget.ok) return tooManyAttempts(budget.retryAfter);

  const parsed = ChallengeBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message);

  const { wallet, purpose, agentId, subject } = parsed.data;

  // Which agent the row is filed against, and what the message will name. Both
  // are decided here from the purpose, not read off the request.
  let linkedAgentId: string | undefined;
  let derivedSubject: string | undefined;

  if (purpose === "verify-world" || purpose === "issue-key") {
    if (!agentId) {
      return json(
        { error: `a ${purpose} challenge has to name the agent it is for` },
        { status: 400 },
      );
    }
    // Checked before minting because `AgentVerification.agentId` is a foreign key
    // and an unknown id would otherwise surface as a Prisma error rather than as
    // a sentence. Confirming existence leaks nothing: the register is public.
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, displayName: true },
    });
    if (!agent) return json({ error: "no such agent" }, { status: 404 });
    linkedAgentId = agent.id;
    derivedSubject = agent.id;
  } else if (purpose === "revoke-key") {
    if (!subject || !KEY_ID_RE.test(subject)) {
      return json(
        { error: "a revoke-key challenge has to name a key id" },
        { status: 400 },
      );
    }
    // Deliberately *not* checked against the database. Answering "no such key"
    // here would turn this endpoint into a directory of live key ids, and a key
    // id is all an attacker needs to drive an honest agent's key into the
    // escalating lockout and keep it there. Whether the key exists is settled at
    // revocation time, behind a signature, with one answer for both cases.
    derivedSubject = subject;
  } else if (purpose === "vote") {
    if (!subject) {
      return json(
        { error: "a vote challenge has to name the submission it is for" },
        { status: 400 },
      );
    }
    derivedSubject = subject;
  }

  try {
    const challenge = await mintChallenge({
      wallet,
      purpose: purpose as ChallengePurpose,
      ...(linkedAgentId ? { agentId: linkedAgentId } : {}),
      ...(derivedSubject ? { subject: derivedSubject } : {}),
    });
    return json({ ok: true, ...challenge });
  } catch (e) {
    console.error("agents/challenge POST:", (e as Error).message);
    return json({ error: "internal error" }, { status: 500 });
  }
}
