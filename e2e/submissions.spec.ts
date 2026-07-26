/**
 * Submissions — the derived-status core, and the four routes probed at their gates.
 *
 * Unit tests in a Playwright harness, exactly as `agent-auth.spec.ts` explains: no
 * browser, no server, run with `npx playwright test submissions`. They exercise two
 * things.
 *
 *   The pure core — `deriveStatus`, `tally`, `voteWeightBps`, `optimisticWindow`.
 *   This is where the whole optimistic promise lives (silence approves; a contested
 *   claim needs the weighted vote; a tie is not an approval; a stored settlement
 *   outranks the clock), and it is a pure function of a row and a clock, so it is
 *   pinned here without a node.
 *
 *   The route gates that decide *before* touching the chain. Every route is written
 *   so its refusals — no key, wrong agent, closed window, wrong subject, not
 *   approved, not rejected — are reached before any on-chain read or write. Those
 *   are asserted against the real handlers. The paths that do move money or read
 *   standing (a successful vote, a real settle, a real report) are deliberately
 *   *not* driven here: a unit suite must not sign a Base Sepolia transaction, and
 *   those seams are the demo's job to show live. So each route is taken exactly up
 *   to the last deterministic refusal and no further.
 */
import { expect, test } from "@playwright/test";
import crypto from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// A deterministic pepper, set before anything reads it — issuing a key hashes the
// secret under `pepper()`, which looks at `process.env` per call.
process.env.WELL_AGENT_KEY_PEPPER = "test-pepper-not-a-real-one";

import { deriveStatus, mayRelease, acceptsVotes } from "../src/core/submissions/status";
import { tally, voteWeightBps, PARITY_BPS } from "../src/core/submissions/weight";
import { optimisticWindow, decidesAt, DEFAULT_WINDOW_MS, MIN_WINDOW_MS } from "../src/core/submissions/window";
import { toPublicSubmission } from "../src/core/submissions/view";
import { issueAgentKey } from "../src/lib/agentAuth";
import { mintChallenge } from "../src/lib/challenge";
import { prisma } from "../src/lib/db";

import { POST as postSubmission, GET as listSubmissions } from "../src/app/api/submissions/route";
import { GET as getSubmission } from "../src/app/api/submissions/[id]/route";
import { POST as voteOnSubmission } from "../src/app/api/submissions/[id]/vote/route";
import { POST as settleSubmission } from "../src/app/api/submissions/[id]/settle/route";
import { POST as reportSubmission } from "../src/app/api/submissions/[id]/report/route";

// --------------------------------------------------------------------- fixtures

/** Everything this file writes carries this marker so cleanup cannot over-reach. */
const MARKER = `0xsub${crypto.randomBytes(8).toString("hex")}`;
const agentIds: string[] = [];
const agentWallets: string[] = [];
const submissionIds: string[] = [];
const signers: string[] = [];

const hex = (bytes: number) => `0x${crypto.randomBytes(bytes).toString("hex")}`;
const anAddress = () => hex(20) as `0x${string}`;
const aBytes32 = () => hex(32);

/** A caller address, distinct per request unless a test pins one — so one test's
 *  refusals never spend another's rate budget and flip a 4xx into a 429. */
const someCaller = () => `198.51.100.${crypto.randomBytes(8).toString("hex")}`;

async function makeAgent(): Promise<{ agentId: string; wallet: string }> {
  const wallet = `${MARKER}${crypto.randomBytes(4).toString("hex")}`.slice(0, 42);
  agentWallets.push(wallet);
  const agent = await prisma.agent.create({
    data: {
      wallet,
      ownerWallet: wallet,
      displayName: "test agent",
      summary: "created by e2e/submissions.spec.ts",
    },
  });
  agentIds.push(agent.id);
  return { agentId: agent.id, wallet };
}

/** A row written straight to the database, for the route gates that read one but
 *  must refuse before any chain call. `decidesAt` is the knob the window turns on. */
