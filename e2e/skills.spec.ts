/**
 * The skills catalogue, checked the way a builder would find it wrong.
 *
 * Unit tests wearing a Playwright harness, for the reason `agent-auth.spec.ts`
 * gives: this repo has two test runners, `node --test` inside `sdk/` which cannot
 * see `src/`, and this suite. No browser is needed and no dev server is started —
 * `playwright.config.ts` declares no `webServer`, so nothing here touches the
 * port the other worktree is running on.
 *
 * `npm run check:skills` covers the same catalogue↔SDK ground and is what a build
 * would run. These add the parts a script cannot: the derivation matching what is
 * actually registered on Base Sepolia, the readiness algebra that decides whether
 * a page says "ready" or "unknown", and the invariant that nothing on the page
 * can quietly assert a gate the deployed bytecode does not have.
 *
 * Run: `npx playwright test skills`.
 */
import { expect, test } from "@playwright/test";

import { SKILLS, TOOLBELT, skillBySlug } from "../src/core/skills/catalogue";
import { SAMPLES } from "../src/core/skills/samples";
import {
  KNOWN_RESOURCE_IDS,
  RESOURCE_ID_PREFIX,
  isResourceSlug,
  resourceIdOf,
} from "../src/core/skills/resourceId";
import {
  probeBadge,
  probeWord,
  skillState,
  skillStateReason,
  summarise,
  type Probe,
} from "../src/core/skills/readiness";
import { AGENT_CONTRACTS } from "../src/lib/chainReads";
import { readStandingGate } from "../src/lib/skillReadiness";

const probe = (key: string, state: Probe["state"]): Probe => ({
  key,
  label: key,
  state,
  detail: "because",
});

// --------------------------------------------------------------- resource ids

