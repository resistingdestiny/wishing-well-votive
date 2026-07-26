/**
 * The one derivation of a `bytes32` resource id, shared by every half of the
 * system that has to agree on one.
 *
 * Three places need the same word: this app quoting `ResourceRegistry.quote`, the
 * Foundry script that calls `register`, and the agent asking for access. If any
 * two of them derive it differently the mismatch does not fail loudly — the
 * registry answers `NoSuchResource` for an id nobody registered, which on screen
 * reads as "this resource is not available to you". That is a sentence about the
 * operator, produced by a bug in our hashing.
 *
 * The prefix and the encoding are therefore fixed here and mirrored in
 * `contracts/script/RegisterResources.s.sol`, which computes
 * `keccak256(bytes(string.concat("resource:", slug)))` — the same bytes Solidity's
 * `keccak256` would see. `ops/demo-seed.sh` already derives the corpus id this way
 * (`cast keccak "resource:linear-a-corpus-api"`), and the resource it registered
 * is live on Base Sepolia, so the prefix is not a new convention — it is the
 * existing one, written down.
 */
import { keccak256, toBytes } from "viem";

export const RESOURCE_ID_PREFIX = "resource:";

/** Lowercase, digits and single dashes. Anything else would let two slugs that a
 *  human reads as one thing hash to two different resources. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isResourceSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && slug.length <= 64;
}

/**
 * `keccak256("resource:" + slug)`.
 *
 * @throws on a slug that is not in canonical form, rather than hashing it anyway.
 *         A typo that silently produces a valid-looking id is exactly how the two
 *         halves come apart.
 */
export function resourceIdOf(slug: string): `0x${string}` {
  if (!isResourceSlug(slug)) {
    throw new Error(`not a canonical resource slug: ${JSON.stringify(slug)}`);
  }
  return keccak256(toBytes(`${RESOURCE_ID_PREFIX}${slug}`));
}

/**
 * The id of the resource that is already registered on Base Sepolia, pinned.
 *
 * Read back with `cast call $NEXT_PUBLIC_WELL_RESOURCE_REGISTRY
 * 'resourceOf(bytes32)((address,uint32,uint8,bool,bytes32))' <id>` — it answers
 * with a live provider, baseLimit 5, minAssurance 1. If a refactor changes the
 * derivation, this constant stops matching and the tests say so, rather than the
 * page quietly reporting an unregistered resource.
 */
export const KNOWN_RESOURCE_IDS: Readonly<Record<string, `0x${string}`>> = {
  "linear-a-corpus-api": "0xe44c63e7d1eea5287ebd7ebc0dcd76b10338de54ffab1cc2012b7499cf706dd7",
};
