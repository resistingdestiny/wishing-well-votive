/**
 * Request shapes for the agent registration and key routes.
 *
 * Kept in `src/core` rather than beside the routes so slices B and D validate
 * against the same object the tests do, and so a field cannot be renamed in one
 * place and silently ignored in another.
 *
 * zod rather than the hand-rolled `trim()`-and-check style used by the older
 * `api/agents` and `api/resources/*` routes: those spread the same address regex
 * across five files and have already drifted on casing. Every string here is
 * length-capped at the boundary, because the values end up on a page.
 */
import { z } from "zod";

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Lowercased at the boundary, once.
 *
 * `Watch` and `Notification` store lowercase while `Story.cell` stores a
 * checksummed address, and `wish/[address]/page.tsx` has to query twice to cope.
 * Everything the agent platform writes is lowercase, and this is the only place
 * that decision is applied.
 */
export const WalletSchema = z
  .string()
  .trim()
  .regex(ADDRESS_RE, "not a wallet address")
  .transform((s) => s.toLowerCase());

export const Bytes32Schema = z
  .string()
  .trim()
  .regex(BYTES32_RE, "not a 32-byte hex value")
  .transform((s) => s.toLowerCase());

export const SignatureSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{2,}$/, "not a signature")
  .max(400);

export const NonceSchema = z.string().trim().min(8).max(64);

export const ChallengePurposeSchema = z.enum([
  "register",
  "verify-world",
  "issue-key",
  "revoke-key",
  "vote",
]);

/** POST /api/agents/challenge */
export const ChallengeBody = z.object({
  wallet: WalletSchema,
  purpose: ChallengePurposeSchema,
  agentId: z.string().trim().max(40).optional(),
  subject: z.string().trim().max(120).optional(),
});

/** POST /api/agents/register */
export const RegisterBody = z.object({
  nonce: NonceSchema,
  signature: SignatureSchema,
  displayName: z.string().trim().min(2).max(60),
  summary: z.string().trim().min(10).max(400),
  /** Defaults to the signing wallet when absent. */
  ownerWallet: WalletSchema.optional(),
});

/** POST /api/agents/keys */
export const IssueKeyBody = z.object({
  nonce: NonceSchema,
  signature: SignatureSchema,
  agentId: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(80),
});

/**
 * POST /api/agents/keys/revoke
 *
 * Either half authorises: the owner's signature over a challenge, or the secret
 * itself. The second is the fail-safe — whoever holds a leaked key can always
 * destroy it, including from a machine with no wallet on it. It is deliberately
 * one-directional: a secret can revoke, and can never mint.
 */
export const RevokeKeyBody = z
  .object({
    keyId: z.string().trim().regex(/^[0-9a-f]{16}$/).optional(),
    nonce: NonceSchema.optional(),
    signature: SignatureSchema.optional(),
    /** The whole `vsk_…` token. Never logged, never echoed back. */
    token: z.string().trim().max(120).optional(),
  })
  .refine((b) => (b.keyId && b.nonce && b.signature) || b.token, {
    message: "provide either a signed challenge for a keyId, or the key itself",
  });

/** POST /api/agents/verify — mirror a World lookup onto Base. */
export const VerifyWorldBody = z.object({
  nonce: NonceSchema,
  signature: SignatureSchema,
  agentId: z.string().trim().min(1).max(40),
});

export type ChallengeInput = z.infer<typeof ChallengeBody>;
export type RegisterInput = z.infer<typeof RegisterBody>;
export type IssueKeyInput = z.infer<typeof IssueKeyBody>;
export type RevokeKeyInput = z.infer<typeof RevokeKeyBody>;
export type VerifyWorldInput = z.infer<typeof VerifyWorldBody>;

/** The shape `/api/agents/me` answers with. Never carries a secret. */
export interface AgentPublic {
  id: string;
  wallet: string;
  ownerWallet: string;
  displayName: string;
  summary: string;
  status: string;
  createdAt: string;
  keys: {
    keyId: string;
    label: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
    locked: boolean;
  }[];
}
