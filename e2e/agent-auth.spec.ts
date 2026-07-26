/**
 * The agent secret, tested as an attacker would probe it.
 *
 * These are unit tests wearing a Playwright harness. The repo has exactly two
 * test runners — `node --test` inside `sdk/`, which cannot see `src/`, and this
 * suite — and adding a third would mean editing `package.json`, which belongs to
 * another slice. So they live here, need no browser, and run with `npx playwright
 * test agent-auth`.
 *
 * What is asserted, and why each one is here rather than assumed:
 *
 *   A wrong secret is refused, including one that differs from the right one by a
 *   single character. Obvious, and the thing everything else is built on.
 *
 *   The stored value cannot be reversed, and — the part that is easy to lose in a
 *   refactor — cannot even be *checked* by someone holding the database but not
 *   the pepper. That is the whole reason the pepper exists.
 *
 *   The comparison does not short-circuit. This is pinned by spying on
 *   `crypto.timingSafeEqual` rather than by measuring a clock: the assertion is
 *   that the constant-time primitive is called, exactly once, over two full-width
 *   digests, and that the raw secret is never what gets compared. A timing
 *   measurement would be the weaker test — the HMAC dominates the wall clock, so
 *   a `===` regression would hide inside the noise — and a flaky security test
 *   gets deleted.
 *
 *   The rate limiter limits, and specifically that it still limits when
 *   `WELL_RATELIMIT_DISABLED=1`, which is set in this deployment's `.env.local`.
 *   A brute-force guard an operator can switch off with an environment variable
 *   is not a guard, and that is exactly the trap `enforceRateLimit` sets.
 */
import { expect, test } from "@playwright/test";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Deterministic pepper for the run. Set before anything reads it — `pepper()`
// looks at `process.env` per call, so this is enough.
process.env.WELL_AGENT_KEY_PEPPER = "test-pepper-not-a-real-one";

import {
  AGENT_KEY_RE,
  agentKeyMatches,
  DIGEST_BYTES,
  generateAgentKey,
  hashAgentKey,
  parseAgentKey,
} from "../src/core/agents/agentKey";
import {
  ATTEMPT_LIMIT,
  BURST_WINDOW_MS,
  burstCheck,
  escalateFailure,
  FAILURE_LIMIT,
  isLocked,
  LOCKOUT_BASE_MS,
  LOCKOUT_MAX_DOUBLINGS,
  MAX_FAILED_ATTEMPTS,
} from "../src/lib/credentialLimit";
import {
  authenticateAgent,
  issueAgentKey,
  revokeAgentKey,
  revokeAgentKeyByToken,
} from "../src/lib/agentAuth";
import { humanIdToBytes32, isHumanBacked, ZERO_HUMAN_ID } from "../src/core/world/humanId";
import { challengeMessage, consumeChallenge, mintChallenge } from "../src/lib/challenge";
import { prisma } from "../src/lib/db";

const PEPPER = process.env.WELL_AGENT_KEY_PEPPER!;

/** Every row this file writes carries this marker so cleanup cannot over-reach. */
const MARKER = `0xtest${crypto.randomBytes(8).toString("hex")}`;
const wallets: string[] = [];

async function makeAgent(): Promise<string> {
  const wallet = `${MARKER}${crypto.randomBytes(4).toString("hex")}`.slice(0, 42);
  wallets.push(wallet);
  const agent = await prisma.agent.create({
    data: {
      wallet,
      ownerWallet: wallet,
      displayName: "test agent",
      summary: "created by e2e/agent-auth.spec.ts",
    },
  });
  return agent.id;
}

/**
 * A caller address, distinct per request unless a test pins one.
 *
 * The failure budget in `agentAuth` is keyed on the caller and `clientIp` reads
 * `cf-connecting-ip` first, so without this one test's refusals would spend
 * another's budget and turn an expected 401 into a 429 — a suite whose results
 * depend on declaration order. A test that wants to *exhaust* the budget passes a
 * fixed address instead.
 */
const someCaller = () => `203.0.113.${crypto.randomBytes(8).toString("hex")}`;

