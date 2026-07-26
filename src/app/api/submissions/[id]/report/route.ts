/**
 * Escalate a rejected submission to a conduct report against the human behind it.
 *
 * This is the heaviest action in the platform: a report can bar a human across
 * every wallet they will ever hold. So it is gated three ways, and all three are
 * checked against something other than the caller's own say-so.
 *
 *   1. **The submission must already be rejected.** A report is not a first move;
 *      it is what a rejection escalates to when the conduct was not merely wrong
 *      but reportable. Filing against an open or approved submission is refused.
 *
 *   2. **The filer must be a reviewer according to the ledger itself.** Not a list
 *      this route keeps — `StandingLedger.isReviewer(signer)`, read live, mirroring
 *      the contract's own `onlyReviewer` gate at the boundary so the app can never
 *      accept a filer the chain would reject. The signature proves the signer holds
 *      the wallet; the chain decides whether that wallet may file.
 *
 *   3. **The target is resolved on chain, never named in the body.** The report
 *      lands on the `humanId` the chain binds to the *submitting agent's* wallet,
 *      so a report cannot be aimed at a human the caller merely names.
 *
 * The category is passed to the contract, which raises a too-low severity to its
 * own floor — Violence, Exploitation and WeaponsOrMassHarm carry a permanent bar no
 * grade can talk down. The app names the category; the contract owns the penalty.
 */
import { keccak256, toHex } from "viem";
import { ReportBody } from "@/core/submissions/schema";
import { toPublicSubmission } from "@/core/submissions/view";
import { deriveStatus } from "@/core/submissions/status";
import { consumeChallenge } from "@/lib/challenge";
import { humanBacking } from "@/lib/chainReads";
import { isHumanBacked } from "@/core/world/humanId";
import { isOnChainReviewer, reportConduct, reviewerConfigured } from "@/lib/reviewer";
import { burstCheck, tooManyAttempts } from "@/lib/credentialLimit";
import { clientIp } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { json, fail, invalid, challengeRefusal, loadSubmission } from "../../_shared";

export const dynamic = "force-dynamic";

const REPORTS_PER_MINUTE_PER_CALLER = 6;

function ballotsOf(votes: { choice: string; weightBps: string }[]) {
  return votes.map((v) => ({
    choice: v.choice === "reject" ? ("reject" as const) : ("approve" as const),
    weightBps: BigInt(v.weightBps),
  }));
}

/**
 * What the on-chain `evidenceHash` commits to, published in full so anyone who
 * kept a copy can recompute it. It names the rejected claim and the filer — never
 * the raw humanId, which is already a one-way image on chain.
 */
function evidencePreimage(input: {
  submissionId: string;
  agentWallet: string;
  category: number;
  severity: number;
  filedBy: string;
  reason: string;
}): string {
  return [
    "votive:conduct-report:v1",
    `submission: ${input.submissionId}`,
    `agentWallet: ${input.agentWallet}`,
    `category: ${input.category}`,
    `severity: ${input.severity}`,
    `filedBy: ${input.filedBy}`,
    `reason: ${input.reason}`,
  ].join("\n");
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const budget = burstCheck("report", clientIp(req.headers), REPORTS_PER_MINUTE_PER_CALLER);
  if (!budget.ok) return tooManyAttempts(budget.retryAfter);

  const parsed = ReportBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
  const { nonce, signature, category, severity, reason } = parsed.data;

  const row = await loadSubmission(params.id).catch(() => null);
  if (!row) return fail("no such submission", 404);
  if (row.reportTxHash) {
    return fail("a conduct report has already been filed on this submission", 409);
  }

  // A report escalates a rejection. Checked before the signature is spent.
  const status = deriveStatus(
    { decidesAt: row.decidesAt, settledAt: row.settledAt, ballots: ballotsOf(row.votes) },
    new Date(),
  ).status;
  if (status !== "rejected") {
    return fail(`this submission is ${status}; only a rejected submission can be reported`, 409);
  }

  if (!reviewerConfigured()) {
    return fail("this deployment has no reviewer key or StandingLedger address", 503);
  }

  const consumed = await consumeChallenge({ nonce, signature, purpose: "report" });
  if (!consumed.ok) return challengeRefusal(consumed.reason);
  if (consumed.subject !== row.id) {
    return fail("that challenge authorises a report on a different submission", 400);
  }
  const filer = consumed.wallet as `0x${string}`;

  // The ledger's own gate, mirrored. A signature proved the signer holds `filer`;
  // this asks the chain whether `filer` is allowed to file at all.
  const reviewer = await isOnChainReviewer(filer);
  if (!reviewer.ok) {
    return fail(`could not verify the filer is a reviewer: ${reviewer.degraded}`, 502);
  }
  if (!reviewer.value) {
    return fail("only a reviewer registered on the StandingLedger can file a conduct report", 403);
  }

  // The target: the human behind the wallet that made the claim, read on chain.
  const backing = await humanBacking(row.agentWallet);
  if (!backing.ok) {
    return fail(`could not read the human behind the agent: ${backing.degraded}`, 502);
  }
  if (!isHumanBacked(backing.value.humanId)) {
    return fail(
      "the agent behind this submission is not human-backed, so there is no standing to report against",
      409,
    );
  }
  const humanId = backing.value.humanId;

  const preimage = evidencePreimage({
    submissionId: row.id,
    agentWallet: row.agentWallet,
    category,
    severity,
    filedBy: filer,
    reason,
  });
  const evidenceHash = keccak256(toHex(preimage));

  const filed = await reportConduct(humanId, category, severity, evidenceHash, {
    subject: row.agentWallet,
    detail: `report on submission ${row.id}: ${reason}`.slice(0, 300),
  });

  if (!filed.ok) {
    const httpStatus = filed.reason === "not-configured" ? 503 : 502;
    return fail(`the report did not land: ${filed.detail}`, httpStatus);
  }

  const updated = await prisma.submission.update({
    where: { id: row.id },
    data: { reportTxHash: filed.txHash },
    include: { votes: { orderBy: { createdAt: "asc" } } },
  });

  return json({
    ok: true,
    txHash: filed.txHash,
    evidenceHash,
    evidencePreimage: preimage,
    submission: toPublicSubmission(updated),
  });
}
