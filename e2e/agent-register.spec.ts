/**
 * Registration, key issuance and World verification, exercised through the
 * handlers themselves.
 *
 * These are the routes, not a reimplementation of them: each `POST`/`GET` is
 * imported and handed a real `Request`. That is only possible because none of
 * them import `next/server` — Playwright's ESM loader cannot resolve its export
 * map — so they return plain `Response` objects, which the App Router accepts and
 * slice A's `unauthorized()` already does. No browser and no dev server: the one
 * on `:3100` belongs to another worktree and must not be touched.
 *
 * What is asserted, and why each is worth a test rather than a comment:
 *
 *   **Registration issues no key.** This is the property that stops the register
 *   endpoint being replayable into a credential factory, and it is the one a
 *   well-meaning refactor is most likely to "fix" by returning a token for
 *   convenience.
 *
 *   **A signature is bound to the wallet, the purpose and the subject.** Three
 *   separate tests, because the three bindings fail independently: without the
 *   first, anyone registers a stranger's address; without the second, a signature
 *   collected to register mints a key; without the third, a signature collected
 *   for one agent spends on another.
 *
 *   **The refusals do not distinguish.** Two pairs are compared byte for byte —
 *   revoking a key that does not exist against revoking one that is not yours, and
 *   every flavour of bad credential at `/api/agents/me`. An oracle here is not a
 *   leak of a secret; it is a list of live key ids, and a key id is all it takes
 *   to hold an honest agent's credential in a lockout indefinitely.
 *
 *   **"Not configured" never renders as "no human".** The bug this whole path is
 *   built around is AgentKit's `lookupHuman` returning `null` for both, which
 *   would tell a person they are not a person because a server was busy.
 *
 * No test here can send a transaction: every verification case returns before
 * `attestHuman` is reached, and the one that reaches the World lookup is skipped
 * when this deployment is actually pointed at World.
 */
import { expect, test } from "@playwright/test";
import crypto from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Set before anything reads it: `pepper()` looks at `process.env` per call, and
// issuing routes refuse outright without one.
process.env.WELL_AGENT_KEY_PEPPER ??= "test-pepper-not-a-real-one";

import { POST as challengePOST } from "../src/app/api/agents/challenge/route";
import { POST as registerPOST } from "../src/app/api/agents/register/route";
import { POST as keysPOST } from "../src/app/api/agents/keys/route";
import { POST as revokePOST } from "../src/app/api/agents/keys/revoke/route";
import { GET as meGET } from "../src/app/api/agents/me/route";
import { POST as verifyPOST } from "../src/app/api/agents/verify/route";
import { AgentRoster, type RosterAgent } from "../src/app/agents/register/AgentRoster";
import { AGENT_KEY_RE, parseAgentKey } from "../src/core/agents/agentKey";
import { authenticateAgent } from "../src/lib/agentAuth";
import { worldConfigured } from "../src/lib/worldVerify";
import { prisma } from "../src/lib/db";

type Account = ReturnType<typeof privateKeyToAccount>;

/** Every wallet this file signs with, so cleanup cannot over-reach. */
const signers: string[] = [];

function newSigner(): Account {
  const account = privateKeyToAccount(generatePrivateKey());
  signers.push(account.address.toLowerCase());
  return account;
}

/**
 * A fresh caller address per request.
 *
 * The burst budgets are keyed on `clientIp`, which falls back to the literal
 * `"unknown"` with no proxy header — so without this, one test's refusals would
 * spend another's budget and an expected 401 would arrive as a 429 depending on
 * declaration order.
 */
