/**
 * Bind a wallet to an agent record, on that wallet's own signature.
 *
 * **Registration issues no key, and that is the whole design.** Minting a
 * credential here would make registration and credential-issuance the same act,
 * and they have to be separable: a key is issued only against a signature whose
 * message says "issue a new secret key for this agent", so consenting to appear in
 * a public register can never be replayed into consenting to hand out a secret.
 * It also makes the second call below safe — an already-registered wallet gets its
 * record back and nothing else, so a registration replayed a thousand times mints
 * nothing a thousand times.
 *
 * The wallet in the record is the wallet that signed, never a field in the body.
 * Without that, anyone could register a stranger's address, hold a credential
 * bound to it, and wait for that stranger to verify with World — at which point
 * the attacker is holding the key to a human-backed, payable wallet.
 */
import { Prisma } from "@prisma/client";
import { RegisterBody } from "@/core/agents/registration";
import { consumeChallenge } from "@/lib/challenge";
import { burstCheck, tooManyAttempts } from "@/lib/credentialLimit";
import { clientIp } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { agentPublic, challengeRefusal, invalid, json } from "../_shared";

export const dynamic = "force-dynamic";

const REGISTRATIONS_PER_MINUTE = 10;

export async function POST(req: Request) {
  const budget = burstCheck("register", clientIp(req.headers), REGISTRATIONS_PER_MINUTE);
  if (!budget.ok) return tooManyAttempts(budget.retryAfter);

  const parsed = RegisterBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message);

  const { nonce, signature, displayName, summary, ownerWallet } = parsed.data;

  const consumed = await consumeChallenge({ nonce, signature, purpose: "register" });
  if (!consumed.ok) return challengeRefusal(consumed.reason);

  const wallet = consumed.wallet;

  try {
    const existing = await prisma.agent.findUnique({
      where: { wallet },
      include: { keys: { orderBy: { createdAt: "desc" } } },
    });
    if (existing) {
      // Not an error, and not an update either. Returning the record is what lets
      // the page recover a session; letting this overwrite `displayName` would
      // hand anyone who ever controlled the wallet a way to rewrite the entry
      // under a key they no longer hold.
      return json({
        ok: true,
        created: false,
        agent: agentPublic(existing, existing.keys),
      });
    }

    const agent = await prisma.agent.create({
      data: {
        wallet,
        ownerWallet: ownerWallet ?? wallet,
        displayName,
        summary,
      },
    });
    return json(
      { ok: true, created: true, agent: agentPublic(agent, []) },
      { status: 201 },
    );
  } catch (e) {
    // Two registrations for one wallet racing each other. `wallet` is unique, so
    // exactly one create wins and the loser reads back what the winner wrote —
    // the same answer a caller a second later would have got.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const now = await prisma.agent.findUnique({
        where: { wallet },
        include: { keys: { orderBy: { createdAt: "desc" } } },
      });
      if (now) {
        return json({
          ok: true,
          created: false,
          agent: agentPublic(now, now.keys),
        });
      }
    }
    console.error("agents/register POST:", (e as Error).message);
    return json({ error: "internal error" }, { status: 500 });
  }
}