const req = (token: string | null, from: string = someCaller()): Request =>
  new Request("https://example.test/api/submissions", {
    method: "POST",
    headers: {
      "cf-connecting-ip": from,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

/** Challenge rows are keyed on a real signing wallet, not on the agent marker. */
const signers: string[] = [];

test.afterAll(async () => {
  // The database is shared with other work in this repo. Delete only what this
  // file created, keyed on the per-run marker and on the wallets it signed with.
  await prisma.agentVerification.deleteMany({ where: { wallet: { in: signers } } });
  await prisma.agent.deleteMany({ where: { wallet: { in: wallets } } });
  await prisma.$disconnect();
});

// ------------------------------------------------------------- key generation

test.describe("minting a key", () => {
  test("the token has the published shape and a 32-byte secret", () => {
    const k = generateAgentKey();
    expect(k.token).toMatch(AGENT_KEY_RE);
    expect(k.token).toBe(`vsk_${k.keyId}_${k.secret}`);
    expect(k.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(Buffer.from(k.secret, "base64url")).toHaveLength(32);
    expect(Buffer.from(k.salt, "base64")).toHaveLength(16);
  });

  test("secrets and salts never repeat", () => {
    const secrets = new Set<string>();
    const salts = new Set<string>();
    const ids = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const k = generateAgentKey();
      secrets.add(k.secret);
      salts.add(k.salt);
      ids.add(k.keyId);
    }
    expect(secrets.size).toBe(500);
    expect(salts.size).toBe(500);
    expect(ids.size).toBe(500);
  });

  test("a malformed token is rejected by parsing, not by an exception", () => {
    const good = generateAgentKey();
    expect(parseAgentKey(good.token)).toEqual({ keyId: good.keyId, secret: good.secret });

    for (const bad of [
      "",
      "vsk_",
      "not-a-key",
      `vsk_${good.keyId}`,
      `vsk_${good.keyId}_`,
      // one character short in the secret
      `vsk_${good.keyId}_${good.secret.slice(0, 42)}`,
      // one character long
      `vsk_${good.keyId}_${good.secret}A`,
      // uppercase key id — the id is defined as lowercase hex
      `vsk_${good.keyId.toUpperCase()}_${good.secret}`,
      // base64 rather than base64url: "+" and "/" are outside the alphabet
      `vsk_${good.keyId}_${"+".repeat(43)}`,
      `sk_${good.keyId}_${good.secret}`,
      `vsk_${good.keyId}_${good.secret} extra`,
    ]) {
      expect(parseAgentKey(bad), `should not parse: ${JSON.stringify(bad)}`).toBeNull();
    }
    expect(parseAgentKey(undefined as unknown as string)).toBeNull();
    expect(parseAgentKey(12345 as unknown as string)).toBeNull();
  });
});

// ------------------------------------------------------------- the comparison

test.describe("checking a secret", () => {
  test("the right secret verifies and a wrong one does not", () => {
    const k = generateAgentKey();
    const stored = hashAgentKey(k.secret, k.salt, PEPPER);

    expect(agentKeyMatches(stored, k.secret, k.salt, PEPPER)).toBe(true);
    expect(agentKeyMatches(stored, generateAgentKey().secret, k.salt, PEPPER)).toBe(false);
  });

  test("a secret differing by one character is refused", () => {
    const k = generateAgentKey();
    const stored = hashAgentKey(k.secret, k.salt, PEPPER);

    // Flip the last character, then the first. A comparison that matched on a
    // prefix, or that stopped early and returned true, would accept one of these.
    const flip = (c: string) => (c === "A" ? "B" : "A");
    const lastWrong = k.secret.slice(0, 42) + flip(k.secret[42]!);
    const firstWrong = flip(k.secret[0]!) + k.secret.slice(1);

    expect(lastWrong).not.toBe(k.secret);
    expect(firstWrong).not.toBe(k.secret);
    expect(agentKeyMatches(stored, lastWrong, k.salt, PEPPER)).toBe(false);
    expect(agentKeyMatches(stored, firstWrong, k.salt, PEPPER)).toBe(false);
  });

  test("a stored digest differing only in its final byte is refused", () => {
    const k = generateAgentKey();
    const digest = Buffer.from(hashAgentKey(k.secret, k.salt, PEPPER), "base64");

    const lastByteWrong = Buffer.from(digest);
    lastByteWrong[DIGEST_BYTES - 1] ^= 0xff;
    const firstByteWrong = Buffer.from(digest);
    firstByteWrong[0] ^= 0xff;

    // The last-byte case is the one a truncating or prefix-matching
    // implementation would wrongly accept.
    expect(agentKeyMatches(lastByteWrong.toString("base64"), k.secret, k.salt, PEPPER)).toBe(false);
    expect(agentKeyMatches(firstByteWrong.toString("base64"), k.secret, k.salt, PEPPER)).toBe(false);
  });

  test("the comparison is constant-time, over full digests, and never over the secret", () => {
    const k = generateAgentKey();
    const stored = hashAgentKey(k.secret, k.salt, PEPPER);

    // `agentKey.ts` calls `crypto.timingSafeEqual(...)` as a property lookup on
    // the shared module object, so replacing it here observes the real call.
    // This is the assertion that would fail if somebody "simplified" it to `===`.
    const real = crypto.timingSafeEqual;
    const calls: Buffer[][] = [];
    try {
      (crypto as { timingSafeEqual: unknown }).timingSafeEqual = (a: Buffer, b: Buffer) => {
        calls.push([Buffer.from(a), Buffer.from(b)]);
        return real(a, b);
      };
      expect(agentKeyMatches(stored, k.secret, k.salt, PEPPER)).toBe(true);
    } finally {
      (crypto as { timingSafeEqual: unknown }).timingSafeEqual = real;
    }

    expect(calls, "the constant-time primitive was not used").toHaveLength(1);
    const [a, b] = calls[0]!;
    // Full-width on both sides: no truncation, no prefix.
    expect(a).toHaveLength(DIGEST_BYTES);
    expect(b).toHaveLength(DIGEST_BYTES);
    // And what is compared is a digest, never the secret itself.
    const secretBytes = Buffer.from(k.secret, "utf8");
    expect(a.includes(secretBytes)).toBe(false);
    expect(b.includes(secretBytes)).toBe(false);
  });

  test("a wrong secret still reaches the constant-time comparison", () => {
    // Otherwise the fast path for a failure would be distinguishable from the
    // slow path for a success by anyone with a stopwatch.
    const k = generateAgentKey();
    const stored = hashAgentKey(k.secret, k.salt, PEPPER);

    const real = crypto.timingSafeEqual;
    let called = 0;
    try {
      (crypto as { timingSafeEqual: unknown }).timingSafeEqual = (a: Buffer, b: Buffer) => {
        called += 1;
        return real(a, b);
      };
      expect(agentKeyMatches(stored, generateAgentKey().secret, k.salt, PEPPER)).toBe(false);
      // A corrupt row must cost the same work rather than returning early.
      called = 0;
      expect(agentKeyMatches("not-base64-at-all", k.secret, k.salt, PEPPER)).toBe(false);
      expect(called, "a malformed stored digest took an early return").toBe(1);
    } finally {
      (crypto as { timingSafeEqual: unknown }).timingSafeEqual = real;
    }
  });

  test("malformed input is refused rather than thrown", () => {
    const k = generateAgentKey();
    for (const stored of ["", "!!!!", "AAAA", Buffer.alloc(31).toString("base64")]) {
      expect(() => agentKeyMatches(stored, k.secret, k.salt, PEPPER)).not.toThrow();
      expect(agentKeyMatches(stored, k.secret, k.salt, PEPPER)).toBe(false);
    }
    // A missing pepper must never silently produce a verifiable digest.
    expect(agentKeyMatches("AAAA", k.secret, k.salt, "")).toBe(false);
  });
});

// ------------------------------------------------------------ irreversibility

test.describe("what the database gives away", () => {
  test("the digest is a fixed-width one-way value, not the secret", () => {
    const k = generateAgentKey();
    const stored = hashAgentKey(k.secret, k.salt, PEPPER);
    const raw = Buffer.from(stored, "base64");

    expect(raw).toHaveLength(DIGEST_BYTES);
    expect(stored).not.toContain(k.secret);
    expect(stored).not.toContain(k.token);
    // Neither the base64 nor the underlying bytes carry the secret.
    expect(raw.includes(Buffer.from(k.secret, "utf8"))).toBe(false);
    expect(raw.includes(Buffer.from(k.secret, "base64url"))).toBe(false);
  });

  test("the same secret hashes differently under a different salt", () => {
    const k = generateAgentKey();
    const other = generateAgentKey();
    expect(hashAgentKey(k.secret, k.salt, PEPPER)).not.toBe(
      hashAgentKey(k.secret, other.salt, PEPPER),
    );
  });

  test("without the pepper, a stolen row cannot even confirm a correct guess", () => {
    // This is the property the pepper is for: an attacker with the whole table
    // and the right secret in hand still cannot tell that it is the right one.
    const k = generateAgentKey();
    const stored = hashAgentKey(k.secret, k.salt, PEPPER);

    expect(agentKeyMatches(stored, k.secret, k.salt, "wrong-pepper")).toBe(false);
    expect(hashAgentKey(k.secret, k.salt, "wrong-pepper")).not.toBe(stored);
  });

  test("hashing refuses to proceed with no pepper or a wrong-width salt", () => {
    const k = generateAgentKey();
    expect(() => hashAgentKey(k.secret, k.salt, "")).toThrow(/pepper/i);
    expect(() => hashAgentKey(k.secret, Buffer.alloc(8).toString("base64"), PEPPER)).toThrow(
      /salt/i,
    );
  });

  test("the module has not been refactored away from the constant-time primitive", () => {
    // A source assertion, deliberately. The spy above proves today's behaviour;
    // this makes a future `===` on digests fail here rather than in production.
    const src = readFileSync(
      new URL("../src/core/agents/agentKey.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("crypto.timingSafeEqual");
    expect(src).toContain('createHmac("sha256"');
  });
});

// ---------------------------------------------------------- the rate limiting

test.describe("rate limiting a credential", () => {
  const subject = () => crypto.randomBytes(8).toString("hex");
  /** Small and explicit, so the assertion is about the mechanism, not a constant. */
  const LIMIT = 5;

  test("it allows exactly the limit, then refuses with a retry-after", () => {
    const s = subject();
    for (let i = 0; i < LIMIT; i += 1) {
      expect(burstCheck("test", s, LIMIT).ok, `attempt ${i + 1} should be allowed`).toBe(true);
    }
    const refused = burstCheck("test", s, LIMIT);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfter).toBeGreaterThan(0);
    expect(refused.retryAfter).toBeLessThanOrEqual(BURST_WINDOW_MS / 1000);
  });

  test("WELL_RATELIMIT_DISABLED does not switch it off", () => {
    // `enforceRateLimit` returns null the moment it sees this, and it *is* set in
    // this deployment. Nothing on a credential path may honour it.
    const before = process.env.WELL_RATELIMIT_DISABLED;
    process.env.WELL_RATELIMIT_DISABLED = "1";
    try {
      const s = subject();
      for (let i = 0; i < LIMIT; i += 1) expect(burstCheck("test", s, LIMIT).ok).toBe(true);
      expect(burstCheck("test", s, LIMIT).ok, "the kill switch disabled the guard").toBe(false);
    } finally {
      if (before === undefined) delete process.env.WELL_RATELIMIT_DISABLED;
      else process.env.WELL_RATELIMIT_DISABLED = before;
    }
  });

  test("one exhausted subject does not limit another", () => {
    const a = subject();
    const b = subject();
    for (let i = 0; i < LIMIT + 5; i += 1) burstCheck("test", a, LIMIT);
    expect(burstCheck("test", a, LIMIT).ok).toBe(false);
    expect(burstCheck("test", b, LIMIT).ok).toBe(true);
  });

  test("scopes do not deplete each other", () => {
    const s = subject();
    for (let i = 0; i < LIMIT + 5; i += 1) burstCheck("verify", s, LIMIT);
    expect(burstCheck("verify", s, LIMIT).ok).toBe(false);
    expect(burstCheck("revoke", s, LIMIT).ok).toBe(true);
  });

  test("the window rolls", () => {
    const s = subject();
    const t0 = Date.now();
    for (let i = 0; i < LIMIT; i += 1) burstCheck("test", s, LIMIT, BURST_WINDOW_MS, t0);
    expect(burstCheck("test", s, LIMIT, BURST_WINDOW_MS, t0).ok).toBe(false);
    expect(burstCheck("test", s, LIMIT, BURST_WINDOW_MS, t0 + BURST_WINDOW_MS + 1).ok).toBe(true);
  });

  test("the failure budget is far tighter than the request budget", () => {
    // A working agent submitting and polling must not be throttled by a limit
    // sized to stop guessing, which is the whole reason there are two of them.
    expect(FAILURE_LIMIT).toBeLessThan(ATTEMPT_LIMIT);
    // And the durable lockout has to bite before the in-memory budget does, or a
    // restart would hand the attacker their allowance back.
    expect(MAX_FAILED_ATTEMPTS).toBeLessThanOrEqual(FAILURE_LIMIT);
  });
});

test.describe("lockout escalation", () => {
  test("it locks on the nth consecutive failure, not before", () => {
    let state = { failedAttempts: 0, lockouts: 0, lockedUntil: null as Date | null };
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i += 1) {
      state = escalateFailure(state);
      expect(state.lockedUntil, `locked early, after ${i}`).toBeNull();
      expect(state.failedAttempts).toBe(i);
    }
    state = escalateFailure(state);
    expect(state.lockedUntil).not.toBeNull();
    expect(state.lockouts).toBe(1);
    // The run counter resets: it measures since the last consequence.
    expect(state.failedAttempts).toBe(0);
  });

  test("each lockout is twice as long as the last, up to a ceiling", () => {
    const durationFor = (lockouts: number): number => {
      const now = new Date(0);
      const s = escalateFailure(
        { failedAttempts: MAX_FAILED_ATTEMPTS - 1, lockouts, lockedUntil: null },
        now,
      );
      return s.lockedUntil!.getTime() - now.getTime();
    };
    expect(durationFor(0)).toBe(LOCKOUT_BASE_MS);
    expect(durationFor(1)).toBe(LOCKOUT_BASE_MS * 2);
    expect(durationFor(2)).toBe(LOCKOUT_BASE_MS * 4);
    expect(durationFor(LOCKOUT_MAX_DOUBLINGS)).toBe(
      LOCKOUT_BASE_MS * 2 ** LOCKOUT_MAX_DOUBLINGS,
    );
    // Capped, so a long-lived key cannot be locked out for a geological age.
    expect(durationFor(LOCKOUT_MAX_DOUBLINGS + 10)).toBe(
      LOCKOUT_BASE_MS * 2 ** LOCKOUT_MAX_DOUBLINGS,
    );
  });

  test("a lock expires", () => {
    const now = new Date();
    expect(isLocked(null, now)).toBe(false);
    expect(isLocked(new Date(now.getTime() + 1000), now)).toBe(true);
    expect(isLocked(new Date(now.getTime() - 1), now)).toBe(false);
  });
});

// ----------------------------------------------------- the whole path, on a DB

test.describe("authenticating a request", () => {
  test("the issued token works and the database never holds it", async () => {
    const agentId = await makeAgent();
    const { keyId, token } = await issueAgentKey(agentId, "primary");

    const ok = await authenticateAgent(req(token));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.agent.agentId).toBe(agentId);
      expect(ok.agent.keyId).toBe(keyId);
    }

    const row = await prisma.agentKey.findUnique({ where: { keyId } });
    expect(row).not.toBeNull();
    const secret = parseAgentKey(token)!.secret;
    // Nothing persisted may reproduce the token.
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row!.hashVersion).toBe("hmac-sha256-v1");
    expect(row!.lastUsedAt).not.toBeNull();
  });

  test("a mutated token is refused", async () => {
    const agentId = await makeAgent();
    const { token } = await issueAgentKey(agentId, "primary");

    // One character of the secret changed — the demo's "watch it 401" step.
    const mutated = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const res = await authenticateAgent(req(mutated));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
      expect(await res.response.json()).toEqual({ error: "unauthorized" });
    }
  });

  test("an unknown key id is indistinguishable from a wrong secret", async () => {
    const agentId = await makeAgent();
    const { token } = await issueAgentKey(agentId, "primary");

    const wrongSecret = await authenticateAgent(
      req(`vsk_${parseAgentKey(token)!.keyId}_${generateAgentKey().secret}`),
    );
    const unknownId = await authenticateAgent(req(generateAgentKey().token));
    const noHeader = await authenticateAgent(req(null));

    expect(wrongSecret.ok).toBe(false);
    expect(unknownId.ok).toBe(false);
    expect(noHeader.ok).toBe(false);
    if (!wrongSecret.ok && !unknownId.ok && !noHeader.ok) {
      const bodies = await Promise.all([
        wrongSecret.response.text(),
        unknownId.response.text(),
        noHeader.response.text(),
      ]);
      expect(new Set(bodies).size, "the refusals differ and can be told apart").toBe(1);
      expect(wrongSecret.response.status).toBe(401);
      expect(unknownId.response.status).toBe(401);
      expect(noHeader.response.status).toBe(401);
    }
  });

  test("repeated wrong secrets lock the key durably, and the right one is then refused too", async () => {
    const agentId = await makeAgent();
    const { keyId, token } = await issueAgentKey(agentId, "primary");

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      const r = await authenticateAgent(
        req(`vsk_${keyId}_${generateAgentKey().secret}`),
      );
      expect(r.ok).toBe(false);
    }

    // The lock is in Postgres, not in a process-local map, so it survives a
    // restart and is shared by every instance.
    const row = await prisma.agentKey.findUnique({ where: { keyId } });
    expect(row!.lockouts).toBe(1);
    expect(row!.lockedUntil).not.toBeNull();
    expect(row!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    const rightToken = await authenticateAgent(req(token));
    expect(rightToken.ok, "a locked key admitted the correct secret").toBe(false);
  });

  test("a caller cannot keep guessing: refusals run out and become a 429", async () => {
    const agentId = await makeAgent();
    const { keyId } = await issueAgentKey(agentId, "primary");
    const from = someCaller();

    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < FAILURE_LIMIT + 2; i += 1) {
      const r = await authenticateAgent(req(`vsk_${keyId}_${generateAgentKey().secret}`, from));
      expect(r.ok, "a guessed secret authenticated").toBe(false);
      if (!r.ok) {
        statuses.push(r.response.status);
        retryAfter ??= r.response.headers.get("retry-after");
      }
    }

    expect(
      statuses.filter((s) => s === 429).length,
      "an unbounded number of guesses reached the key",
    ).toBeGreaterThan(0);
    // The first FAILURE_LIMIT refusals say nothing beyond "no", and only then
    // does the rate itself become the answer.
    expect(statuses.slice(0, FAILURE_LIMIT).every((s) => s === 401)).toBe(true);
    expect(retryAfter).toBeTruthy();
  });

  test("an exhausted caller gets the same 429 whatever they present", async () => {
    // This is the anti-oracle property. If only *some* causes eventually turned
    // into a 429, watching which requests rate-limit would separate "no such key
    // id" from "wrong secret" — exactly what the single uniform 401 denies.
    const agentId = await makeAgent();
    const { keyId } = await issueAgentKey(agentId, "primary");
    const from = someCaller();

    for (let i = 0; i < FAILURE_LIMIT; i += 1) {
      await authenticateAgent(req(`vsk_${keyId}_${generateAgentKey().secret}`, from));
    }

    const wrongSecret = await authenticateAgent(
      req(`vsk_${keyId}_${generateAgentKey().secret}`, from),
    );
    const unknownId = await authenticateAgent(req(generateAgentKey().token, from));
    const malformed = await authenticateAgent(req("not-a-key-at-all", from));

    for (const [name, r] of [
      ["wrong secret", wrongSecret],
      ["unknown key id", unknownId],
      ["malformed token", malformed],
    ] as const) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.status, `${name} was answered differently`).toBe(429);
    }
  });

  test("only failures are rationed — a correct key still works from a spent caller", async () => {
    // Otherwise one attacker guessing from a shared address, or from behind no
    // proxy at all where `clientIp` collapses to "unknown", could deny service to
    // every honest agent by exhausting one bucket.
    const agentId = await makeAgent();
    const { token } = await issueAgentKey(agentId, "primary");
    const from = someCaller();

    for (let i = 0; i < FAILURE_LIMIT + 2; i += 1) {
      await authenticateAgent(req(generateAgentKey().token, from));
    }
    expect((await authenticateAgent(req(generateAgentKey().token, from))).ok).toBe(false);

    const good = await authenticateAgent(req(token, from));
    expect(good.ok, "a rate-limited caller could not use a correct key").toBe(true);
  });

  test("a revoked key is refused, and revoking is idempotent", async () => {
    const agentId = await makeAgent();
    const { keyId, token } = await issueAgentKey(agentId, "primary");

    expect((await authenticateAgent(req(token))).ok).toBe(true);
    expect(await revokeAgentKey(keyId)).toBe(true);
    expect(await revokeAgentKey(keyId)).toBe(false);

    const after = await authenticateAgent(req(token));
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.response.status).toBe(401);
  });

  test("a key can revoke itself, and a wrong secret cannot revoke it", async () => {
    const agentId = await makeAgent();
    const { token } = await issueAgentKey(agentId, "primary");
    const keyId = parseAgentKey(token)!.keyId;

    expect(await revokeAgentKeyByToken(`vsk_${keyId}_${generateAgentKey().secret}`)).toBe(false);
    expect((await prisma.agentKey.findUnique({ where: { keyId } }))!.revokedAt).toBeNull();

    expect(await revokeAgentKeyByToken(token)).toBe(true);
    expect((await prisma.agentKey.findUnique({ where: { keyId } }))!.revokedAt).not.toBeNull();
  });

  test("rotation overlaps: a second key works while the first still does", async () => {
    const agentId = await makeAgent();
    const first = await issueAgentKey(agentId, "old");
    const second = await issueAgentKey(agentId, "new");

    expect((await authenticateAgent(req(first.token))).ok).toBe(true);
    expect((await authenticateAgent(req(second.token))).ok).toBe(true);

    await revokeAgentKey(first.keyId);
    expect((await authenticateAgent(req(first.token))).ok).toBe(false);
    expect((await authenticateAgent(req(second.token))).ok).toBe(true);
  });

  test("a disabled agent cannot authenticate with a still-valid key", async () => {
    const agentId = await makeAgent();
    const { token } = await issueAgentKey(agentId, "primary");
    expect((await authenticateAgent(req(token))).ok).toBe(true);

    await prisma.agent.update({
      where: { id: agentId },
      data: { status: "disabled", disabledAt: new Date() },
    });
    expect((await authenticateAgent(req(token))).ok).toBe(false);
  });

  test("the secret is accepted only from a header", async () => {
    const agentId = await makeAgent();
    const { token } = await issueAgentKey(agentId, "primary");

    // A URL ends up in access logs, browser history and referrer headers.
    const inQuery = new Request(`https://example.test/api/submissions?key=${token}`, {
      method: "POST",
      headers: { "cf-connecting-ip": someCaller() },
    });
    expect((await authenticateAgent(inQuery)).ok).toBe(false);

    const alias = new Request("https://example.test/api/submissions", {
      method: "POST",
      headers: { "cf-connecting-ip": someCaller(), "x-votive-agent-key": token },
    });
    expect((await authenticateAgent(alias)).ok).toBe(true);
  });
});