const someCaller = () => `198.51.100.${crypto.randomBytes(4).toString("hex")}`;

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function post(
  handler: (req: Request) => Promise<Response>,
  body: unknown,
): Promise<Answer> {
  const res = await handler(
    new Request("https://votive.test/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": someCaller() },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(token: string | null): Promise<Answer> {
  const res = await meGET(
    new Request("https://votive.test/api/agents/me", {
      headers: {
        "cf-connecting-ip": someCaller(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Mint a challenge and sign the message the server chose. */
async function signed(
  account: Account,
  purpose: string,
  extra: Record<string, string> = {},
): Promise<{ nonce: string; signature: string; message: string }> {
  const c = await post(challengePOST, { wallet: account.address, purpose, ...extra });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  const message = c.body.message as string;
  return {
    nonce: c.body.nonce as string,
    signature: await account.signMessage({ message }),
    message,
  };
}

interface AgentShape {
  id: string;
  wallet: string;
  ownerWallet: string;
  displayName: string;
  keys: { keyId: string }[];
}

async function register(account: Account, displayName = "Cartographer"): Promise<Answer> {
  const { nonce, signature } = await signed(account, "register");
  return post(registerPOST, {
    nonce,
    signature,
    displayName,
    summary: "Reads the wish, plans the work, and posts a solution with evidence.",
  });
}

/** A registered agent plus one live key, which most tests start from. */
async function agentWithKey(): Promise<{ account: Account; agent: AgentShape; token: string }> {
  const account = newSigner();
  const reg = await register(account);
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const agent = reg.body.agent as AgentShape;

  const { nonce, signature } = await signed(account, "issue-key", { agentId: agent.id });
  const issued = await post(keysPOST, { nonce, signature, agentId: agent.id, label: "test" });
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  return { account, agent, token: issued.body.token as string };
}

test.afterAll(async () => {
  // The database is shared with the rest of this repo's work. Delete only what
  // this file created, keyed on the wallets it signed with. `AgentKey` rows go
  // with their agent (`onDelete: Cascade`).
  await prisma.agentVerification.deleteMany({ where: { wallet: { in: signers } } });
  await prisma.agent.deleteMany({ where: { wallet: { in: signers } } });
  await prisma.$disconnect();
});

// ------------------------------------------------------------------ challenges

test.describe("the challenge", () => {
  test("the words are ours, and they name the wallet, the purpose and a fresh nonce", async () => {
    const account = newSigner();
    const a = await post(challengePOST, { wallet: account.address, purpose: "register" });
    const b = await post(challengePOST, { wallet: account.address, purpose: "register" });

    const message = a.body.message as string;
    expect(message).toContain("Votive");
    expect(message).toContain(`Wallet: ${account.address.toLowerCase()}`);
    expect(message).toContain("Purpose: register");
    expect(message).toContain(`Nonce: ${a.body.nonce as string}`);
    // The client never contributes the text, so nothing it sends can appear in it.
    expect(a.body.nonce).not.toBe(b.body.nonce);
  });

  test("an agent-scoped purpose has to name an agent that exists", async () => {
    const account = newSigner();

    const missing = await post(challengePOST, {
      wallet: account.address,
      purpose: "issue-key",
    });
    expect(missing.status).toBe(400);

    const unknown = await post(challengePOST, {
      wallet: account.address,
      purpose: "issue-key",
      agentId: "cl000000000000000000000",
    });
    expect(unknown.status).toBe(404);
  });

  test("the subject is derived from the target, never taken from the request", async () => {
    const account = newSigner();
    const reg = await register(account);
    const agent = reg.body.agent as AgentShape;

    const c = await post(challengePOST, {
      wallet: account.address,
      purpose: "issue-key",
      agentId: agent.id,
      // A caller trying to make the message say something other than the truth.
      subject: "a-different-agent-entirely",
    });
    expect(c.status).toBe(200);
    expect(c.body.message as string).toContain(`Subject: ${agent.id}`);
    expect(c.body.message as string).not.toContain("a-different-agent-entirely");
  });

  test("asking to revoke does not reveal whether the key exists", async () => {
    const { account, token } = await agentWithKey();
    const real = parseAgentKey(token)!.keyId;
    const fake = crypto.randomBytes(8).toString("hex");

    const a = await post(challengePOST, {
      wallet: account.address,
      purpose: "revoke-key",
      subject: real,
    });
    const b = await post(challengePOST, {
      wallet: account.address,
      purpose: "revoke-key",
      subject: fake,
    });

    expect(a.status).toBe(b.status);
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
    // Identical but for the values that are supposed to differ.
    const strip = (m: string, id: string) =>
      m.replace(/Nonce: .*/, "").replace(/Issued: .*/, "").replace(/Expires: .*/, "").replace(id, "");
    expect(strip(a.body.message as string, real)).toBe(strip(b.body.message as string, fake));
  });
});

// ----------------------------------------------------------------- registering

test.describe("registering", () => {
  test("the record is bound to the wallet that signed", async () => {
    const account = newSigner();
    const res = await register(account, "Surveyor");

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    const agent = res.body.agent as AgentShape;
    expect(agent.wallet).toBe(account.address.toLowerCase());
    expect(agent.ownerWallet).toBe(account.address.toLowerCase());
    expect(agent.displayName).toBe("Surveyor");
  });

  test("registering issues no key", async () => {
    const account = newSigner();
    const res = await register(account);
    const agent = res.body.agent as AgentShape;

    expect(agent.keys).toEqual([]);
    // Not just absent from the response — absent from the database. A key that
    // existed but was withheld would still be a credential nobody asked for.
    expect(await prisma.agentKey.count({ where: { agentId: agent.id } })).toBe(0);
  });

  test("registering again returns the record, changes nothing, and still mints nothing", async () => {
    const account = newSigner();
    const first = await register(account, "First name");
    const agent = first.body.agent as AgentShape;

    const second = await register(account, "Attempted rename");
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    const back = second.body.agent as AgentShape;

    expect(back.id).toBe(agent.id);
    expect(back.displayName).toBe("First name");
    expect(await prisma.agentKey.count({ where: { agentId: agent.id } })).toBe(0);
  });

  test("a signature from another wallet is refused", async () => {
    const owner = newSigner();
    const impostor = newSigner();

    // The challenge names `owner`; `impostor` signs those exact words.
    const c = await post(challengePOST, { wallet: owner.address, purpose: "register" });
    const signature = await impostor.signMessage({ message: c.body.message as string });

    const res = await post(registerPOST, {
      nonce: c.body.nonce,
      signature,
      displayName: "Stolen",
      summary: "Registering an address I do not control.",
    });
    expect(res.status).toBe(401);
    expect(await prisma.agent.findUnique({ where: { wallet: owner.address.toLowerCase() } })).toBeNull();
  });

  test("a nonce cannot be presented twice", async () => {
    const account = newSigner();
    const { nonce, signature } = await signed(account, "register");
    const body = {
      nonce,
      signature,
      displayName: "Once only",
      summary: "A challenge is spent on presentation, not on success.",
    };

    expect((await post(registerPOST, body)).status).toBe(201);
    const replay = await post(registerPOST, body);
    expect(replay.status).toBe(400);
    expect(replay.body.error as string).toContain("already been presented");
  });

  test("a challenge minted for one purpose cannot be spent on another", async () => {
    const account = newSigner();
    const reg = await register(account);
    const agent = reg.body.agent as AgentShape;

    // Signed to issue a key; presented to register.
    const { nonce, signature } = await signed(account, "issue-key", { agentId: agent.id });
    const res = await post(registerPOST, {
      nonce,
      signature,
      displayName: "Wrong purpose",
      summary: "This signature authorises something else entirely.",
    });
    expect(res.status).toBe(400);
    expect(res.body.error as string).toContain("authorises something else");
  });
});

// ------------------------------------------------------------------ issuing a key

test.describe("issuing a key", () => {
  test("the token authenticates, and nothing stored can reproduce it", async () => {
    const { agent, token } = await agentWithKey();

    expect(token).toMatch(AGENT_KEY_RE);

    const auth = await authenticateAgent(
      new Request("https://votive.test/api/submissions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": someCaller() },
      }),
    );
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.agent.agentId).toBe(agent.id);

    // The secret is not in any column, under any encoding. `keyHash` is an HMAC
    // of it, which is the point: a database dump cannot be turned back into a key.
    const secret = parseAgentKey(token)!.secret;
    const row = (await prisma.agentKey.findUnique({ where: { keyId: parseAgentKey(token)!.keyId } }))!;
    for (const stored of [row.keyHash, row.salt, row.label]) {
      expect(stored).not.toBe(secret);
      expect(stored).not.toBe(token);
      expect(stored).not.toContain(secret);
    }
  });

  test("two keys for one agent are two different secrets", async () => {
    const { account, agent, token } = await agentWithKey();

    const { nonce, signature } = await signed(account, "issue-key", { agentId: agent.id });
    const second = await post(keysPOST, { nonce, signature, agentId: agent.id, label: "second" });
    expect(second.status).toBe(201);

    // Rotation has to overlap, so both must work at once.
    expect(second.body.token).not.toBe(token);
    expect(second.body.keyId).not.toBe(parseAgentKey(token)!.keyId);
    expect((await get(token)).status).toBe(200);
    expect((await get(second.body.token as string)).status).toBe(200);
  });

  test("a challenge for one agent cannot issue a key for another", async () => {
    const account = newSigner();
    const mine = (await register(account)).body.agent as AgentShape;
    const other = (await register(newSigner())).body.agent as AgentShape;

    // Signed naming `mine`; presented naming `other`.
    const { nonce, signature } = await signed(account, "issue-key", { agentId: mine.id });
    const res = await post(keysPOST, { nonce, signature, agentId: other.id, label: "theirs" });

    expect(res.status).toBe(400);
    expect(await prisma.agentKey.count({ where: { agentId: other.id } })).toBe(0);
  });

  test("a wallet that does not administer the agent cannot issue for it", async () => {
    const outsider = newSigner();
    const agent = (await register(newSigner())).body.agent as AgentShape;

    const { nonce, signature } = await signed(outsider, "issue-key", { agentId: agent.id });
    const res = await post(keysPOST, { nonce, signature, agentId: agent.id, label: "not mine" });

    expect(res.status).toBe(403);
    expect(await prisma.agentKey.count({ where: { agentId: agent.id } })).toBe(0);
  });

  test("live keys are capped, so a leak has a bounded blast radius", async () => {
    const account = newSigner();
    const agent = (await register(account)).body.agent as AgentShape;

    let issued = 0;
    let refusal: Answer | null = null;
    for (let i = 0; i < 8; i += 1) {
      const { nonce, signature } = await signed(account, "issue-key", { agentId: agent.id });
      const res = await post(keysPOST, { nonce, signature, agentId: agent.id, label: `k${i}` });
      if (res.status === 201) {
        issued += 1;
        continue;
      }
      refusal = res;
      break;
    }

    expect(issued).toBeGreaterThan(1); // rotation must be able to overlap
    expect(refusal).not.toBeNull();
    expect(refusal!.status).toBe(409);
    expect(refusal!.body.error as string).toContain("revoke one first");
    expect(await prisma.agentKey.count({ where: { agentId: agent.id, revokedAt: null } })).toBe(issued);
  });
});

// ------------------------------------------------------------------- revoking

test.describe("revoking", () => {
  test("a key can destroy itself, with no wallet involved", async () => {
    const { token } = await agentWithKey();
    expect((await get(token)).status).toBe(200);

    const res = await post(revokePOST, { token });
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);

    expect((await get(token)).status).toBe(401);
  });

  test("the owner can revoke by signature, without holding the key", async () => {
    const { account, token } = await agentWithKey();
    const keyId = parseAgentKey(token)!.keyId;

    const { nonce, signature } = await signed(account, "revoke-key", { subject: keyId });
    const res = await post(revokePOST, { keyId, nonce, signature });

    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
    expect((await get(token)).status).toBe(401);
  });

  test("someone else's key and a key that never existed answer identically", async () => {
    const outsider = newSigner();
    const { token } = await agentWithKey();
    const realButNotTheirs = parseAgentKey(token)!.keyId;
    const neverExisted = crypto.randomBytes(8).toString("hex");

    const a = await post(revokePOST, {
      keyId: realButNotTheirs,
      ...(await signed(outsider, "revoke-key", { subject: realButNotTheirs })),
    });
    const b = await post(revokePOST, {
      keyId: neverExisted,
      ...(await signed(outsider, "revoke-key", { subject: neverExisted })),
    });

    expect(a.status).toBe(b.status);
    // Byte for byte: any difference at all is a way to enumerate live key ids.
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
    // And the real key is untouched by the attempt.
    expect((await get(token)).status).toBe(200);
  });

  test("a stolen secret can destroy but can never mint", async () => {
    const { agent, token } = await agentWithKey();

    // There is no issuing path that accepts a token in place of a signature, so a
    // thief cannot rotate the credential out from under its owner.
    const res = await post(keysPOST, { token, agentId: agent.id, label: "minted by a thief" });
    expect(res.status).toBe(400);
    expect(await prisma.agentKey.count({ where: { agentId: agent.id } })).toBe(1);
  });
});

// ------------------------------------------------------------------------- me

test.describe("identifying yourself", () => {
  test("a live key gets the agent and the keys beside it", async () => {
    const { agent, token } = await agentWithKey();
    const res = await get(token);

    expect(res.status).toBe(200);
    const back = res.body.agent as AgentShape;
    expect(back.id).toBe(agent.id);
    expect(back.keys.map((k) => k.keyId)).toContain(parseAgentKey(token)!.keyId);
    expect(res.body.authenticatedWith).toBe(parseAgentKey(token)!.keyId);
    // Whatever else is in the body, the secret is not.
    expect(JSON.stringify(res.body)).not.toContain(parseAgentKey(token)!.secret);
  });

  test("unknown, malformed, wrong and revoked keys are one indistinguishable refusal", async () => {
    const { token } = await agentWithKey();
    const parsed = parseAgentKey(token)!;

    const revoked = (await agentWithKey()).token;
    await post(revokePOST, { token: revoked });

    const answers = await Promise.all([
      get(null),
      get("not-a-key-at-all"),
      // A well-formed token for a key id that names no row.
      get(`vsk_${crypto.randomBytes(8).toString("hex")}_${parsed.secret}`),
      // The right key id with the wrong secret.
      get(`vsk_${parsed.keyId}_${Buffer.from(crypto.randomBytes(32)).toString("base64url")}`),
      get(revoked),
    ]);

    for (const a of answers) {
      expect(a.status).toBe(401);
      expect(JSON.stringify(a.body)).toBe(JSON.stringify({ error: "unauthorized" }));
    }
  });
});

// ------------------------------------------------------------ World verification

// -------------------------------------------------------------- the roster

/**
 * Walk the element tree the component returned.
 *
 * `AgentRoster` is an async function returning JSX, so it can be called directly
 * and its output inspected without a renderer or a browser. Nested components
 * (`HumanBadge`, `ReadFailure`) are left as unexpanded elements, which is why
 * `testId` is collected alongside `data-testid` — `ReadFailure` takes its as a
 * prop.
 */
function walk(node: unknown, ids: string[], text: string[]): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const n of node) walk(n, ids, text);
    return;
  }
  if (typeof node !== "object") return;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (!props) return;
  for (const key of ["data-testid", "testId"]) {
    const v = props[key];
    if (typeof v === "string") ids.push(v);
  }
  // `ReadFailure`'s reason travels as a prop, not as a child.
  for (const key of ["what", "because"]) {
    const v = props[key];
    if (typeof v === "string") text.push(v);
  }
  walk(props.children, ids, text);
}

async function renderRoster(agents: RosterAgent[]) {
  const ids: string[] = [];
  const text: string[] = [];
  walk(await AgentRoster({ agents }), ids, text);
  return { ids, text: text.join(" ") };
}

const rosterRow = (wallet: string): RosterAgent => ({
  id: `row-${wallet}`,
  wallet,
  ownerWallet: wallet,
  displayName: "Cartographer",
  summary: "A row for the register.",
  status: "active",
  createdAt: new Date().toISOString(),
  liveKeys: 1,
});

test.describe("the register table", () => {
  test("a wallet nobody has attested reads cleanly, and says so", async () => {
    // A real read against a real registry that genuinely holds nothing for this
    // address. "No human bound" here is a fact, and has to be distinguishable
    // from the case below.
    const { ids, text } = await renderRoster([rosterRow(privateKeyToAccount(generatePrivateKey()).address.toLowerCase())]);

    expect(text).toContain("no human bound");
    expect(ids).not.toContain("roster-backing-unknown");
    expect(ids).not.toContain("roster-read-failure");
  });

  test('a read that failed is never drawn as "no human bound"', async () => {
    // Forced through the same branch an RPC outage takes: `humanBacking` returns
    // `{ok:false}` and the row has nothing true to say about this wallet.
    const { ids, text } = await renderRoster([rosterRow("not-a-wallet-address")]);

    expect(ids).toContain("roster-backing-unknown");
    // The whole point. A table of "no human bound" that is really a table of "we
    // did not ask" is the exact failure this repo has shipped before.
    expect(text).not.toContain("no human bound");
    // And when every row failed, it is said once, loudly, at the top.
    expect(ids).toContain("roster-read-failure");
    expect(text).toContain("could not read human backing");
  });

  test("an empty register is reported as empty, not as unread", async () => {
    const { ids } = await renderRoster([]);
    expect(ids).toContain("roster-empty");
    expect(ids).not.toContain("roster-read-failure");
  });
});

test.describe("World verification", () => {
  test("it takes the agent's own wallet, not an administrator's", async () => {
    const outsider = newSigner();
    const agent = (await register(newSigner())).body.agent as AgentShape;

    const { nonce, signature } = await signed(outsider, "verify-world", { agentId: agent.id });
    const res = await post(verifyPOST, { nonce, signature, agentId: agent.id });

    // Refused before any World lookup and before any transaction is considered:
    // the binding is sticky, and the registry will not rebind without a revocation.
    expect(res.status).toBe(403);
  });

  test("a challenge for one agent cannot verify another", async () => {
    const account = newSigner();
    const mine = (await register(account)).body.agent as AgentShape;
    const other = (await register(newSigner())).body.agent as AgentShape;

    const { nonce, signature } = await signed(account, "verify-world", { agentId: mine.id });
    const res = await post(verifyPOST, { nonce, signature, agentId: other.id });

    expect(res.status).toBe(400);
  });

  test('an unconfigured deployment says so, and never says "no human"', async () => {
    test.skip(
      worldConfigured(),
      "this deployment is pointed at World; this test asserts the unconfigured path",
    );

    const account = newSigner();
    const agent = (await register(account)).body.agent as AgentShape;
    const { nonce, signature } = await signed(account, "verify-world", { agentId: agent.id });
    const res = await post(verifyPOST, { nonce, signature, agentId: agent.id });

    expect(res.status).toBe(503);
    expect(res.body.state).toBe("not-configured");
    // The whole point. AgentKit's lookup returns `null` for "nobody" and for "we
    // could not ask", and collapsing the second into the first tells a person
    // they do not exist because a server was busy.
    expect(res.body.state).not.toBe("no-human");
    expect(res.body.because as string).toContain("WELL_WORLD_ENABLED");

    // What actually happened is on the record, whatever the caller was told.
    const row = await prisma.agentVerification.findUnique({ where: { nonce } });
    expect(row?.outcome).toBe("unreachable");
    expect(row?.attestTx).toBeNull();
  });
});
