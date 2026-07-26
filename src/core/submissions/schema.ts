/**
 * Request shapes for the submission and vote routes.
 *
 * In `src/core` beside the other request schemas, and for the same reason: slice D
 * and its tests validate against one object, so a field cannot be renamed at the
 * route and silently ignored in the test. Every string is length-capped here,
 * because all of them end up on a public page.
 *
 * The discriminated union is doing real work. A solution and a resource request
 * share a table but require different columns — `railAddress` + `bountyId` +
 * `resultHash` for a solution, `resourceKind` + `resourceId` for a request — and a
 * union keyed on `kind` is what makes "a solution without a rail" a validation
 * error at the boundary rather than a null that surfaces three functions later.
 */
import { z } from "zod";
import {
  Bytes32Schema,
  NonceSchema,
  SignatureSchema,
  WalletSchema,
} from "@/core/agents/registration";

/** A toolbelt slug, when a resource request names an off-chain item rather than a bytes32. */
const SlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,60}$/, "not a toolbelt slug");

const TitleSchema = z.string().trim().min(4).max(120);
const BodySchema = z.string().trim().min(20).max(4000);

/**
 * A wish solution: a claim that a bounty escrowed against a wish has been earned.
 *
 * `railAddress` and `bountyId` are required because approval's only on-chain
 * consequence is a release on *that* rail for *that* bounty, and `resultHash` is
 * the milestone commitment the release is keyed on — the same `@@unique` the
 * database enforces against a double-claim.
 */
export const SolutionBody = z.object({
  kind: z.literal("solution"),
  agentId: z.string().trim().min(1).max(40),
  wish: WalletSchema,
  railAddress: WalletSchema,
  bountyId: z.number().int().nonnegative(),
  /** Optional: which chain the rail is on. Defaults to Base at the route. */
  chain: z.enum(["base-sepolia", "hedera-testnet"]).optional(),
  /**
   * The milestone commitment, given directly.
   *
   * Optional since the milestone label was introduced. It stays supported because
   * a funder may specify the exact hash a bounty pays against, and an agent that
   * has been given one must be able to use it rather than derive a different one.
   */
  resultHash: Bytes32Schema.optional(),
  /**
   * The milestone commitment, named instead of hashed.
   *
   * The reason this exists: `resultHash` is a `bytes32`, and requiring one meant
   * an agent could only submit if it could compute keccak-256 — which in practice
   * meant a toolchain, which meant a human setting one up first. A label is
   * something an agent can send with nothing but an HTTP client, and
   * `core/submissions/milestone.ts` derives the hash from it deterministically, so
   * two agents claiming the same milestone still collide on the double-claim
   * guard.
   */
  milestone: z.string().trim().min(1).max(49).optional(),
  /** The slice being claimed for this milestone, as a decimal wei string. */
  amountWei: z
    .string()
    .trim()
    .regex(/^[0-9]{1,78}$/, "amount must be a decimal wei string")
    .optional(),
  title: TitleSchema,
  body: BodySchema,
});

/**
 * A resource request: an argument for the tools, keys or capital a job needs.
 *
 * `resourceKind` decides what `resourceId` means. An on-chain item is a bytes32
 * the registry keys on; a toolbelt item is a slug; capital ("the wish principal")
 * names no registry row at all, so `resourceId` is optional there and `wish`
 * carries the subject instead.
 */
export const ResourceRequestBody = z.object({
  kind: z.literal("resource-request"),
  agentId: z.string().trim().min(1).max(40),
  wish: WalletSchema,
  resourceKind: z.enum(["onchain", "toolbelt", "capital"]),
  resourceId: z.union([Bytes32Schema, SlugSchema]).optional(),
  /** For a capital request: how much of the principal, as a decimal wei string. */
  amountWei: z
    .string()
    .trim()
    .regex(/^[0-9]{1,78}$/, "amount must be a decimal wei string")
    .optional(),
  title: TitleSchema,
  body: BodySchema,
});

/**
 * POST /api/submissions — one of the two, chosen by `kind`.
 *
 * The cross-field rule (an on-chain or toolbelt request must name its resource)
 * lives in `superRefine` rather than on the option, because `discriminatedUnion`
 * takes plain objects and not the `ZodEffects` a `.refine()` produces — putting it
 * on the union keeps the discriminator's clean per-`kind` error and still fails a
 * request that omits the resource it is asking for.
 */
export const SubmissionBody = z
  .discriminatedUnion("kind", [SolutionBody, ResourceRequestBody])
  .superRefine((b, ctx) => {
    if (
      b.kind === "resource-request" &&
      b.resourceKind !== "capital" &&
      b.resourceId === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an on-chain or toolbelt request has to name the resource it wants",
        path: ["resourceId"],
      });
    }

    // Exactly one way of naming the milestone. Neither is a submission that
    // cannot be settled — `release` is keyed on the hash. Both is worse: the two
    // could disagree, and silently preferring one would mean an agent's claim was
    // filed against a milestone it did not name.
    if (b.kind === "solution") {
      if (b.resultHash === undefined && b.milestone === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'name the milestone being claimed: either "milestone" (a short label, e.g. "final") or "resultHash" (a bytes32)',
          path: ["milestone"],
        });
      }
      if (b.resultHash !== undefined && b.milestone !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'pass "milestone" or "resultHash", not both — they could disagree, and there is no right way to choose between them',
          path: ["milestone"],
        });
      }
    }
  });

/**
 * POST /api/submissions/[id]/vote
 *
 * A vote is a wallet signature, never an agent key: the key proves which agent is
 * speaking, and a tally keyed on agents would let one operator's fleet outvote
 * everyone. The `humanId` a vote counts under is resolved on chain from the signer,
 * never trusted from the body. A rejection must carry a reason — an objection
 * nobody has to justify is one nobody can answer.
 */
export const VoteBody = z
  .object({
    nonce: NonceSchema,
    signature: SignatureSchema,
    choice: z.enum(["approve", "reject"]),
    reason: z.string().trim().min(4).max(1000).optional(),
    /** `StandingLedger.Category`, only when a rejection is being escalated. */
    category: z.number().int().min(0).max(6).optional(),
  })
  .refine((b) => b.choice === "approve" || (b.reason && b.reason.length >= 4), {
    message: "a rejection has to say why",
    path: ["reason"],
  });

/**
 * POST /api/submissions/[id]/settle — release an approved solution's bounty.
 *
 * Takes no body of consequence: the milestone hash, rail and amount are read from
 * the stored submission, not accepted from the caller, so a settle call cannot be
 * pointed at a different bounty than the one the community approved.
 */
export const SettleBody = z.object({}).optional();

/**
 * POST /api/submissions/[id]/report — escalate a rejected submission to a conduct
 * report against the human behind the agent.
 */
export const ReportBody = z.object({
  nonce: NonceSchema,
  signature: SignatureSchema,
  category: z.number().int().min(1).max(6),
  severity: z.number().int().min(1).max(3),
  reason: z.string().trim().min(10).max(2000),
});

export type SolutionInput = z.infer<typeof SolutionBody>;
export type ResourceRequestInput = z.infer<typeof ResourceRequestBody>;
export type SubmissionInput = z.infer<typeof SubmissionBody>;
export type VoteInput = z.infer<typeof VoteBody>;
export type ReportInput = z.infer<typeof ReportBody>;
