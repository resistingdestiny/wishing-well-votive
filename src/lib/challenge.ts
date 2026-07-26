/**
 * One signature format for every privileged act a human performs.
 *
 * **Why registration needs a signature at all.** Without one, anybody can
 * register a stranger's address, receive a working key bound to it, and wait. The
 * moment that stranger verifies with World, the attacker is holding a credential
 * for a human-backed — and therefore payable — wallet. Proving control of the
 * address is not a nicety here; it is the only thing standing between an open
 * form and an identity theft with a payout attached.
 *
 * **Why our own message and not AgentKit's `formatSIWEMessage`.** AgentKit's
 * validator compares the message's `domain` against `new URL(uri).hostname`,
 * which drops the port — so `127.0.0.1:3200` and `127.0.0.1:3100` are the same
 * domain to it and neither matches a `domain` that carries the port. That is a
 * live hazard on demo day for no benefit: viem's `verifyMessage` handles plain
 * EOAs and ERC-1271 smart wallets, has no opinion about domains, and is already
 * a dependency. AgentKit is used for the one thing only it can do — the AgentBook
 * lookup in `worldVerify.ts`.
 *
 * **Why the message is built server-side.** The client contributes a signature
 * and nothing else. If the client supplied the text it signed, it could sign
 * "issue a key for agent X" and present it as consent for something else; the
 * nonce would still be valid and the address would still check out. The purpose
 * and the subject are ours to state, so what was consented to is never in doubt.
 *
 * **Why `Origin` comes from an environment variable.** Taking it from the `Host`
 * header would let a caller choose what the message says the signature was for,
 * which defeats the point of stating it.
 */
import { createPublicClient, http, recoverMessageAddress, type Chain } from "viem";
import crypto from "node:crypto";
import { prisma } from "@/lib/db";

export type ChallengePurpose =
  | "register"
  | "verify-world"
  | "issue-key"
  | "revoke-key"
  | "vote";

const PURPOSES: Record<ChallengePurpose, string> = {
  register: "Register this wallet as an agent on Votive.",
  "verify-world": "Link this agent to the verified human behind it.",
  "issue-key": "Issue a new secret key for this agent.",
  "revoke-key": "Revoke a secret key for this agent.",
  vote: "Cast a vote on this submission.",
};

export function isChallengePurpose(v: string): v is ChallengePurpose {
  return Object.prototype.hasOwnProperty.call(PURPOSES, v);
}

/**
 * How long a challenge is good for.
 *
 * Long enough that a hardware wallet's confirmation screen is not a race, short
 * enough that a signature left in a terminal's scrollback stops being useful.
 */
export const CHALLENGE_TTL_MS = 10 * 60_000;

const chainId = Number(process.env.NEXT_PUBLIC_WELL_CHAIN_ID ?? 84532);

const CHAIN: Chain = {
  id: chainId,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_WELL_RPC_URL ?? "https://sepolia.base.org"] },
  },
};

function publicOrigin(): string {
  return process.env.WELL_PUBLIC_ORIGIN ?? "http://127.0.0.1:3100";
}

export function normaliseWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

/**
 * The exact bytes the wallet is asked to sign.
 *
 * Kept as one function so the text minted and the text verified cannot drift —
 * the message is rebuilt from the stored row at verification time rather than
 * taken from the request, so a caller cannot present a signature over different
 * words than the ones we issued.
 */
export function challengeMessage(row: {
  wallet: string;
  purpose: ChallengePurpose;
  subject?: string | null;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  const lines = [
    "Votive",
    PURPOSES[row.purpose],
    "",
    `Wallet: ${row.wallet}`,
    `Purpose: ${row.purpose}`,
  ];
  if (row.subject) lines.push(`Subject: ${row.subject}`);
  lines.push(
    `Nonce: ${row.nonce}`,
    `Issued: ${row.issuedAt.toISOString()}`,
    `Expires: ${row.expiresAt.toISOString()}`,
    `Chain: eip155:${chainId}`,
    `Origin: ${publicOrigin()}`,
  );
  return lines.join("\n");
}

export async function mintChallenge(input: {
  wallet: string;
  purpose: ChallengePurpose;
  agentId?: string;
  subject?: string;
}): Promise<{ nonce: string; message: string; expiresAt: string }> {
  const wallet = normaliseWallet(input.wallet);
  const nonce = crypto.randomBytes(16).toString("base64url");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);

  await prisma.agentVerification.create({
    data: {
      agentId: input.agentId ?? null,
      wallet,
      purpose: input.purpose,
      subject: input.subject ?? null,
      nonce,
      issuedAt,
      expiresAt,
      outcome: "issued",
    },
  });

  return {
    nonce,
    message: challengeMessage({
      wallet,
      purpose: input.purpose,
      subject: input.subject ?? null,
      nonce,
      issuedAt,
      expiresAt,
    }),
    expiresAt: expiresAt.toISOString(),
  };
}

