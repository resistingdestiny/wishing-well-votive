/**
 * The check that makes a file-backed catalogue defensible.
 *
 * `src/core/skills/catalogue.ts` is source, not database rows, and the argument
 * for that is entirely this script: every field in it is a fact about code in the
 * same commit, so a program can disagree with it. Rows in Postgres could say
 * anything and nothing would ever push back.
 *
 * Four things are checked, and each one has already been wrong in this repo or in
 * a design for it:
 *
 *   1. **Every `exports` symbol resolves on the *built* SDK.** Not on the source:
 *      the thing a builder installs is `dist/`, and until this release the entry
 *      point exported neither `createStandingView` nor `createResourceCommons`
 *      while `VotiveAgentConfig` required both — so every possible code sample
 *      was unrunnable and no test in either project would have noticed.
 *   2. **Every `tools` name is one `createVotiveAgent` actually offers.** Tools
 *      are hidden when their dependency is missing, so the agent is built fully
 *      equipped here; a name that is never offered under any configuration is a
 *      name that does not exist.
 *   3. **No manifest string looks like a private key or an issued agent secret.**
 *      Samples are copied wholesale; one pasted credential becomes a leaked one.
 *   4. **No secret that lives on our server is named `NEXT_PUBLIC_*`.** That
 *      prefix ships a value to the browser. Naming the agent-key pepper that way
 *      would publish the one value that makes a database dump useless.
 *
 * Run: `npm run check:skills`. Exits non-zero with the reason.
 */
import { SKILLS, TOOLBELT } from "../src/core/skills/catalogue";
import { isResourceSlug, KNOWN_RESOURCE_IDS, resourceIdOf } from "../src/core/skills/resourceId";
import type { SkillSpec } from "../src/core/skills/skill";

const failures: string[] = [];
const fail = (message: string): void => {
  failures.push(message);
};

// ---------------------------------------------------------------- the built SDK

/**
 * Imported by URL so TypeScript treats it as `any` rather than trying to resolve
 * `sdk/dist/index.d.ts` at typecheck time. `dist/` is gitignored, and a root
 * `tsc --noEmit` that fails on a clean checkout would break every other slice's
 * verification for a reason that has nothing to do with them.
 */
const distUrl = new URL("../sdk/dist/index.js", import.meta.url).href;

let sdk: Record<string, unknown>;
try {
  sdk = (await import(distUrl)) as Record<string, unknown>;
} catch (e) {
  console.error(
    `Could not import the built SDK from sdk/dist/index.js.\n` +
      `Build it first:  cd sdk && npm install && npm run build\n\n` +
      `${(e as Error).message}`,
  );
  process.exit(1);
}

// 1. every documented symbol exists on what a consumer would install
for (const spec of SKILLS) {
  for (const symbol of spec.exports) {
    if (sdk[symbol] === undefined) {
      fail(
        `skill "${spec.slug}" documents \`${symbol}\`, which the built SDK does not export. ` +
          `Either export it from sdk/src/index.ts or stop citing it.`,
      );
    }
  }
}

// 2. every documented tool name is one the agent will actually offer
const fake = <T>(value: T) => value;
const agent = (sdk.createVotiveAgent as (config: unknown) => { tools(): { name: string }[] })({
  // Fully equipped on purpose: tools are hidden when their dependency is absent,
  // so anything less would make an absent tool indistinguishable from a
  // misconfigured harness.
  rail: fake({ network: "testnet", accountId: "0.0.1", transferHbar: async () => {}, confirm: async () => {} }),
  bounty: fake({ claim: async () => {}, withdraw: async () => {}, credited: async () => 0n }),
  standing: fake({ snapshot: async () => {}, isBarred: async () => false, multiplierBps: async () => 0n }),
  resources: fake({ catalogue: () => [], request: async () => {}, survey: async () => [] }),
  wallet: "0x0000000000000000000000000000000000000001",
});
const offered = new Set(agent.tools().map((tool) => tool.name));

for (const spec of SKILLS) {
  for (const tool of spec.tools) {
    if (!offered.has(tool)) {
      fail(
        `skill "${spec.slug}" claims the tool \`${tool}\`, which a fully equipped ` +
          `createVotiveAgent does not offer. Offered: ${[...offered].sort().join(", ")}.`,
      );
    }
  }
}

// A tool the SDK offers that no skill documents is a capability nobody can find.
const documented = new Set(SKILLS.flatMap((s) => s.tools));
for (const tool of offered) {
  if (!documented.has(tool)) {
    fail(`the SDK offers \`${tool}\`, which no skill in the catalogue documents.`);
  }
}

