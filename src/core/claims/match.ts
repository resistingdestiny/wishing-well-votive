import type { Hex } from "viem";
import {
  buildBeneficiaries,
  type Beneficiary,
  type IdentityDescriptor,
  type BeneficiaryLeaf,
} from "../schema/beneficiaries.js";

export interface ClaimPlanItem {
  index: number;
  kind: Beneficiary["kind"];
  weight: bigint;

  leaf: BeneficiaryLeaf;
  proof: Hex[];

  descriptor?: IdentityDescriptor;
  descriptorHash?: Hex;

  address?: Hex;
}

export interface ClaimPlan {
  root: Hex;
  totalWeight: bigint;
  items: ClaimPlanItem[];
}

export function claimPlan(beneficiaries: Beneficiary[]): ClaimPlan {
  const tree = buildBeneficiaries(beneficiaries);
  const items: ClaimPlanItem[] = tree.leaves.map((leaf, i) => {
    const b = beneficiaries[i]!;
    return {
      index: leaf.index,
      kind: leaf.kind,
      weight: leaf.weight,
      leaf,
      proof: tree.proofs[i]!,
      ...(b.kind === "identity"
        ? { descriptor: b.descriptor, descriptorHash: leaf.descriptorHash }
        : { address: leaf.address }),
    };
  });
  return { root: tree.root, totalWeight: tree.totalWeight, items };
}

export interface ClaimantIdentity {
  fullName: string;
  dateOfBirth: string;
}

export interface MatchResult {

  match: boolean;

  score: number;
  reasons: string[];

  needsGuardian: boolean;
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameTokens(s: string): Set<string> {
  return new Set(normalizeName(s).split(" ").filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function matchesDescriptor(claimant: ClaimantIdentity, descriptor: IdentityDescriptor): MatchResult {
  const reasons: string[] = [];
  const dobMatch = claimant.dateOfBirth === descriptor.dateOfBirth;
  const nameSim = jaccard(nameTokens(claimant.fullName), nameTokens(descriptor.fullName));

  if (dobMatch) reasons.push("date of birth matches");
  else reasons.push(`date of birth differs (${claimant.dateOfBirth} vs ${descriptor.dateOfBirth})`);
  reasons.push(`name similarity ${nameSim.toFixed(2)}`);

  const score = (dobMatch ? 0.5 : 0) + 0.5 * nameSim;

  if (dobMatch && nameSim >= 0.999) {
    return { match: true, score, reasons, needsGuardian: false };
  }
  if (dobMatch && nameSim >= 0.5) {
    reasons.push("close but not exact — routing to guardian");
    return { match: false, score, reasons, needsGuardian: true };
  }
  return { match: false, score, reasons, needsGuardian: false };
}