async function makeSubmission(over: {
  agentId: string;
  agentWallet: string;
  kind?: string;
  decidesAt?: Date;
  settledAt?: Date | null;
  railAddress?: string | null;
  bountyId?: number | null;
  resultHash?: string | null;
  wish?: string | null;
  reportTxHash?: string | null;
}) {
  const row = await prisma.submission.create({
    data: {
      kind: over.kind ?? "solution",
      agentId: over.agentId,
      agentWallet: over.agentWallet,
      wish: over.wish ?? anAddress().toLowerCase(),
      railAddress: over.railAddress === undefined ? anAddress().toLowerCase() : over.railAddress,
      bountyId: over.bountyId === undefined ? 1 : over.bountyId,
      resultHash: over.resultHash === undefined ? aBytes32() : over.resultHash,
      title: "a test submission",
      body: "a body long enough to satisfy the schema minimum of twenty characters",
      submittedAt: new Date(),
      decidesAt: over.decidesAt ?? new Date(Date.now() + 60 * 60 * 1000),
      settledAt: over.settledAt ?? null,
      reportTxHash: over.reportTxHash ?? null,
    },
    include: { votes: true },
  });
  submissionIds.push(row.id);
  return row;
}

const jsonReq = (
  url: string,
  body: unknown,
  opts: { token?: string; ip?: string } = {},
): Request =>
  new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": opts.ip ?? someCaller(),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const newSigner = () => {
  const account = privateKeyToAccount(generatePrivateKey());
  signers.push(account.address.toLowerCase());
  return account;
};

