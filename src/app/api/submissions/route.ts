/**
 * The submissions collection: post a claim, or read the ones already posted.
 *
 * **POST authenticates the agent as its first statement, and nothing downstream
 * re-checks.** This is the gate the whole "agent secret gates every submission"
 * requirement rests on: a wish solution or a resource request may only be created
 * by a caller presenting a live agent key, verified server-side by
 * `authenticateAgent`. Skipping it here would be the single largest hole in the
 * platform — an open form anyone could post payable claims through — so it runs
 * before the body is even parsed.
 *
 * **The agent in the row is the authenticated agent, never a field in the body.**
 * `SolutionBody` and `ResourceRequestBody` carry an `agentId`, but it is only ever
 * checked *against* the key's agent; the row is written from the credential. A key
 * cannot post work under another agent's name.
 *
 * GET is public and carries no secret: a submission is a public claim by design,
 * and everything it returns goes through `toPublicSubmission`, which computes the
 * derived status and strips every credential and signature.
 */
import { Prisma } from "@prisma/client";
import { keccak256, toHex } from "viem";
import { milestonePreimage, normaliseMilestone } from "@/core/submissions/milestone";
import { SubmissionBody } from "@/core/submissions/schema";
import { toPublicSubmission } from "@/core/submissions/view";
import { optimisticWindow, decidesAt } from "@/core/submissions/window";
import { authenticateAgent } from "@/lib/agentAuth";
import { bountyOf } from "@/lib/chainReads";
import { burstCheck, tooManyAttempts } from "@/lib/credentialLimit";
import { clientIp } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { json, fail, invalid } from "./_shared";

export const dynamic = "force-dynamic";

const SUBMISSIONS_PER_MINUTE_PER_CALLER = 12;

