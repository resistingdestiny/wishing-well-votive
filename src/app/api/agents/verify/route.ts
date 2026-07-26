/**
 * Ask World who is behind an agent's wallet, and mirror the answer onto Base.
 *
 * Two chains and one claim. AgentBook on World Chain knows that a unique human
 * registered this wallet; `HumanBackingRegistry` on Base Sepolia is where the rest
 * of the protocol looks. This route is the bridge, and the only thing it is
 * allowed to write is what World actually said.
 *
 * **The four World outcomes stay four.** `backed`, `no-human`, `unreachable` and
 * `not-configured` leave here as four different statuses with four different
 * bodies. AgentKit's `lookupHuman` collapses the middle two into a single `null`,
 * and rendering that as "no human is behind this wallet" tells someone they are
 * not a person because an RPC endpoint was busy. `worldVerify` already refuses to
 * make that mistake; this route's job is not to re-make it by flattening the union
 * into a boolean on the way out.
 *
 * **The assurance we write is DEVICE, and we do not write what we cannot back.**
 * AgentBook establishes that a unique human exists. It says nothing about whether
 * anyone looked at a face. `SELFIE` would assert a liveness check we never
 * observed, so `ATTESTED_ASSURANCE` is passed explicitly rather than inherited
 * from `loadWorldConfig`, whose default is `selfie`.
 *
 * **The badge is read back, not assumed.** After the receipt confirms, the chain
 * is read again and the tier in the response is the one `assuranceOf()` returned.
 * Reporting the tier we intended to write would render a green badge over a
 * transaction that reverted, silently reordered, or landed differently than we
 * expected.
 */
import { keccak256, toHex } from "viem";
import { VerifyWorldBody } from "@/core/agents/registration";
import { consumeChallenge } from "@/lib/challenge";
import { lookupHumanBacking } from "@/lib/worldVerify";
import { ATTESTED_ASSURANCE, attestHuman, attestorConfigured } from "@/lib/attestor";
import { humanBacking } from "@/lib/chainReads";
import { isHumanBacked } from "@/core/world/humanId";
import { burstCheck, tooManyAttempts } from "@/lib/credentialLimit";
import { clientIp } from "@/lib/rateLimit";
import { explorerTx, recordTx } from "@/lib/txLog";
import { prisma } from "@/lib/db";
import { challengeRefusal, invalid, json } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * This is the one route in slice B that spends money.
 *
 * Every call that reaches `attestHuman` costs the attestor gas from a funded key,
 * and the wallet paying is ours. The signature already forces an attacker to own
 * the wallet they are attesting, and the idempotence check below refuses to
 * re-send an attestation that is already on chain — so these two budgets are the
 * third layer, not the first.
 */
const VERIFIES_PER_MINUTE_PER_CALLER = 6;
const VERIFIES_PER_MINUTE_PER_AGENT = 3;

/**
 * What the on-chain `evidenceHash` commits to.
 *
 * A hash on chain that nobody can reproduce is decoration. This preimage is
 * returned to the caller in full so the commitment is checkable by anyone who
 * kept a copy — `keccak256(toHex(preimage))` must equal the `evidenceHash`
 * argument in the transaction.
 *
 * The raw AgentBook identifier is deliberately absent. `humanIdOnChain` is already
 * a one-way image of it and is public on Base regardless; putting the raw value in
 * a preimage we publish would leak the thing the hashing exists to protect.
 */
function evidencePreimage(input: {
  wallet: string;
  humanIdOnChain: string;
  assurance: number;
  verificationId: string;
  issuedAt: string;
}): string {
  return [
    "votive:agent-human-attestation:v1",
    `wallet: ${input.wallet}`,
    `humanId: ${input.humanIdOnChain}`,
    `assurance: ${input.assurance}`,
    `verification: ${input.verificationId}`,
    `issued: ${input.issuedAt}`,
  ].join("\n");
}