// ------------------------------------------------------------------- human ids

test.describe("the human identifier mapping", () => {
  test("a 32-byte hex identifier passes through, lowercased", () => {
    const hex = `0x${"AB".repeat(32)}`;
    expect(humanIdToBytes32(hex)).toBe(`0x${"ab".repeat(32)}`);
    // Two spellings of one identifier must not become two humans.
    expect(humanIdToBytes32(hex)).toBe(humanIdToBytes32(hex.toLowerCase()));
  });

  test("anything else is keccak-256 of its UTF-8 bytes", () => {
    // Pinned against `cast keccak`, which is what Solidity would compute — and
    // against `sdk/src/world/agentBook.ts`, which must agree forever or a human's
    // standing silently detaches from them.
    expect(humanIdToBytes32("votive-human-1")).toBe(
      "0xbe384824de784fc93ef683856def1e13b3a4c28f062fe9bb3285523b33d905ff",
    );
    expect(humanIdToBytes32("world:human:abc123")).toBe(
      "0xb37cf0edf13ecdc95c8caae202674d5351fcad3b8ef208a12c853d99fc3d70e5",
    );
    expect(humanIdToBytes32("  votive-human-1  ")).toBe(humanIdToBytes32("votive-human-1"));
    expect(() => humanIdToBytes32("   ")).toThrow(/empty/i);
  });

  test("the zero word is not a human", () => {
    expect(isHumanBacked(ZERO_HUMAN_ID)).toBe(false);
    expect(isHumanBacked(null)).toBe(false);
    expect(isHumanBacked("0x")).toBe(false);
    expect(isHumanBacked(humanIdToBytes32("votive-human-1"))).toBe(true);
  });
});

