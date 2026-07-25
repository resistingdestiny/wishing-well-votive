import { z } from "zod";
import { keccak256, toHex, encodeAbiParameters, type Hex } from "viem";
import {
  BeneficiarySchema,
  buildBeneficiaries,
  ZERO_BENEFICIARIES_ROOT,
  type Beneficiary,
} from "./beneficiaries.js";

/** Mirrors the on-chain WishKind enum ordering. */
export const WishKindSchema = z.enum([
  "return-on-condition",
  "distribute-to-active",
  "offchain-action",
]);
export type WishKind = z.infer<typeof WishKindSchema>;

export const WISH_KIND_TO_ENUM: Record<WishKind, number> = {
  "return-on-condition": 0,
  "distribute-to-active": 1,
  "offchain-action": 2,
};

const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address");

/**
 * The executable capability requirement: what an AI model must demonstrably do
 * before the agent may attempt this wish. Compiles to an eval in the harness.
 */
export const EvalSpecSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("qa"),
    question: z.string().min(1),
    expected: z.string().min(1),
    matcher: z.enum(["exact", "contains", "numeric-tolerance"]),
    tolerance: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("json-task"),
    instruction: z.string().min(1),
    /** Required keys and their primitive types in the model's JSON answer. */
    requiredFields: z.record(z.enum(["string", "number", "boolean"])),
    /** Optional exact-match constraints on specific fields. */
    expectedValues: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  }),
  z.object({
    type: z.literal("multi-step"),
    steps: z
      .array(
        z.object({
          question: z.string().min(1),
          expected: z.string().min(1),
          matcher: z.enum(["exact", "contains", "numeric-tolerance"]),
          tolerance: z.number().nonnegative().optional(),
        }),
      )
      .min(2),
  }),
  z.object({
    /** Tool-use in a deterministic sandbox, graded on terminal STATE not a string. */
    type: z.literal("agentic"),
    sandbox: z.literal("accounts"),
    instruction: z.string().min(1),
    /** Starting balances. */
    initial: z.record(z.number()),
    /** Required ending balances (terminal-state grade). */
    target: z.record(z.number()),
    maxTurns: z.number().int().positive().max(50),
  }),
  z.object({
    /** Subjective capability: an LLM judge scores a rubric, an adversary refutes. */
    type: z.literal("judged"),
    task: z.string().min(1),
    /** The rubric the judge scores against (what a passing answer must contain). */
    rubric: z.string().min(1),
    /** Judge PASS threshold (0..1). */
    threshold: z.number().min(0).max(1).default(0.7),
  }),
]);
export type EvalSpec = z.infer<typeof EvalSpecSchema>;

/**
 * The full parsed story. The wisher signs (via the creation tx) the on-chain
 * projection of this; execution runs off the schema, never off the prose.
 */
export const StorySchemaZ = z.object({
  kind: WishKindSchema,
  wisher: AddressSchema,
  guardian: AddressSchema.optional(),
  beneficiary: AddressSchema.optional(),
  /**
   * Identity/union beneficiaries (fiat-rails addendum). When present, the wish
   * names its recipients by a tagged union — a wallet address or a real person
   * (identity descriptor). Committed on chain as `beneficiariesRoot` and resolved
   * through the Claimable lifecycle; mutually exclusive with a single `beneficiary`.
   */
  beneficiaries: z.array(BeneficiarySchema).optional(),
  /** Named escheat destination (charity/heirs); escheat routes here if set. */
  fallbackBeneficiary: AddressSchema.optional(),
  capability: z.object({
    /** Human-readable summary of what the model must be able to do. */
    summary: z.string().min(1),
    eval: EvalSpecSchema,
  }),
  condition: z.object({
    /** Human-readable resolution condition the oracle attests against. */
    summary: z.string().min(1),
    /** Canonical machine string; its keccak becomes conditionHash on chain. */
    canonical: z.string().min(1),
  }),
  amendPolicy: z.object({
    amendAfterDays: z.number().int().positive().default(365),
    escheatAfterDays: z.number().int().positive().default(5 * 365),
    /** Irrevocable wish: the cell permanently rejects amend/revoke on chain. */
    sealed: z.boolean().default(false),
  }),
  /** OffchainAction only: max executor reimbursement in wei (decimal string). */
  actionBudgetWei: z.string().regex(/^\d+$/).default("0"),
});
export type ParsedStory = z.infer<typeof StorySchemaZ>;

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Stable id for a capability requirement: keccak over the canonical eval. */
export function capabilityId(spec: EvalSpec): `0x${string}` {
  return keccak256(toHex(canonicalize(spec)));
}

/**
 * On-chain condition resolvers (ROADMAP §3). A canonical condition may name a
 * trustless resolver + params; its conditionHash is then a *commitment* to that
 * resolver + params (so binding is self-verifying) rather than a plain keccak of
 * the string. These MUST match CapabilityRegistry.RESOLVER_TAG / resolverIds and
 * each resolver's abi.decode of `params`.
 */