// -------------------------------------------------------------- secret shapes

/**
 * Deliberately narrow. A bare 64-character hex string is also what every
 * `bytes32` looks like — resource ids, task hashes, human identifiers — and a
 * check that flagged those would be turned off within a week. These match a
 * secret *in the position of a secret*.
 */
const SECRET_SHAPES: { name: string; re: RegExp }[] = [
  { name: "a PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: "a private key assigned to an identifier",
    re: /\b(private_?key|secret_?key|pepper|_pk)\b\s*[:=]\s*['"`]0x?[0-9a-fA-F]{32,}/i,
  },
  { name: "an issued agent key", re: /\bvsk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}\b/ },
  { name: "a DER-encoded ed25519 key", re: /\b302e020100300506032b657004220420[0-9a-fA-F]{64}\b/i },
  { name: "an OpenAI-shaped key", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
];

const walk = (value: unknown, path: string, visit: (text: string, path: string) => void): void => {
  if (typeof value === "string") return visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((entry, i) => walk(entry, `${path}[${i}]`, visit));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`, visit);
  }
};

walk({ SKILLS, TOOLBELT }, "catalogue", (text, path) => {
  for (const shape of SECRET_SHAPES) {
    if (shape.re.test(text)) fail(`${path} contains what looks like ${shape.name}.`);
  }
});

// ----------------------------------------------- server secrets and NEXT_PUBLIC

for (const spec of SKILLS) {
  for (const key of spec.config) {
    if (key.secret && key.where === "votive-server" && key.name.startsWith("NEXT_PUBLIC_")) {
      fail(
        `skill "${spec.slug}" names the server secret \`${key.name}\` with a NEXT_PUBLIC_ ` +
          `prefix, which ships its value to every browser that loads the page.`,
      );
    }
    if (key.secret && key.where === "browser") {
      fail(
        `skill "${spec.slug}" puts the secret \`${key.name}\` in the browser. There is no ` +
          `such thing as a secret in a browser.`,
      );
    }
  }
}

// ------------------------------------------------------------------- coherence

const slugs = new Set<string>();
for (const spec of SKILLS) {
  if (slugs.has(spec.slug)) fail(`duplicate skill slug: ${spec.slug}`);
  slugs.add(spec.slug);
  if (spec.caveats.length === 0) {
    fail(`skill "${spec.slug}" lists no caveats. Every one of these has a sharp edge.`);
  }
  if (spec.surface.includes("sdk") && spec.install.length === 0) {
    fail(`skill "${spec.slug}" is an npm import with no install line.`);
  }
  assertContractEnvNames(spec);
}

function assertContractEnvNames(spec: SkillSpec): void {
  for (const contract of spec.contracts) {
    // Addresses are read from the environment at render time. A NEXT_PUBLIC_
    // address is fine and intended — it is public — but a bare name that is not
    // an environment variable would silently render as "not set here".
    if (!/^[A-Z][A-Z0-9_]*$/.test(contract.env)) {
      fail(`skill "${spec.slug}" names contract env \`${contract.env}\`, which is not a variable name.`);
    }
  }
}

// ------------------------------------------------------------------- toolbelt

const seen = new Set<string>();
for (const item of TOOLBELT) {
  if (!isResourceSlug(item.slug)) {
    fail(`toolbelt item "${item.slug}" is not a canonical resource slug.`);
    continue;
  }
  if (seen.has(item.slug)) fail(`duplicate toolbelt slug: ${item.slug}`);
  seen.add(item.slug);

  const id = resourceIdOf(item.slug);
  const known = KNOWN_RESOURCE_IDS[item.slug];
  if (known && known !== id) {
    fail(
      `resourceIdOf("${item.slug}") is ${id}, but the id registered on chain is ${known}. ` +
        `The derivation has changed and the app is now asking the registry about a resource ` +
        `that does not exist — which it will answer as "not available to you".`,
    );
  }
}

// ----------------------------------------------------------------------- verdict

if (failures.length > 0) {
  console.error(`check:skills — ${failures.length} problem${failures.length === 1 ? "" : "s"}\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error("");
  process.exit(1);
}

console.log(
  `check:skills — ok. ${SKILLS.length} skills, ${offered.size} tools, ` +
    `${TOOLBELT.length} toolbelt items, all symbols resolved against sdk/dist.`,
);