// -------------------------------------------------------- the wallet signature

/**
 * The other half of the auth story: the agent secret proves an agent, and this
 * proves a human. Registration and voting both hang off it, so the single-use and
 * wrong-purpose properties are worth pinning here rather than discovering later.
 *
 * Only the EOA path is exercised. The ERC-1271 fallback needs a deployed
 * contract wallet, which this suite has no way to produce.
 */
test.describe("the challenge signature", () => {
  const newSigner = () => {
    const account = privateKeyToAccount(generatePrivateKey());
    signers.push(account.address.toLowerCase());
    return account;
  };

  test("a signature over the minted message is accepted, once", async () => {
    const account = newSigner();
    const { nonce, message } = await mintChallenge({
      wallet: account.address,
      purpose: "register",
    });

    // The wallet is asked for exactly what we minted; nothing reconstructs it
    // from a request body.
    expect(message).toContain(`Wallet: ${account.address.toLowerCase()}`);
    expect(message).toContain("Purpose: register");
    expect(message).toContain(`Nonce: ${nonce}`);

    const signature = await account.signMessage({ message });
    const first = await consumeChallenge({ nonce, signature, purpose: "register" });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.wallet).toBe(account.address.toLowerCase());

    // Replay. A nonce that survived its first use would let a signature captured
    // from a terminal's scrollback be presented again.
    const replay = await consumeChallenge({ nonce, signature, purpose: "register" });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("already-used");
  });

  test("a challenge minted for one purpose cannot authorise another", async () => {
    // Otherwise a signature collected to register an agent would also mint it a
    // key, and consent to one act would silently be consent to all of them.
    const account = newSigner();
    const { nonce, message } = await mintChallenge({
      wallet: account.address,
      purpose: "register",
    });
    const signature = await account.signMessage({ message });

    const res = await consumeChallenge({ nonce, signature, purpose: "issue-key" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("wrong-purpose");
  });

  test("the nonce is burned even by a failed attempt", async () => {
    // The signature is refused and the nonce is spent, so an attacker cannot
    // grind candidate signatures against one challenge.
    const account = newSigner();
    const other = newSigner();
    const { nonce, message } = await mintChallenge({
      wallet: account.address,
      purpose: "vote",
      subject: "submission-1",
    });
    expect(message).toContain("Subject: submission-1");

    const wrong = await other.signMessage({ message });
    const first = await consumeChallenge({ nonce, signature: wrong, purpose: "vote" });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.reason).toBe("bad-signature");

    const right = await account.signMessage({ message });
    const second = await consumeChallenge({ nonce, signature: right, purpose: "vote" });
    expect(second.ok, "a burned nonce accepted a later correct signature").toBe(false);
    if (!second.ok) expect(second.reason).toBe("already-used");
  });

  test("a signature over different words than we issued is refused", async () => {
    const account = newSigner();
    const { nonce, message } = await mintChallenge({
      wallet: account.address,
      purpose: "revoke-key",
      subject: "aaaaaaaaaaaaaaaa",
    });

    // The client contributes a signature and nothing else: the message is rebuilt
    // server-side from the stored row, so signing an edited copy proves nothing.
    const tampered = message.replace("Subject: aaaaaaaaaaaaaaaa", "Subject: bbbbbbbbbbbbbbbb");
    expect(tampered).not.toBe(message);

    const res = await consumeChallenge({
      nonce,
      signature: await account.signMessage({ message: tampered }),
      purpose: "revoke-key",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad-signature");
  });

  test("an unknown nonce is refused without a database row to show for it", async () => {
    const account = newSigner();
    const res = await consumeChallenge({
      nonce: crypto.randomBytes(16).toString("base64url"),
      signature: await account.signMessage({ message: "anything" }),
      purpose: "register",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unknown-nonce");
  });

  test("an expired challenge is refused", async () => {
    const account = newSigner();
    const { nonce } = await mintChallenge({ wallet: account.address, purpose: "register" });

    // Reach past the TTL by ageing the row rather than by waiting ten minutes.
    const row = await prisma.agentVerification.update({
      where: { nonce },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const message = challengeMessage({
      wallet: row.wallet,
      purpose: "register",
      subject: row.subject,
      nonce: row.nonce,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
    });

    const res = await consumeChallenge({
      nonce,
      signature: await account.signMessage({ message }),
      purpose: "register",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("expired");
  });
});
