/**
 * The agent secret: how it is minted, how it is stored, and how it is checked.
 *
 * Pure by design — no database, no environment, no clock. Everything here is a
 * function of its arguments, which is what makes the properties below testable
 * without standing a server up.
 *
 * **Why HMAC and not scrypt.** `src/lib/pii.ts` derives its key with `scryptSync`
 * and is right to: its input is an operator's passphrase, which is low-entropy
 * and worth making expensive to guess. This input is 32 bytes from a CSPRNG. The
 * cost of searching it is set by the entropy, not by the KDF, and no amount of
 * memory-hardness moves 2^256. What a memory-hard hash *would* buy is a denial of
 * service: it sits on the authentication path of every agent submission, so
 * anyone with a socket could spend ~100 ms of our CPU per forged request. HMAC is
 * microseconds.
 *
 * **What the pepper is for.** The salt stops one precomputed table covering every
 * row. The pepper — an environment secret, never in the database — stops an
 * attacker holding a database dump from even *confirming* a correct guess, since
 * without the HMAC key they cannot compute the digest for a candidate at all.
 * That is the difference between a leaked dump being an inconvenience and it
 * being a set of working credentials.
 *
 * `HASH_VERSION` is stored alongside every digest so this decision can be revised
 * without a flag day: a future scheme lands as a new version, and rows migrate as
 * their keys are next used.
 */
import crypto from "node:crypto";

/** The public shape of a key. `vsk_` — votive secret key. */
export const AGENT_KEY_RE = /^vsk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/;

export const HASH_VERSION = "hmac-sha256-v1";

/** 8 bytes → 16 hex characters. Public: it names the row, it does not open it. */
const KEY_ID_BYTES = 8;
/** 32 bytes → 43 base64url characters. The entire security of the scheme. */
const SECRET_BYTES = 32;
/** Fixed width, so `salt ‖ secret` cannot be ambiguous between two records. */
const SALT_BYTES = 16;
/** SHA-256. Exported so a test can build a wrong digest of the right length. */
export const DIGEST_BYTES = 32;

export interface IssuedAgentKey {
  /** Public identifier, safe to log and to show in a roster. */
  keyId: string;
  /** The 43-character secret half. Shown to the holder once and never stored. */
  secret: string;
  /** What the holder actually presents: `vsk_<keyId>_<secret>`. */
  token: string;
  /** base64 of `SALT_BYTES` random bytes. Stored beside the digest. */
  salt: string;
}

/**
 * Mint a key.
 *
 * `randomBytes` and not `Math.random`, `randomUUID`, or a timestamp: this is the
 * one value in the system whose unpredictability is the whole point.
 */
export function generateAgentKey(): IssuedAgentKey {
  const keyId = crypto.randomBytes(KEY_ID_BYTES).toString("hex");
  const secret = crypto.randomBytes(SECRET_BYTES).toString("base64url");
  const salt = crypto.randomBytes(SALT_BYTES).toString("base64");
  return { keyId, secret, token: `vsk_${keyId}_${secret}`, salt };
}

/**
 * Split a presented token into the half that identifies and the half that proves.
 *
 * Returns `null` rather than throwing, and rejects anything that does not match
 * the exact shape. A malformed token must cost a regex and a database lookup that
 * never happens — not an exception unwinding through an authentication handler.
 */
export function parseAgentKey(token: string): { keyId: string; secret: string } | null {
  if (typeof token !== "string") return null;
  const t = token.trim();
  if (!AGENT_KEY_RE.test(t)) return null;
  // "vsk_" is 4 characters, the key id is the next 16, then one underscore.
  return { keyId: t.slice(4, 20), secret: t.slice(21) };
}

/**
 * The value that goes in the database: base64 of HMAC-SHA-256(pepper, salt ‖ secret).
 *
 * Throws on a missing pepper or a wrong-width salt rather than hashing something
 * weaker. A digest computed with an empty pepper would verify happily and would
 * be worth nothing against a dump; failing loudly is the only safe direction.
 */
export function hashAgentKey(secret: string, saltB64: string, pepper: string): string {
  if (!pepper) throw new Error("agent key pepper is required");
  const salt = Buffer.from(saltB64, "base64");
  if (salt.length !== SALT_BYTES) {
    throw new Error(`agent key salt must be ${SALT_BYTES} bytes`);
  }
  const mac = crypto.createHmac("sha256", pepper);
  mac.update(salt);
  mac.update(Buffer.from(secret, "utf8"));
  return mac.digest("base64");
}

/**
 * Whether `secret` is the one behind `storedB64`.
 *
 * Two properties hold here and both matter:
 *
 *   The comparison is `timingSafeEqual`, which reads every byte of both buffers
 *   whatever it finds in the first. A `===` on digests leaks, one byte at a time,
 *   how much of a guess was right — and an attacker who can measure that does not
 *   need to search 2^256, they need to search 32 × 256.
 *
 *   A malformed or wrong-width stored value does not take an early return. It is
 *   compared against a zero buffer of the correct width, so a corrupt row costs
 *   the same observable work as a wrong secret and cannot be told apart from one.
 *
 * Never throws: every failure mode is `false`.
 */
export function agentKeyMatches(
  storedB64: string,
  secret: string,
  saltB64: string,
  pepper: string,
): boolean {
  let computed: Buffer;
  try {
    computed = Buffer.from(hashAgentKey(secret, saltB64, pepper), "base64");
  } catch {
    return false;
  }
  const stored = Buffer.from(storedB64 ?? "", "base64");
  const wellFormed = stored.length === computed.length;
  // Length is not a secret — the digest width is a published constant — so
  // substituting a placeholder here leaks nothing, and it keeps the expensive
  // half of the comparison unconditional.
  const candidate = wellFormed ? stored : Buffer.alloc(computed.length);
  const equal = crypto.timingSafeEqual(candidate, computed);
  return wellFormed && equal;
}

/**
 * A digest that no presented secret will ever match.
 *
 * Used when the key id in a request names no row at all. Without it, an unknown
 * key id returns in the time of a database miss while a known one pays for an
 * HMAC, and that difference turns the endpoint into an oracle for which key ids
 * exist. The decoy is minted per process from random bytes, so it is not a fixed
 * value an attacker could recognise either.
 */
export function decoyMaterial(pepper: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(SALT_BYTES).toString("base64");
  const secret = crypto.randomBytes(SECRET_BYTES).toString("base64url");
  return { hash: hashAgentKey(secret, salt, pepper), salt };
}