test.afterAll(async () => {
  // Delete only what this file created, children first: votes cascade on the
  // submission, but the submission's FK to the agent means agents go last.
  await prisma.submissionVote.deleteMany({ where: { submissionId: { in: submissionIds } } });
  await prisma.submission.deleteMany({ where: { id: { in: submissionIds } } });
  await prisma.agentKey.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.agentVerification.deleteMany({ where: { wallet: { in: signers } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

// ------------------------------------------------------------- the derived status

test.describe("deriving a status", () => {
  const future = () => new Date(Date.now() + 60_000);
  const past = () => new Date(Date.now() - 60_000);
  const approve = { choice: "approve" as const, weightBps: PARITY_BPS };
  const reject = { choice: "reject" as const, weightBps: PARITY_BPS };

  test("inside the window with no votes it is open, and silence is winning", () => {
    const d = deriveStatus({ decidesAt: future(), settledAt: null, ballots: [] });
    expect(d.status).toBe("open");
    expect(d.live).toBe(true);
    expect(d.msRemaining).toBeGreaterThan(0);
    expect(acceptsVotes(d.status)).toBe(true);
  });

  test("one objection inside the window makes it contested, not rejected", () => {
    const d = deriveStatus({ decidesAt: future(), settledAt: null, ballots: [reject] });
    expect(d.status).toBe("contested");
    expect(d.live).toBe(true);
    expect(acceptsVotes(d.status)).toBe(true);
  });

  test("a closed window with no votes approves — the whole optimistic promise", () => {
    const d = deriveStatus({ decidesAt: past(), settledAt: null, ballots: [] });
    expect(d.status).toBe("approved");
    expect(d.live).toBe(false);
    expect(d.msRemaining).toBe(0);
    expect(mayRelease(d.status)).toBe(true);
  });

  test("a closed, contested window approves only if approvals strictly win", () => {
    const win = deriveStatus({ decidesAt: past(), settledAt: null, ballots: [approve, approve, reject] });
    expect(win.status).toBe("approved");

    const tie = deriveStatus({ decidesAt: past(), settledAt: null, ballots: [approve, reject] });
    expect(tie.status, "an exact tie is a live dispute, not an approval").toBe("rejected");

    const lose = deriveStatus({ decidesAt: past(), settledAt: null, ballots: [approve, reject, reject] });
    expect(lose.status).toBe("rejected");
    expect(mayRelease(lose.status)).toBe(false);
  });

  test("a recorded settlement outranks the clock and the votes", () => {
    // Even with objections that would otherwise reject it, a settled row is settled.
    const d = deriveStatus({ decidesAt: past(), settledAt: new Date(), ballots: [reject, reject] });
    expect(d.status).toBe("settled");
    expect(d.live).toBe(false);
    expect(acceptsVotes(d.status)).toBe(false);
    expect(mayRelease(d.status)).toBe(false);
  });
});

test.describe("weighing a vote", () => {
  test("a barred human weighs nothing; a fresh human weighs a whole vote", () => {
    expect(voteWeightBps(PARITY_BPS, true)).toBe(0n);
    expect(voteWeightBps(0n, true)).toBe(0n);
    expect(voteWeightBps(PARITY_BPS, false)).toBe(PARITY_BPS);
  });

  test("penalised-but-not-barred is floored at parity, and standing above it counts in full", () => {
    // Conduct short of a bar reduces the bonus, never the franchise.
    expect(voteWeightBps(1n, false)).toBe(PARITY_BPS);
    expect(voteWeightBps(PARITY_BPS - 1n, false)).toBe(PARITY_BPS);
    expect(voteWeightBps(PARITY_BPS * 3n, false)).toBe(PARITY_BPS * 3n);
  });

  test("the tally sums weight and flips to contested on the first objection", () => {
    const t = tally([
      { choice: "approve", weightBps: PARITY_BPS },
      { choice: "reject", weightBps: PARITY_BPS * 2n },
    ]);
    expect(t.approveBps).toBe(PARITY_BPS);
    expect(t.rejectBps).toBe(PARITY_BPS * 2n);
    expect(t.approvals).toBe(1);
    expect(t.rejections).toBe(1);
    expect(t.contested).toBe(true);
    expect(t.approvesOnVotes).toBe(false);
  });
});

test.describe("the optimistic window", () => {
  test("with no override it is the production window and says so", () => {
    const w = optimisticWindow({} as NodeJS.ProcessEnv);
    expect(w.ms).toBe(DEFAULT_WINDOW_MS);
    expect(w.demo).toBe(false);
    expect(w.label).toContain("object");
  });

  test("a demo override is honoured, floored, and labelled as not production", () => {
    const w = optimisticWindow({ WELL_DEMO_WINDOW: "10" } as unknown as NodeJS.ProcessEnv);
    expect(w.ms).toBe(10_000);
    expect(w.demo).toBe(true);
    expect(w.label).toContain("not the production window");

    // A zero or negative or unparseable override must never make approval instant.
    expect(optimisticWindow({ WELL_DEMO_WINDOW: "0" } as unknown as NodeJS.ProcessEnv).demo).toBe(false);
    expect(optimisticWindow({ WELL_DEMO_WINDOW: "-5" } as unknown as NodeJS.ProcessEnv).demo).toBe(false);
    expect(optimisticWindow({ WELL_DEMO_WINDOW: "soon" } as unknown as NodeJS.ProcessEnv).demo).toBe(false);
    // A tiny positive override is clamped up to the floor, not taken literally.
    expect(optimisticWindow({ WELL_DEMO_WINDOW: "0.1" } as unknown as NodeJS.ProcessEnv).ms).toBe(MIN_WINDOW_MS);
  });

  test("the deadline is computed once from the submission time", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    expect(decidesAt(at, DEFAULT_WINDOW_MS).getTime()).toBe(at.getTime() + DEFAULT_WINDOW_MS);
  });
});

// ------------------------------------------------------- posting requires a key

test.describe("posting a submission", () => {
  test("with no agent key it is refused as unauthorized, before the body is read", async () => {
    const res = await postSubmission(jsonReq("https://x.test/api/submissions", { garbage: true }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("a live key with a malformed body is a 400, not a 500", async () => {
    const { agentId } = await makeAgent();
    const { token } = await issueAgentKey(agentId, "primary");
    const res = await postSubmission(jsonReq("https://x.test/api/submissions", {}, { token }));
    expect(res.status).toBe(400);
  });

  test("a key cannot post under another agent's name", async () => {
    const { agentId } = await makeAgent();
    const { token } = await issueAgentKey(agentId, "primary");
    // A fully valid body, but naming an agent this key does not belong to. The
    // check runs before any chain read, so it is a clean 403.
    const res = await postSubmission(
      jsonReq(
        "https://x.test/api/submissions",
        {
          kind: "resource-request",
          agentId: "some-other-agent",
          wish: anAddress(),
          resourceKind: "toolbelt",
          resourceId: "postgres-read",
          title: "give me postgres",
          body: "I need read access to the shared postgres to answer this wish.",
        },
        { token },
      ),
    );
    expect(res.status).toBe(403);
  });

  test("a resource request is created, opens for votes, and comes back stripped of secrets", async () => {
    const { agentId, wallet } = await makeAgent();
    const { token } = await issueAgentKey(agentId, "primary");
    const wish = anAddress();
    const res = await postSubmission(
      jsonReq(
        "https://x.test/api/submissions",
        {
          kind: "resource-request",
          agentId,
          wish,
          resourceKind: "capital",
          amountWei: "1000000000000000000",
          title: "a slice of the principal",
          body: "I can solve this wish but I need a slice of the principal to pay for inference.",
        },
        { token },
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: boolean;
      window: { demo: boolean };
      submission: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    submissionIds.push(body.submission.id as string);

    expect(body.submission.kind).toBe("resource-request");
    expect(body.submission.status).toBe("open");
    expect(body.submission.resourceKind).toBe("capital");
    // The agent in the row is the credential's, and the wish is lowercased once.
    expect(body.submission.agentId).toBe(agentId);
    expect(body.submission.agentWallet).toBe(wallet);
    expect(body.submission.wish).toBe(wish.toLowerCase());
    // Nothing that could authenticate leaks back.
    expect(JSON.stringify(body.submission)).not.toContain(token);
  });
});

// ------------------------------------------------------------ reading them back

test.describe("reading submissions", () => {
  test("the list is public and includes a created request", async () => {
    const { agentId, wallet } = await makeAgent();
    const row = await makeSubmission({ agentId, agentWallet: wallet, kind: "resource-request", railAddress: null, bountyId: null, resultHash: null });

    const res = await listSubmissions(new Request("https://x.test/api/submissions?kind=resource-request"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; submissions: { id: string }[] };
    expect(body.ok).toBe(true);
    expect(body.submissions.some((s) => s.id === row.id)).toBe(true);
  });

  test("an unknown id is a 404; a known one comes back", async () => {
    const { agentId, wallet } = await makeAgent();
    const row = await makeSubmission({ agentId, agentWallet: wallet });

    const missing = await getSubmission(new Request("https://x.test"), { params: { id: "no-such-id" } });
    expect(missing.status).toBe(404);

    const found = await getSubmission(new Request("https://x.test"), { params: { id: row.id } });
    expect(found.status).toBe(200);
    const body = (await found.json()) as { submission: { id: string } };
    expect(body.submission.id).toBe(row.id);
  });
});

// ------------------------------------------------------------------- voting gates

test.describe("voting closes with the window", () => {
  test("a vote on an unknown submission is a 404", async () => {
    const res = await voteOnSubmission(
      jsonReq("https://x.test", { nonce: "a".repeat(16), signature: "0xabcdef", choice: "approve" }),
      { params: { id: "no-such-id" } },
    );
    expect(res.status).toBe(404);
  });

  test("a vote after the window has closed is refused before the signature is spent", async () => {
    const { agentId, wallet } = await makeAgent();
    const row = await makeSubmission({ agentId, agentWallet: wallet, decidesAt: new Date(Date.now() - 1000) });
    // Dummy but schema-valid credentials: the window check runs before the
    // challenge is consumed, so these are never actually verified.
    const res = await voteOnSubmission(
      jsonReq("https://x.test", { nonce: "a".repeat(16), signature: "0xabcdef", choice: "approve" }),
      { params: { id: row.id } },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("window has closed");
  });

  test("a challenge minted for another submission cannot be replayed onto this one", async () => {
    const { agentId, wallet } = await makeAgent();
    const row = await makeSubmission({ agentId, agentWallet: wallet, decidesAt: new Date(Date.now() + 60_000) });

    const account = newSigner();
    // A genuine, correctly signed vote challenge — but for a different subject.
    const { nonce, message } = await mintChallenge({
      wallet: account.address,
      purpose: "vote",
      subject: "a-different-submission",
    });
    const signature = await account.signMessage({ message });

    const res = await voteOnSubmission(
      jsonReq("https://x.test", { nonce, signature, choice: "approve" }),
      { params: { id: row.id } },
    );
    // The subject mismatch is caught after the challenge is consumed but before any
    // chain read, so the reply is a clean 400 and no standing was ever queried.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("different submission");
  });
});

// ---------------------------------------------------------------- settling gates

test.describe("settling only an approved solution", () => {
  test("a resource request has no bounty to release", async () => {
    const { agentId, wallet } = await makeAgent();
    const row = await makeSubmission({ agentId, agentWallet: wallet, kind: "resource-request", railAddress: null, bountyId: null, resultHash: null });
    const res = await settleSubmission(new Request("https://x.test", { method: "POST" }), { params: { id: row.id } });
    expect(res.status).toBe(400);
  });

  test("an already-settled solution returns finished, and never re-sends", async () => {
    const { agentId, wallet } = await makeAgent();
    const row = await makeSubmission({ agentId, agentWallet: wallet, settledAt: new Date() });
    const res = await settleSubmission(new Request("https://x.test", { method: "POST" }), { params: { id: row.id } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alreadySettled: boolean };
    expect(body.alreadySettled).toBe(true);
  });

  test("a solution missing the rail it would settle on is a 422", async () => {
    const { agentId, wallet } = await makeAgent();
    const row = await makeSubmission({ agentId, agentWallet: wallet, railAddress: null });
    const res = await settleSubmission(new Request("https://x.test", { method: "POST" }), { params: { id: row.id } });
    expect(res.status).toBe(422);
  });

  test("an open solution cannot be released — only an approved one can", async () => {
    const { agentId, wallet } = await makeAgent();
    // All fields present and a future deadline: status is open, so the release is
    // refused at the mayRelease gate, before settlement is ever configured or called.
    const row = await makeSubmission({ agentId, agentWallet: wallet, decidesAt: new Date(Date.now() + 60 * 60 * 1000) });
    const res = await settleSubmission(new Request("https://x.test", { method: "POST" }), { params: { id: row.id } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("only an approved solution");
  });
});

// ----------------------------------------------------------------- reporting gate

test.describe("reporting only a rejected submission", () => {
  test("a report on an open submission is refused before a reviewer is even checked", async () => {
    const { agentId, wallet } = await makeAgent();
    const row = await makeSubmission({ agentId, agentWallet: wallet, decidesAt: new Date(Date.now() + 60 * 60 * 1000) });
    // Schema-valid dummy credentials: the status gate runs before the reviewer key
    // is read and before the challenge is consumed, so nothing on chain is touched.
    const res = await reportSubmission(
      jsonReq("https://x.test", {
        nonce: "a".repeat(16),
        signature: "0xabcdef",
        category: 5,
        severity: 2,
        reason: "this is a schema-valid reason of at least ten characters",
      }),
      { params: { id: row.id } },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("only a rejected submission");
  });
});

// ------------------------------------------------------------- the public shape

test.describe("the public shape of a submission", () => {
  test("a vote's signature is never in the rendered submission", async () => {
    const { agentId, wallet } = await makeAgent();
    const row = await makeSubmission({ agentId, agentWallet: wallet, decidesAt: new Date(Date.now() + 60_000) });
    const secretSignature = `0x${"de".repeat(32)}`;
    await prisma.submissionVote.create({
      data: {
        submissionId: row.id,
        humanId: aBytes32(),
        voter: anAddress().toLowerCase(),
        choice: "reject",
        weightBps: PARITY_BPS.toString(),
        assurance: 2,
        readAtBlock: "123",
        reason: "the milestone hash does not match the delivered work",
        signature: secretSignature,
      },
    });

    const fresh = await prisma.submission.findUnique({
      where: { id: row.id },
      include: { votes: { orderBy: { createdAt: "asc" } } },
    });
    const pub = toPublicSubmission(fresh!);

    expect(pub.status).toBe("contested");
    expect(pub.votes).toHaveLength(1);
    expect(pub.votes[0].choice).toBe("reject");
    expect(pub.votes[0].reason).toContain("does not match");
    // The signature proved the vote at write time; it has no business being read back.
    expect(JSON.stringify(pub)).not.toContain(secretSignature);
    expect(pub.votes[0]).not.toHaveProperty("signature");
  });
});
