import { keccak256, toHex, encodeAbiParameters, concat, pad, type Hex } from "viem";
import { z } from "zod";

/**
 * Off-chain builder for a wish's beneficiary set — the identity/union half of the
 * fiat-rails addendum. A beneficiary is either a wallet address or an identity
 * descriptor (a real person named by full name / DOB / relationship, who claims
 * later after KYC). The set is committed on chain as a single Merkle root
 * (`StorySchema.beneficiariesRoot`); personal data never goes on chain — only the
 * keccak of the descriptor inside a leaf.
 *
 * The encoding mirrors WishCellBase EXACTLY (see BENEFICIARY_ADDRESS_TAG /
 * BENEFICIARY_IDENTITY_TAG + _beneficiaryLeaf):
 *
 *   tag    = keccak256("WishBeneficiary.<kind>.v1")
 *   key    = bytes32(uint256(uint160(addr)))  |  descriptorHash
 *   leaf   = keccak256(bytes.concat(keccak256(abi.encode(index, tag, key, weight))))
 *   parent = commutative keccak256 (OZ MerkleProof: sorted 32-byte pair)
 *
 * so proofs built here verify on chain in {claimBeneficiary} / {recordIdentityClaim}.
 */

const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address");

/** A real person named by identity, not by wallet. Hashed on chain, encrypted off. */
export const IdentityDescriptorSchema = z.object({
  fullName: z.string().min(1),
  /** ISO date, YYYY-MM-DD. */
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Relationship to the wisher ("daughter", "son", "friend", …). */
  relationship: z.string().min(1),
  /** Optional contact hint to help locate/verify them later (email, phone, note). */
  contactHint: z.string().optional(),
});
export type IdentityDescriptor = z.infer<typeof IdentityDescriptorSchema>;

export const BeneficiarySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("wallet"),
    address: AddressSchema,
    /** Share of the pot (default 1 → equal split). */
    weight: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("identity"),
    descriptor: IdentityDescriptorSchema,
    weight: z.number().int().positive().optional(),
  }),
]);
export type Beneficiary = z.infer<typeof BeneficiarySchema>;

/** Must match WishCellBase.BENEFICIARY_ADDRESS_TAG / BENEFICIARY_IDENTITY_TAG. */
export const BENEFICIARY_ADDRESS_TAG: Hex = keccak256(toHex("WishBeneficiary.address.v1"));
export const BENEFICIARY_IDENTITY_TAG: Hex = keccak256(toHex("WishBeneficiary.identity.v1"));

export const ZERO_BENEFICIARIES_ROOT = ("0x" + "0".repeat(64)) as Hex;

/**
 * Stable, PII-hiding commitment to an identity descriptor. The contract never
 * recomputes this — it only checks the committed leaf — so any deterministic
 * one-way hash of the descriptor is sound. Domain-tagged and field-ordered.
 */
export function descriptorHash(d: IdentityDescriptor): Hex {
  return keccak256(
    toHex(
      ["WishDescriptor.v1", d.fullName, d.dateOfBirth, d.relationship, d.contactHint ?? ""].join("\n"),
    ),
  );
}

/** The 32-byte leaf key for a beneficiary: padded address, or the descriptor hash. */
export function beneficiaryKey(b: Beneficiary): Hex {
  return b.kind === "wallet" ? pad(b.address as Hex, { size: 32 }) : descriptorHash(b.descriptor);
}

function tagFor(b: Beneficiary): Hex {
  return b.kind === "wallet" ? BENEFICIARY_ADDRESS_TAG : BENEFICIARY_IDENTITY_TAG;
}

export interface BeneficiaryLeaf {
  index: number;
  kind: Beneficiary["kind"];
  tag: Hex;
  key: Hex;
  weight: bigint;
  /** Populated for a wallet leaf. */
  address?: Hex;
  /** Populated for an identity leaf. */
  descriptorHash?: Hex;
}

export interface BeneficiaryTree {
  root: Hex;
  totalWeight: bigint;
  /** The signed schema commitment binding the root AND the total weight. */
  commitment: Hex;
  leaves: BeneficiaryLeaf[];
  /** proofs[i] is the Merkle proof for leaves[i]. */
  proofs: Hex[][];
}

/**
 * The `StorySchema.beneficiariesRoot` commitment: binds the Merkle root AND the
 * total leaf weight, so the on-chain resolution (`fulfilToBeneficiaries`) cannot
 * skew the allocation denominator. Matches WishCellBase's
 * `keccak256(abi.encode(merkleRoot, totalWeight))`.
 */
export function beneficiariesCommitment(root: Hex, totalWeight: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [root, totalWeight]));
}

/** Double-hashed leaf, matching the contract's `_beneficiaryLeaf`. */
export function beneficiaryLeafHash(l: { index: number; tag: Hex; key: Hex; weight: bigint }): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
      [BigInt(l.index), l.tag, l.key, l.weight],
    ),
  );
  return keccak256(inner);
}

/** Commutative (sorted) pair hash — identical to OZ MerkleProof's default. */
function hashPair(a: Hex, b: Hex): Hex {
  return a.toLowerCase() <= b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/**
 * Build the canonical beneficiary tree. Index is the position in the input array
 * (stable), weight defaults to 1 (equal split). An empty set yields the zero root
 * — a wish with no identity/union beneficiaries then uses the single-`beneficiary`
 * direct-pay path on chain.
 */
export function buildBeneficiaries(beneficiaries: Beneficiary[]): BeneficiaryTree {
  const leaves: BeneficiaryLeaf[] = beneficiaries.map((b, index) => {
    const weight = BigInt(b.weight ?? 1);
    const tag = tagFor(b);
    const key = beneficiaryKey(b);
    return {
      index,
      kind: b.kind,
      tag,
      key,
      weight,
      ...(b.kind === "wallet" ? { address: b.address as Hex } : { descriptorHash: key }),
    };
  });
  const totalWeight = leaves.reduce((s, l) => s + l.weight, 0n);
  if (leaves.length === 0) {
    return { root: ZERO_BENEFICIARIES_ROOT, totalWeight: 0n, commitment: ZERO_BENEFICIARIES_ROOT, leaves, proofs: [] };
  }

  const layers: Hex[][] = [leaves.map(beneficiaryLeafHash)];
  let cur = layers[0] as Hex[];
  while (cur.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i] as Hex;
      if (i + 1 < cur.length) next.push(hashPair(a, cur[i + 1] as Hex));
      else next.push(a); // promote unpaired node
    }
    layers.push(next);
    cur = next;
  }
  const root = cur[0] as Hex;

  const proofs: Hex[][] = leaves.map((_, index) => {
    const proof: Hex[] = [];
    let idx = index;
    for (let l = 0; l < layers.length - 1; l++) {
      const layer = layers[l] as Hex[];
      const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
      const s = layer[sib];
      if (s !== undefined) proof.push(s);
      idx = Math.floor(idx / 2);
    }
    return proof;
  });

  return { root, totalWeight, commitment: beneficiariesCommitment(root, totalWeight), leaves, proofs };
}

/** TS mirror of OZ MerkleProof.verify — self-checks built proofs. */
export function verifyBeneficiaryLeaf(
  root: Hex,
  leaf: { index: number; tag: Hex; key: Hex; weight: bigint },
  proof: Hex[],
): boolean {
  let h = beneficiaryLeafHash(leaf);
  for (const p of proof) h = hashPair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}