test.describe("the resource id derivation", () => {
  /**
   * The one that matters. `ops/demo-seed.sh` registered the corpus with
   * `cast keccak "resource:linear-a-corpus-api"`, and that resource is live on
   * Base Sepolia. If this app derives the id any other way it asks the registry
   * about something nobody registered — and the registry answers `NoSuchResource`,
   * which the UI renders as "not available to you". A sentence about the operator,
   * produced by a bug in our hashing.
   */
  test("matches the id already registered on Base Sepolia", () => {
    expect(resourceIdOf("linear-a-corpus-api")).toBe(
      "0xe44c63e7d1eea5287ebd7ebc0dcd76b10338de54ffab1cc2012b7499cf706dd7",
    );
    expect(KNOWN_RESOURCE_IDS["linear-a-corpus-api"]).toBe(resourceIdOf("linear-a-corpus-api"));
  });

  test("the prefix is the one the seed script and the Foundry script use", () => {
    expect(RESOURCE_ID_PREFIX).toBe("resource:");
  });

  test("is stable and case-exact", () => {
    expect(resourceIdOf("votive-run-log-db")).toBe(resourceIdOf("votive-run-log-db"));
    expect(resourceIdOf("votive-run-log-db")).not.toBe(resourceIdOf("votive-run-log-dbx"));
  });

  /** A slug that hashes anyway is a slug that quietly becomes a second resource. */
  test("refuses anything that is not canonical rather than hashing it", () => {
    for (const bad of ["Linear-A", "trailing-", "-leading", "double--dash", "has space", ""]) {
      expect(isResourceSlug(bad), bad).toBe(false);
      expect(() => resourceIdOf(bad), bad).toThrow();
    }
  });

  test("every toolbelt slug is canonical and unique", () => {
    const slugs = TOOLBELT.map((item) => item.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(isResourceSlug(slug), slug).toBe(true);
  });
});

// ------------------------------------------------------------ readiness algebra

test.describe("what the page is allowed to claim", () => {
  test("a skill needing nothing of ours is ready even when we are broken", () => {
    const spec = skillBySlug("hedera-payments")!;
    expect(spec.requires).toEqual([]);
    expect(skillState(spec, [probe("base-rail", "unknown")])).toBe("ready");
    expect(skillStateReason(spec, [])).toMatch(/nothing from this deployment/i);
  });

  test("unknown beats not-configured, which beats ready", () => {
    const spec = { ...skillBySlug("standing")!, requires: ["a", "b"] };
    expect(skillState(spec, [probe("a", "ready"), probe("b", "ready")])).toBe("ready");
    expect(skillState(spec, [probe("a", "ready"), probe("b", "not-configured")])).toBe(
      "not-configured",
    );
    // The important direction: one thing missing and one thing unreadable is
    // *unknown*. Saying "not configured" would be claiming a contract is absent
    // on the strength of a read that never came back.
    expect(skillState(spec, [probe("a", "not-configured"), probe("b", "unknown")])).toBe("unknown");
  });

  test("a requirement naming a probe that does not exist reads as unknown, never ready", () => {
    const spec = { ...skillBySlug("standing")!, requires: ["typo-in-the-catalogue"] };
    expect(skillState(spec, [probe("standing-ledger", "ready")])).toBe("unknown");
  });

  test("every probe key a skill requires exists in the readiness vocabulary", () => {
    // The probes `skillReadiness()` produces. Kept here rather than imported so a
    // key silently renamed in one place fails here instead of rendering every
    // skill as unknown on the live page.
    const known = new Set([
      "base-rail",
      "hedera-rail",
      "human-registry",
      "standing-ledger",
      "resource-registry",
      "agent-keys",
      "sdk-package",
    ]);
    for (const spec of SKILLS) {
      for (const key of spec.requires) {
        expect(known.has(key), `${spec.slug} requires unknown probe "${key}"`).toBe(true);
      }
    }
  });

  /** Styling is part of the claim. "unknown" rendered in the same colour as
   *  "ready" is a page that told the truth and was read as lying. */
  test("unknown never renders as a success or a neutral", () => {
    expect(probeBadge("ready")).toBe("pass");
    expect(probeBadge("unknown")).toBe("fail");
    expect(probeBadge("not-configured")).toBe("waiting");
    expect(probeWord("unknown")).toBe("unknown");
  });

  test("the summary counts every state, so nothing is silently dropped", () => {
    const totals = summarise([
      probe("a", "ready"),
      probe("b", "not-configured"),
      probe("c", "unknown"),
    ]);
    expect(totals.ready + totals.notConfigured + totals.unknown).toBe(totals.total);
    expect(totals.total).toBe(3);
  });
});

// ---------------------------------------------------------- catalogue hygiene

test.describe("the catalogue itself", () => {
  test("documents every symbol against the built SDK", async () => {
    const sdk = (await import(
      new URL("../sdk/dist/index.js", import.meta.url).href
    )) as Record<string, unknown>;

    for (const spec of SKILLS) {
      for (const symbol of spec.exports) {
        expect(sdk[symbol], `${spec.slug} cites ${symbol}`).toBeDefined();
      }
    }
  });

  test("every tool the SDK offers is documented, and vice versa", async () => {
    const sdk = (await import(new URL("../sdk/dist/index.js", import.meta.url).href)) as {
      createVotiveAgent: (c: unknown) => { tools(): { name: string }[] };
    };
    const anything = {} as never;
    const offered = new Set(
      sdk
        .createVotiveAgent({
          rail: anything,
          bounty: anything,
          standing: anything,
          resources: anything,
          wallet: "0x0000000000000000000000000000000000000001",
        })
        .tools()
        .map((t) => t.name),
    );
    const documented = new Set(SKILLS.flatMap((s) => s.tools));

    expect([...offered].sort()).toEqual([...documented].sort());
  });

  /** An address in a source file is a claim about a deployment the file has never
   *  seen. Every one is named by environment variable and resolved at render. */
  test("hardcodes no contract address", () => {
    const text = JSON.stringify({ SKILLS, TOOLBELT, SAMPLES });
    const addresses = text.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? [];
    expect(addresses, `addresses written into the catalogue: ${addresses.join(", ")}`).toEqual([]);
  });

  test("no secret is named NEXT_PUBLIC_, and none is placed in a browser", () => {
    for (const spec of SKILLS) {
      for (const key of spec.config) {
        if (!key.secret) continue;
        expect(key.name.startsWith("NEXT_PUBLIC_"), `${spec.slug}/${key.name}`).toBe(false);
        expect(key.where, `${spec.slug}/${key.name}`).not.toBe("browser");
      }
    }
  });

  test("every skill says what you have to host, and what will annoy you later", () => {
    for (const spec of SKILLS) {
      expect(spec.hosting.length, spec.slug).toBeGreaterThan(20);
      expect(spec.caveats.length, spec.slug).toBeGreaterThan(0);
      expect(spec.summary.length, spec.slug).toBeGreaterThan(20);
    }
  });

  test("every toolbelt item says what is released and why it is contested", () => {
    for (const item of TOOLBELT) {
      expect(item.releases.length, item.slug).toBeGreaterThan(20);
      expect(item.why.length, item.slug).toBeGreaterThan(20);
      expect(item.intendedMinAssurance).toBeGreaterThanOrEqual(1);
    }
  });
});

// ------------------------------------------------------------- the live gate

test.describe("the standing gate, read off the deployed bytecode", () => {
  /**
   * `/rail` has been asserting "standing is checked when you take work on" while
   * pointed at a rail whose `standing()` returns nothing. This pins the invariant
   * the fix depends on: a gate may be claimed only when an adapter address was
   * actually read.
   */
  test("a rail whose standing() returns nothing is never reported as gated", async () => {
    test.skip(!AGENT_CONTRACTS.hederaRail, "no Hedera rail configured here");
    const gate = await readStandingGate(AGENT_CONTRACTS.hederaRail!, "hedera-testnet");
    expect(gate.state).not.toBe("gated");
  });

  test("the Base rail reports the adapter it was actually constructed with", async () => {
    test.skip(!AGENT_CONTRACTS.baseRail, "no Base rail configured here");
    const gate = await readStandingGate(AGENT_CONTRACTS.baseRail!, "base-sepolia");

    // The Base rail demonstrably gates: `standing()` returns the adapter and
    // `adapter.isRail(rail)` is true, both re-read while this was written. So the
    // only two honest outcomes are "gated" and "we could not look".
    expect(gate.state).not.toBe("ungated");
    if (gate.state === "gated") expect(gate.adapter).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  /**
   * The bug this corroboration exists for.
   *
   * `chainReads.standingGate` classifies a `ContractFunctionExecutionError` as
   * proof the function is missing from the bytecode — and viem wraps a transport
   * failure in that same class. Pointed at a closed port it reported the Base
   * rail, which does gate, as bytecode predating the check: a fact about our
   * endpoint rendered as a fact about somebody else's contract.
   *
   * This asserts the property that makes that unreachable: a rail we cannot read
   * at all is never described as ungated. It is checked against a rail address
   * with no contract behind it, which is the closest reproduction available
   * without repointing the RPC for the whole process.
   */
  test("a rail that answers nothing at all is not described as ungated", async () => {
    const nowhere = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;
    const gate = await readStandingGate(nowhere, "base-sepolia");

    expect(gate.state).toBe("unknown");
  });
});