export const RESOLVER_TAG: Hex = keccak256(toHex("WishConditionResolver.v1"));
export const RESOLVER_IDS = {
  blockNumber: keccak256(toHex("block-number")) as Hex,
  priceFeed: keccak256(toHex("price-feed")) as Hex,
  erc20Received: keccak256(toHex("erc20-received")) as Hex,
} as const;

export interface ResolverCondition {
  resolverId: Hex;
  params: Hex;
}

/** Parse a canonical condition into a resolver binding, or null if it is manual. */
export function parseResolverCondition(canonical: string): ResolverCondition | null {
  let m = canonical.match(/^block>=(\d+)$/);
  if (m) {
    return {
      resolverId: RESOLVER_IDS.blockNumber,
      params: encodeAbiParameters([{ type: "uint256" }], [BigInt(m[1]!)]),
    };
  }
  // price:<feed>:<op><threshold>:<maxStaleness>  op is >= or <=
  m = canonical.match(/^price:(0x[0-9a-fA-F]{40}):(>=|<=)(\d+):(\d+)$/);
  if (m) {
    return {
      resolverId: RESOLVER_IDS.priceFeed,
      params: encodeAbiParameters(
        [{ type: "address" }, { type: "uint8" }, { type: "int256" }, { type: "uint256" }],
        [m[1] as Hex, m[2] === ">=" ? 0 : 1, BigInt(m[3]!), BigInt(m[4]!)],
      ),
    };
  }
  // erc20-received:<token>:<minAmount>
  m = canonical.match(/^erc20-received:(0x[0-9a-fA-F]{40}):(\d+)$/);
  if (m) {
    return {
      resolverId: RESOLVER_IDS.erc20Received,
      params: encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [m[1] as Hex, BigInt(m[2]!)],
      ),
    };
  }
  return null;
}

/** The registry's binding commitment for a resolver condition. */
export function resolverConditionHash(rc: ResolverCondition): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [RESOLVER_TAG, rc.resolverId, keccak256(rc.params)],
    ),
  );
}

/**
 * Stable hash for the resolution condition. A resolver-typed condition hashes to
 * the binding commitment (so the signed hash pins the resolver + params); every
 * other (manual/oracle) condition keeps the plain keccak of the canonical string.
 */
export function conditionHash(canonical: string): `0x${string}` {
  const rc = parseResolverCondition(canonical);
  if (rc) return resolverConditionHash(rc);
  return keccak256(toHex(canonical));
}

/** Content hash binding the raw prose on chain. */
export function storyHash(prose: string): `0x${string}` {
  return keccak256(toHex(prose));
}

export interface OnchainSchema {
  kind: number;
  wisher: `0x${string}`;
  guardian: `0x${string}`;
  beneficiary: `0x${string}`;
  capabilityId: `0x${string}`;
  conditionHash: `0x${string}`;
  storyHash: `0x${string}`;
  actionBudget: bigint;
  isSealed: boolean;
  fallbackBeneficiary: `0x${string}`;
  beneficiariesRoot: `0x${string}`;
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/**
 * The `beneficiariesRoot` schema commitment for a wish's identity/union
 * beneficiary set — binds the Merkle root AND the total weight (matching
 * WishCellBase), or the zero value when the wish has no such beneficiaries.
 */
export function beneficiariesRoot(beneficiaries: Beneficiary[] | undefined): `0x${string}` {
  if (!beneficiaries || beneficiaries.length === 0) return ZERO_BENEFICIARIES_ROOT;
  return buildBeneficiaries(beneficiaries).commitment;
}

/** Project a parsed story to the exact struct the contracts execute off. */
export function toOnchainSchema(story: ParsedStory, prose: string): OnchainSchema {
  const root = beneficiariesRoot(story.beneficiaries);
  const hasBeneficiarySet = root !== ZERO_BENEFICIARIES_ROOT;
  return {
    kind: WISH_KIND_TO_ENUM[story.kind],
    wisher: story.wisher as `0x${string}`,
    // A sealed wish forbids a guardian on chain (amendment is foreclosed).
    guardian: (story.amendPolicy.sealed ? ZERO : story.guardian ?? ZERO) as `0x${string}`,
    // The union root replaces the single beneficiary — the cell enforces they are
    // mutually exclusive, so zero the single field when a beneficiary set is named.
    beneficiary: (hasBeneficiarySet ? ZERO : story.beneficiary ?? ZERO) as `0x${string}`,
    capabilityId: capabilityId(story.capability.eval),
    conditionHash: conditionHash(story.condition.canonical),
    storyHash: storyHash(prose),
    actionBudget: BigInt(story.actionBudgetWei),
    isSealed: story.amendPolicy.sealed,
    fallbackBeneficiary: (story.fallbackBeneficiary ?? ZERO) as `0x${string}`,
    beneficiariesRoot: root,
  };
}
