import { prisma } from "./db";
import { readCell, type CellView } from "./chain";
import { encryptPii, decryptPii } from "./pii";
import {
  buildBeneficiaries,
  type Beneficiary,
  type IdentityDescriptor,
} from "@/core/schema/beneficiaries";
import { claimPlan } from "@/core/claims/match";
import { inviteToken } from "@/core/claims/claimService";

const CLAIMABLE_STATE = 6;

interface StoredBeneficiary {
  kind: "wallet" | "identity";
  weight?: number;
  address?: `0x${string}`;

  descriptorEnc?: string;
}

export function encryptBeneficiaries(beneficiaries: Beneficiary[]): StoredBeneficiary[] {
  return beneficiaries.map((b) =>
    b.kind === "wallet"
      ? { kind: "wallet" as const, weight: b.weight, address: b.address as `0x${string}` }
      : { kind: "identity" as const, weight: b.weight, descriptorEnc: encryptPii(JSON.stringify(b.descriptor)) },
  );
}

export function decryptBeneficiaries(stored: StoredBeneficiary[]): Beneficiary[] {
  return stored.map((b) => {
    if (b.kind === "wallet") return { kind: "wallet", address: b.address!, weight: b.weight };
    const descriptor = JSON.parse(decryptPii(b.descriptorEnc!)) as IdentityDescriptor;
    return { kind: "identity", descriptor, weight: b.weight };
  });
}

export async function wishBeneficiaries(cell: `0x${string}`): Promise<Beneficiary[]> {
  const story = await prisma.story.findUnique({ where: { cell } });
  const parsed = story?.parsed as { beneficiaries?: StoredBeneficiary[] } | null;
  if (!parsed?.beneficiaries?.length) return [];
  try {
    return decryptBeneficiaries(parsed.beneficiaries);
  } catch {
    return [];
  }
}

export interface ClaimTarget {
  cell: `0x${string}`;
  view: CellView;
  index: number;
  descriptorHash: `0x${string}`;
  weight: bigint;
  proof: `0x${string}`[];
  fullName: string;
  relationship: string;

  slice: bigint;
  assetIsNative: boolean;
  beneficiaries: Beneficiary[];
}

export async function resolveClaimToken(token: string): Promise<ClaimTarget | null> {

  const stories = await prisma.story.findMany({ where: { cell: { not: null } } });
  for (const story of stories) {
    const cell = story.cell as `0x${string}` | null;
    if (!cell) continue;
    const parsed = story.parsed as { beneficiaries?: StoredBeneficiary[] } | null;
    if (!parsed?.beneficiaries?.length) continue;

    let beneficiaries: Beneficiary[];
    try {
      beneficiaries = decryptBeneficiaries(parsed.beneficiaries);
    } catch {
      continue;
    }
    const plan = claimPlan(beneficiaries);
    const item = plan.items.find(
      (i) => i.kind === "identity" && i.descriptorHash && inviteToken(cell, i.index, i.descriptorHash) === token,
    );
    if (!item || !item.descriptor) continue;

    const view = await readCell(cell);
    if (view.state !== CLAIMABLE_STATE) continue;

    const tree = buildBeneficiaries(beneficiaries);
    const slice = view.claimTotalWeight > 0n ? (view.claimTotal * item.weight) / view.claimTotalWeight : 0n;
    return {
      cell,
      view,
      index: item.index,
      descriptorHash: item.descriptorHash!,
      weight: item.weight,
      proof: tree.proofs[item.index] as `0x${string}`[],
      fullName: item.descriptor.fullName,
      relationship: item.descriptor.relationship,
      slice,
      assetIsNative: view.assetIsNative,
      beneficiaries,
    };
  }
  return null;
}
