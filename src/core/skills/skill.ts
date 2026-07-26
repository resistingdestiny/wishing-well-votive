/**
 * What a skill *is*, as a record a script can check.
 *
 * The catalogue is files rather than database rows for one reason: every field
 * below is a fact about code sitting in the same commit, so a script can verify
 * it. `scripts/check-skills.ts` resolves every {@link SkillSpec.exports} symbol
 * against the built SDK, matches every {@link SkillSpec.tools} name against what
 * `createVotiveAgent` actually offers, and refuses a manifest that names a server
 * secret with a `NEXT_PUBLIC_` prefix. A row in Postgres could say anything and
 * nothing would ever disagree with it.
 *
 * That check is the whole justification for this shape. If it is ever removed,
 * move the catalogue to the database — an unverifiable file is strictly worse
 * than a row, because it looks like source.
 */

/** Mirrors `TxChain` in `src/lib/txLog.ts`. Restated rather than imported so this
 *  module stays free of the database client that file pulls in — the catalogue is
 *  read by a build script as well as by the app. */
export type SkillChain = "base-sepolia" | "hedera-testnet";

export type SkillCategory = "payment" | "protocol" | "identity" | "toolbelt";

/**
 * How a builder reaches the skill.
 *
 * `sdk` means an npm import. `http` means an endpoint on this deployment, which
 * is a different integration story: no install, but a credential to hold and a
 * base URL to configure.
 */
export type SkillSurface = "sdk" | "http" | "chain";

export interface ConfigKey {
  name: string;
  what: string;
  /** Where the value is held. `votive-server` keys are ours, not the builder's,
   *  and are listed so a builder can tell what they are *not* responsible for. */
  where: "agent-host" | "votive-server" | "browser";
  secret: boolean;
  required: boolean;
}

export interface CodeSample {
  /** Shown as the block's caption. */
  title: string;
  language: "ts" | "bash" | "json" | "http";
  code: string;
  /** One line under the block, when the code alone would mislead. */
  note?: string;
}

export interface SkillContract {
  label: string;
  /** The environment variable holding the address on this deployment. Read at
   *  render time — the catalogue never hardcodes an address, because an address
   *  in a file is a claim about a deployment the file cannot see. */
  env: string;
  chain: SkillChain;
}

export interface SkillSpec {
  slug: string;
  title: string;
  /** One sentence. What a builder gets, not how it works. */
  summary: string;
  category: SkillCategory;
  surface: SkillSurface[];
  /** Probe keys from `skillReadiness()` this skill depends on. A skill whose
   *  probes are not all `ready` renders as degraded rather than as available. */
  requires: string[];
  /** Symbols that must exist on the built SDK's entry point. Checked. */
  exports: string[];
  /** Tool names `createVotiveAgent(...).tools()` must offer. Checked. */
  tools: string[];
  /** npm install arguments, in order. */
  install: string[];
  config: ConfigKey[];
  /** What the builder has to run. Say "nothing" in as many words when it is
   *  nothing — "no hosting required" is a selling point that gets lost if it is
   *  merely absent. */
  hosting: string;
  contracts: SkillContract[];
  samples: CodeSample[];
  /** Things that are true and unhelpful. Rendered, never hidden: a caveat a
   *  builder discovers at 2am is worth less than the same caveat on the page. */
  caveats: string[];
  docs?: { label: string; href: string }[];
}

/**
 * A toolbelt item: a resource an agent asks for rather than a function it calls.
 *
 * Separate from {@link SkillSpec} because the interesting facts are different.
 * A skill is code you import; a toolbelt item is an entitlement somebody has to
 * grant you, and the two questions that matter are what the chain says about it
 * and what the community has said about it.
 */
export interface ToolbeltItem {
  /** The slug the `bytes32` id is derived from. See `resourceId.ts`. */
  slug: string;
  title: string;
  summary: string;
  kind: "data" | "database" | "credential" | "compute" | "capital";
  /** What the provider hands over once a grant exists, in words. Never a value. */
  releases: string;
  /** Why a community would hesitate. The argument a resource request has to make. */
  why: string;
  /** Uses per epoch at parity standing, as we intend to register it. The chain is
   *  authoritative and is read live — this is the intent, labelled as such. */
  intendedBaseLimit: number;
  /** Assurance tier we intend to require: 1 device, 2 selfie, 3 orb. */
  intendedMinAssurance: number;
  /** Who releases the credential. */
  provider: string;
}

export const ASSURANCE_TIERS = ["none", "device", "selfie", "orb"] as const;

export function assuranceLabel(tier: number): string {
  return ASSURANCE_TIERS[tier] ?? `unknown(${tier})`;
}
