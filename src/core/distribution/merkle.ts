import { keccak256, encodeAbiParameters, concat, type Hex } from "viem";

/**
 * Off-chain builder for a DistributeToActive snapshot: turns the on-chain active
 * set (each active cell's payee + parked weight, filtered to one asset) into a
 * Merkle root the cell verifies claims against. The encoding mirrors
 * WishCellBase.claimDistribution EXACTLY:
 *
 *   leaf   = keccak256(bytes.concat(keccak256(abi.encode(index, account, weight))))
 *   parent = commutative keccak256 (OpenZeppelin MerkleProof: sorted 32-byte pair)
 *
 * so proofs produced here verify on chain with no shape assumptions. Any leaf
 * count is supported (unpaired nodes are promoted), removing the old 128 cap.
 */

export interface DistributionEntry {
  account: `0x${string}`;
  weight: bigint;
}

export interface DistributionLeaf {
  index: number;
  account: `0x${string}`;
  weight: bigint;
}

export interface DistributionTree {
  root: Hex;
  totalWeight: bigint;
  leaves: DistributionLeaf[];
  /** proofs[i] is the Merkle proof for leaves[i]. */
  proofs: Hex[][];
}

const ZERO_ROOT = ("0x" + "0".repeat(64)) as Hex;

/** Double-hashed leaf, matching the contract's `_leaf`. */
export function leafHash(l: DistributionLeaf): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [BigInt(l.index), l.account, l.weight],
    ),
  );
  return keccak256(inner);
}

/** Commutative (sorted) pair hash — identical to OZ MerkleProof's default. */
function hashPair(a: Hex, b: Hex): Hex {
  return a.toLowerCase() <= b.toLowerCase()
    ? keccak256(concat([a, b]))
    : keccak256(concat([b, a]));
}

/**
 * Build the canonical distribution tree. Zero-weight entries are dropped (they
 * would claim nothing); order is preserved so the index in each leaf is stable.
 * An empty set yields the zero root — the cell then returns the pot to its wisher.
 */
export function buildDistribution(entries: DistributionEntry[]): DistributionTree {
  const leaves: DistributionLeaf[] = entries
    .filter((e) => e.weight > 0n)
    .map((e, index) => ({ index, account: e.account, weight: e.weight }));
  const totalWeight = leaves.reduce((s, l) => s + l.weight, 0n);
  if (leaves.length === 0) {
    return { root: ZERO_ROOT, totalWeight: 0n, leaves, proofs: [] };
  }

  // Layered tree with odd-node promotion.
  const layers: Hex[][] = [leaves.map(leafHash)];
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

  return { root, totalWeight, leaves, proofs };
}

/**
 * §5 Securities-safe DistributeToActive default. Instead of pooling the whole pot
 * pro-rata across every active wisher (the "profit from others' effort" prong that
 * risks a collective-investment-scheme classification), this returns THIS wish's
 * own principal to its wisher and routes only the realised OVERFLOW (proceeds above
 * principal) to a transparent public destination (treasury / named charity). No one
 * profits from anyone else's effort. When there is no overflow, or no distinct
 * public destination is configured, the wisher simply gets the whole remainder
 * back — still safe (their own money, no pooling). The pro-rata-to-contributors
 * pooling remains available as an accredited-only opt-in (built via buildDistribution).
 *
 * Weights are proportions the on-chain remainder scales to: wisher:principal,
 * public:overflow. (Exact principal-vs-profit accounting would need on-chain logic;
 * the load-bearing property here is that the profit never reaches other wishers.)
 */
export function buildSecuritiesSafeDistribution(
  wisher: Hex,
  principal: bigint,
  overflow: bigint,
  publicDest: Hex,
): DistributionTree {
  const samePayee = publicDest.toLowerCase() === wisher.toLowerCase();
  const entries: DistributionEntry[] =
    overflow > 0n && !samePayee
      ? [
          { account: wisher, weight: principal },
          { account: publicDest, weight: overflow },
        ]
      : [{ account: wisher, weight: principal + overflow }];
  return buildDistribution(entries);
}

/** TS mirror of OZ MerkleProof.verify — used to self-check built proofs. */
export function verifyLeaf(root: Hex, leaf: DistributionLeaf, proof: Hex[]): boolean {
  let h = leafHash(leaf);
  for (const p of proof) h = hashPair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}