export type ConsumeFailure =
  | "unknown-nonce"
  | "expired"
  | "already-used"
  | "wrong-purpose"
  | "bad-signature";

export type ConsumeResult =
  | { ok: true; wallet: string; verificationId: string; subject?: string }
  | { ok: false; reason: ConsumeFailure };

/**
 * Verify a signature over a challenge we issued, and burn the nonce.
 *
 * The nonce is stamped `consumedAt` **on presentation, not on success**. A nonce
 * that survived a failed attempt would let an attacker grind signatures against
 * one challenge; burning it on sight means every attempt costs a fresh round trip
 * that we control the rate of.
 *
 * EOA recovery is tried first and needs no network. The on-chain ERC-1271 path is
 * only reached for smart-contract wallets, so an RPC outage cannot break signing
 * for the ordinary case. When that path *is* reached and the RPC is unreachable,
 * the caller is told `bad-signature` — the result union is fixed so slices B and
 * D can exhaust it — but the row records what actually happened in
 * `failureReason`, so the difference is never lost, only summarised.
 */
export async function consumeChallenge(input: {
  nonce: string;
  signature: string;
  purpose: ChallengePurpose;
}): Promise<ConsumeResult> {
  const row = await prisma.agentVerification.findUnique({ where: { nonce: input.nonce } });
  if (!row) return { ok: false, reason: "unknown-nonce" };

  // Burn first, and burn in one statement. Reading `consumedAt` and then writing
  // it leaves a gap in which two requests presenting the same nonce can both find
  // it unused and both be honoured — which is the whole of "single use" lost to a
  // race. Putting `consumedAt: null` in the filter makes the claim itself the
  // check: exactly one caller can see a non-zero count.
  const claimed = await prisma.agentVerification.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: new Date(), signature: input.signature.slice(0, 400) },
  });
  if (claimed.count === 0) return { ok: false, reason: "already-used" };

  const fail = async (
    reason: ConsumeFailure,
    outcome: string,
    detail?: string,
  ): Promise<ConsumeResult> => {
    await prisma.agentVerification.update({
      where: { id: row.id },
      data: { outcome, failureReason: detail ?? null },
    });
    return { ok: false, reason };
  };

  if (row.purpose !== input.purpose) {
    return fail("wrong-purpose", "signature-failed", `challenge was for ${row.purpose}`);
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    return fail("expired", "signature-failed", "challenge expired before it was presented");
  }

  const message = challengeMessage({
    wallet: row.wallet,
    purpose: row.purpose as ChallengePurpose,
    subject: row.subject,
    nonce: row.nonce,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
  });

  const signature = input.signature as `0x${string}`;

  let matched = false;
  try {
    const recovered = await recoverMessageAddress({ message, signature });
    matched = recovered.toLowerCase() === row.wallet;
  } catch {
    // Not a recoverable 65-byte signature. It may still be an ERC-1271 wallet.
  }

  if (!matched) {
    try {
      const client = createPublicClient({ chain: CHAIN, transport: http() });
      matched = await client.verifyMessage({
        address: row.wallet as `0x${string}`,
        message,
        signature,
      });
    } catch (e) {
      return fail(
        "bad-signature",
        "signature-failed",
        `contract signature check unreachable: ${(e as Error).message}`.slice(0, 300),
      );
    }
  }

  if (!matched) {
    return fail("bad-signature", "signature-failed", "signature did not recover to the wallet");
  }

  await prisma.agentVerification.update({ where: { id: row.id }, data: { outcome: "ok" } });
  return {
    ok: true,
    wallet: row.wallet,
    verificationId: row.id,
    ...(row.subject ? { subject: row.subject } : {}),
  };
}