export async function POST(req: Request) {
  // The gate. Before the body, before anything: no live key, no submission.
  const auth = await authenticateAgent(req);
  if (!auth.ok) return auth.response;
  const agent = auth.agent;

  const budget = burstCheck("submission", clientIp(req.headers), SUBMISSIONS_PER_MINUTE_PER_CALLER);
  if (!budget.ok) return tooManyAttempts(budget.retryAfter);

  const parsed = SubmissionBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
  const b = parsed.data;

  // The body names an agent, but the credential decides whose it is. They must
  // agree — a mismatch is a client that thinks it is someone else, and answering
  // 403 rather than silently using the key's agent keeps that bug loud.
  if (b.agentId !== agent.agentId) {
    return fail("that key does not belong to the agent this submission names", 403);
  }

  const win = optimisticWindow();
  const submittedAt = new Date();

  if (b.kind === "solution") {
    // The claim is keyed on a live bounty on a real rail. Read it now, so a
    // solution cannot be posted against a bounty that does not exist, is closed,
    // or has already paid out its whole balance — all of which would only surface
    // as a confusing failure days later at settlement.
    const chain = b.chain ?? "base-sepolia";
    const bounty = await bountyOf(b.railAddress as `0x${string}`, b.bountyId, chain);
    if (!bounty.ok) {
      return fail(`could not read that bounty: ${bounty.degraded}`, 502);
    }
    if (bounty.value.closed) {
      return fail("that bounty is closed", 409);
    }
    if (bounty.value.total <= bounty.value.paid) {
      return fail("that bounty has already paid out its whole balance", 409);
    }
    // The rail refuses `release` for a bounty nobody has claimed, and credits only
    // the agent who claimed it. Both are knowable now, so refuse now — otherwise
    // the claim sails through its window and settlement reverts `NothingClaimed`
    // days later, against a clock nobody can rewind.
    if (bounty.value.agent === "0x0000000000000000000000000000000000000000") {
      return fail(
        "that bounty has not been claimed on-chain — claim() it on the rail as this agent first",
        409,
      );
    }
    if (bounty.value.agent.toLowerCase() !== agent.wallet.toLowerCase()) {
      return fail("that bounty is claimed on-chain by a different agent", 409);
    }

    // The milestone, named or given. A label is turned into the hash `release` is
    // keyed on, and the preimage travels back in the response so the agent can
    // recompute the commitment rather than take it on trust — the same bargain
    // `agents/verify` makes with `evidencePreimage`.
    let resultHash: `0x${string}`;
    let milestone: string | null = null;
    let preimage: string | null = null;

    if (b.resultHash !== undefined) {
      resultHash = b.resultHash as `0x${string}`;
    } else {
      const label = normaliseMilestone(b.milestone);
      if (!label.ok) return invalid(label.why);
      milestone = label.label;
      preimage = milestonePreimage({
        railAddress: b.railAddress,
        bountyId: b.bountyId,
        milestone: label.label,
      });
      resultHash = keccak256(toHex(preimage));
    }

    try {
      const row = await prisma.submission.create({
        data: {
          kind: "solution",
          agentId: agent.agentId,
          agentWallet: agent.wallet,
          wish: b.wish,
          railAddress: b.railAddress,
          bountyId: b.bountyId,
          amountWei: b.amountWei ?? null,
          resultHash,
          milestone,
          title: b.title,
          body: b.body,
          submittedAt,
          decidesAt: decidesAt(submittedAt, win.ms),
        },
        include: { votes: true },
      });
      return json(
        {
          ok: true,
          window: win,
          submission: toPublicSubmission(row),
          // What the release will be keyed on, and — when we derived it — the exact
          // bytes it commits to. Returned so the agent can recompute the hash
          // instead of trusting that we derived the one it meant.
          milestone: {
            resultHash,
            label: milestone,
            preimage,
            derived: preimage !== null,
          },
        },
        { status: 201 },
      );
    } catch (e) {
      // The `@@unique([railAddress, bountyId, resultHash])` guard: this exact
      // milestone has already been claimed. Refused before it costs gas, and the
      // same answer whether the first claim was this agent's or another's.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return fail("that milestone has already been claimed on this bounty", 409);
      }
      console.error("submissions POST (solution):", (e as Error).message);
      return fail("internal error", 500);
    }
  }

  // resource-request
  try {
    const row = await prisma.submission.create({
      data: {
        kind: "resource-request",
        agentId: agent.agentId,
        agentWallet: agent.wallet,
        wish: b.wish,
        resourceKind: b.resourceKind,
        resourceId: b.resourceId ?? null,
        amountWei: b.amountWei ?? null,
        title: b.title,
        body: b.body,
        submittedAt,
        decidesAt: decidesAt(submittedAt, win.ms),
      },
      include: { votes: true },
    });
    return json(
      { ok: true, window: win, submission: toPublicSubmission(row) },
      { status: 201 },
    );
  } catch (e) {
    console.error("submissions POST (resource-request):", (e as Error).message);
    return fail("internal error", 500);
  }
}

/**
 * List submissions, newest first, optionally filtered by kind or wish.
 *
 * No authentication: the list is public. The derived status is computed per row
 * from one shared clock so a page cannot show two rows judged against different
 * "now"s.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const kindParam = url.searchParams.get("kind");
  const wishParam = url.searchParams.get("wish");
  const kind =
    kindParam === "solution" || kindParam === "resource-request" ? kindParam : undefined;

  const rows = await prisma.submission
    .findMany({
      where: {
        ...(kind ? { kind } : {}),
        ...(wishParam ? { wish: wishParam.toLowerCase() } : {}),
      },
      include: { votes: { orderBy: { createdAt: "asc" } } },
      orderBy: { submittedAt: "desc" },
      take: 200,
    })
    .catch(() => null);

  if (rows === null) {
    return fail("could not read submissions", 500);
  }

  const now = new Date();
  return json({ ok: true, submissions: rows.map((r) => toPublicSubmission(r, now)) });
}
