/**
 * What an agent can find out about itself, using only its key.
 *
 * This is the endpoint an integrator hits first, so it is also the one that has to
 * answer "is my key working?" unambiguously — a 200 with the agent's own name in
 * it, or the single uniform 401 that every wrong, revoked, locked or unknown key
 * gets. There is nothing in between and nothing that hints at which of those it
 * was.
 *
 * It reports the key's siblings, and it is the only place that does. Key ids are
 * withheld from every unauthenticated view — including the public roster — because
 * an id is all it takes to drive an honest agent's credential into the escalating
 * lockout and keep it there. Knowing one live key for an agent is the proof of
 * standing that earns the list.
 *
 * The backing and standing below are read from the chain on every call and are
 * never cached. An agent's right to work can be revoked by the attestor or barred
 * by the ledger without us being told, and a stored "verified" flag would keep
 * saying yes afterwards. When a read fails it says so — an agent that mistakes
 * "we could not check" for "you are not backed" will stop working for no reason.
 */
import { authenticateAgent } from "@/lib/agentAuth";
import { humanBacking, standingFor } from "@/lib/chainReads";
import { isHumanBacked } from "@/core/world/humanId";
import { prisma } from "@/lib/db";
import { agentPublic, json } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return auth.response;

  try {
    const agent = await prisma.agent.findUnique({
      where: { id: auth.agent.agentId },
      include: { keys: { orderBy: { createdAt: "desc" } } },
    });
    if (!agent) {
      // The key authenticated, so a row existed a moment ago. Deleted mid-request
      // is the only way here, and it is not the caller's mistake to explain.
      return json({ error: "internal error" }, { status: 500 });
    }

    const backing = await humanBacking(agent.wallet);

    // Standing is keyed on the human, so there is nothing to ask for a wallet
    // that has no human behind it — and asking anyway would report the zero
    // human's record as if it were this agent's.
    const standing =
      backing.ok && isHumanBacked(backing.value.humanId)
        ? await standingFor(backing.value.humanId)
        : null;

    return json(
      {
        ok: true,
        agent: agentPublic(agent, agent.keys),
        /** Which key authenticated this request, of the ones listed above. */
        authenticatedWith: auth.agent.keyId,
        humanBacking: backing.ok
          ? {
              read: true,
              backed: isHumanBacked(backing.value.humanId),
              humanId: backing.value.humanId,
              assurance: backing.value.assurance,
              walletsByThisHuman: backing.value.walletCount,
            }
          : { read: false, degraded: backing.degraded },
        standing:
          standing === null
            ? null
            : standing.ok
              ? {
                  read: true,
                  barred: standing.value.barred,
                  multiplierBps: standing.value.multiplierBps.toString(),
                  fulfilments: standing.value.fulfilments,
                  failures: standing.value.failures,
                  reports: standing.value.reports,
                  barredUntil: standing.value.barredUntil,
                }
              : { read: false, degraded: standing.degraded },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    console.error("agents/me GET:", (e as Error).message);
    return json({ error: "internal error" }, { status: 500 });
  }
}