export async function POST(req: Request) {
  const budget = burstCheck("verify-world", clientIp(req.headers), VERIFIES_PER_MINUTE_PER_CALLER);
  if (!budget.ok) return tooManyAttempts(budget.retryAfter);

  const parsed = VerifyWorldBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message);

  const { nonce, signature, agentId } = parsed.data;

  const perAgent = burstCheck("verify-world-agent", agentId, VERIFIES_PER_MINUTE_PER_AGENT);
  if (!perAgent.ok) return tooManyAttempts(perAgent.retryAfter);

  const consumed = await consumeChallenge({ nonce, signature, purpose: "verify-world" });
  if (!consumed.ok) return challengeRefusal(consumed.reason);

  if (consumed.subject !== agentId) {
    return json(
      { error: "that challenge authorises a different agent" },
      { status: 400 },
    );
  }

  const verificationId = consumed.verificationId;

  /** Record what happened on the row the signature created, and answer. */
  const finish = async (
    outcome: string,
    body: Record<string, unknown>,
    status: number,
    extra: Record<string, unknown> = {},
  ): Promise<Response> => {
    await prisma.agentVerification
      .update({ where: { id: verificationId }, data: { outcome, ...extra } })
      .catch(() => {
        // The record of an attestation is worth having and is not worth failing
        // a completed transaction over.
      });
    return json(body, { status });
  };

  try {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) return json({ error: "no such agent" }, { status: 404 });

    // The wallet about to be bound on chain is `agent.wallet`, so that is the
    // wallet whose consent this needs. An owner address administers the record;
    // it does not get to bind a key it may not hold to a human for good — the
    // registry refuses to rebind afterwards without a revocation.
    if (consumed.wallet !== agent.wallet) {
      return json(
        {
          error:
            "World verification has to be signed by the agent's own wallet, because that is the wallet being bound",
        },
        { status: 403 },
      );
    }

    if (!attestorConfigured()) {
      return json(
        {
          ok: false,
          state: "not-configured",
          because:
            "this deployment has no attestor key or human registry address, so nothing can be written on chain",
        },
        { status: 503 },
      );
    }

    const lookup = await lookupHumanBacking(agent.wallet);

    if (lookup.state === "not-configured") {
      return await finish(
        "unreachable",
        {
          ok: false,
          state: "not-configured",
          because:
            "this deployment is not pointed at World (set WELL_WORLD_ENABLED=1, and WELL_AGENTBOOK_ADDRESS / WELL_WORLD_CHAIN_RPC_URL if the defaults are wrong)",
        },
        503,
        { failureReason: "world lookup not configured" },
      );
    }

    if (lookup.state === "unreachable") {
      // Emphatically not `no-human`. We asked and did not get an answer we trust,
      // and saying otherwise would be an accusation dressed as a result.
      return await finish(
        "unreachable",
        {
          ok: false,
          state: "unreachable",
          because: lookup.because,
        },
        502,
        { failureReason: lookup.because.slice(0, 300) },
      );
    }

    if (lookup.state === "no-human") {
      // A true answer, so not an error status. AgentBook was reachable and had
      // nothing for this wallet.
      return await finish(
        "no-human",
        {
          ok: true,
          state: "no-human",
          because:
            "AgentBook answered, and no verified human is registered against this wallet yet",
        },
        200,
      );
    }

    const { humanIdRaw, humanIdOnChain } = lookup;

    // Already on chain? Then send nothing. `attest` does not revert when it
    // re-writes an identical binding, so without this check anyone could hold the
    // button down and drain the attestor's balance a transaction at a time.
    const before = await humanBacking(agent.wallet);
    if (
      before.ok &&
      isHumanBacked(before.value.humanId) &&
      before.value.humanId.toLowerCase() === humanIdOnChain.toLowerCase() &&
      before.value.assurance >= ATTESTED_ASSURANCE
    ) {
      return await finish(
        "attested",
        {
          ok: true,
          state: "already-attested",
          humanId: before.value.humanId,
          assurance: before.value.assurance,
          walletsByThisHuman: before.value.walletCount,
          because:
            "this wallet is already bound to this human on chain, so no transaction was sent",
        },
        200,
        { humanIdRaw, humanIdOnChain, assurance: before.value.assurance },
      );
    }

    if (
      before.ok &&
      isHumanBacked(before.value.humanId) &&
      before.value.humanId.toLowerCase() !== humanIdOnChain.toLowerCase()
    ) {
      return await finish(
        "rebind-refused",
        {
          ok: false,
          state: "rebind-refused",
          because:
            "this wallet is already bound to a different human on chain; that binding has to be revoked before it can be rebound",
        },
        409,
        {
          humanIdRaw,
          humanIdOnChain,
          failureReason: "wallet bound to another human",
        },
      );
    }

    const issuedAt = new Date().toISOString();
    const preimage = evidencePreimage({
      wallet: agent.wallet,
      humanIdOnChain,
      assurance: ATTESTED_ASSURANCE,
      verificationId,
      issuedAt,
    });
    const evidenceHash = keccak256(toHex(preimage));

    const attested = await attestHuman(
      agent.wallet,
      humanIdOnChain,
      ATTESTED_ASSURANCE,
      evidenceHash,
    );

    if (!attested.ok) {
      const status =
        attested.reason === "rebind-refused" ? 409 : attested.reason === "not-configured" ? 503 : 502;
      return await finish(
        attested.reason === "rebind-refused" ? "rebind-refused" : "tx-reverted",
        { ok: false, state: attested.reason, because: attested.detail },
        status,
        {
          humanIdRaw,
          humanIdOnChain,
          evidenceHash,
          failureReason: attested.detail.slice(0, 300),
        },
      );
    }

    // Read the chain rather than reporting what we sent. The receipt says the
    // transaction succeeded; only `assuranceOf` says what the registry now holds.
    const after = await humanBacking(agent.wallet);

    await recordTx({
      track: "world",
      chain: "base-sepolia",
      txHash: attested.txHash,
      // The same sentence `/api/tx` uses for `human-attested`, so a client-noted
      // write and a server-sent one land as one row rather than two.
      what: "An agent wallet was bound to a verified human",
      detail: `${agent.displayName} (${agent.wallet}) bound at assurance ${ATTESTED_ASSURANCE}`,
      contract: process.env.NEXT_PUBLIC_WELL_HUMAN_REGISTRY,
      subject: agent.wallet,
    });

    return await finish(
      "attested",
      {
        ok: true,
        state: "attested",
        txHash: attested.txHash,
        explorer: explorerTx("base-sepolia", attested.txHash),
        humanId: humanIdOnChain,
        /** What we asked the registry to record. */
        assuranceWritten: ATTESTED_ASSURANCE,
        /** What the registry says now. This is the one the badge comes from. */
        readBack: after.ok
          ? {
              read: true,
              assurance: after.value.assurance,
              humanId: after.value.humanId,
              walletsByThisHuman: after.value.walletCount,
            }
          : { read: false, degraded: after.degraded },
        evidenceHash,
        evidencePreimage: preimage,
      },
      200,
      {
        humanIdRaw,
        humanIdOnChain,
        assurance: ATTESTED_ASSURANCE,
        evidenceHash,
        attestTx: attested.txHash,
        attestedAt: new Date(),
      },
    );
  } catch (e) {
    console.error("agents/verify POST:", (e as Error).message);
    return json({ error: "internal error" }, { status: 500 });
  }
}
