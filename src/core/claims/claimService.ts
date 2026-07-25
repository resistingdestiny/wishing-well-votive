import type { Hex } from "viem";
import type { Beneficiary } from "../schema/beneficiaries.js";
import { claimPlan, matchesDescriptor, type ClaimantIdentity } from "./match.js";
import type { KycProvider } from "../providers/kyc.js";
import type { OfframpProvider, BankAccount } from "../providers/offramp.js";
import { type ProviderResult, type Swap, ok, err } from "../providers/types.js";

export interface ClaimChain {

  recordIdentityClaim(args: {
    cell: `0x${string}`;
    index: number;
    descriptorHash: Hex;
    weight: bigint;
    proof: Hex[];
    payoutAddr: `0x${string}`;
    rail: number;
  }): Promise<{ ref: string }>;
}

export interface ClaimInvitation {
  index: number;

  token: string;

  fullName: string;
  relationship: string;
  contactHint?: string;
  descriptorHash: Hex;
  weight: bigint;
}

export type PayoutElection =
  | { rail: "wallet"; walletAddr: `0x${string}` }
  | { rail: "bank"; bank: BankAccount };

export interface ClaimServiceConfig {

  offrampCustody: `0x${string}`;

  swapCustody?: `0x${string}`;
}

export class ClaimService {
  constructor(
    private readonly kyc: KycProvider,
    private readonly offramp: OfframpProvider,
    private readonly chain: ClaimChain,
    private readonly cfg: ClaimServiceConfig,

    private readonly swap?: Swap,
  ) {}

  invitations(cell: `0x${string}`, beneficiaries: Beneficiary[]): ClaimInvitation[] {
    const plan = claimPlan(beneficiaries);
    const out: ClaimInvitation[] = [];
    for (const item of plan.items) {
      if (item.kind !== "identity" || !item.descriptor) continue;
      out.push({
        index: item.index,
        token: inviteToken(cell, item.index, item.descriptorHash!),
        fullName: item.descriptor.fullName,
        relationship: item.descriptor.relationship,
        contactHint: item.descriptor.contactHint,
        descriptorHash: item.descriptorHash!,
        weight: item.weight,
      });
    }
    return out;
  }

  async processIdentityClaim(input: {
    cell: `0x${string}`;
    beneficiaries: Beneficiary[];
    index: number;

    claimant: ClaimantIdentity;

    subject: string;
    payout: PayoutElection;

    slice?: bigint;

    assetIsNative?: boolean;

    guardianOverride?: boolean;
  }): Promise<
    ProviderResult<{
      txRef: string;
      matched: boolean;
      needsGuardian: boolean;
      kycStatus: string;
      payoutRef?: string;

      usdcOut?: bigint;
    }>
  > {
    const plan = claimPlan(input.beneficiaries);
    const item = plan.items.find((i) => i.index === input.index);
    if (!item || item.kind !== "identity" || !item.descriptor) {
      return err("not_found", `no identity beneficiary at index ${input.index}`, false);
    }

    const session = await this.kyc.createSession({ subject: input.subject, descriptorHash: item.descriptorHash });
    if (!session.ok) return session;
    const resolved = await this.kyc.resolveSession(session.session.id);
    if (!resolved.ok) return resolved;

    const match = input.guardianOverride
      ? { match: true, needsGuardian: false, reasons: [] as string[] }
      : matchesDescriptor(input.claimant, item.descriptor);
    if (!match.match) {
      if (match.needsGuardian) {
        return ok({
          txRef: "",
          matched: false,
          needsGuardian: true,
          kycStatus: resolved.session.status,
        });
      }
      return err("descriptor_mismatch", match.reasons.join("; "));
    }

    const swapCustody = this.cfg.swapCustody ?? this.cfg.offrampCustody;
    if (input.payout.rail === "bank") {
      if (!input.slice || input.slice <= 0n) return err("bad_request", "slice is required for a bank payout");
      if (input.assetIsNative && !this.swap) {
        return err("not_configured", "ETH→USDC swap not configured for a bank payout of an ETH wish");
      }
    }

    let payoutAddr: `0x${string}`;
    let rail: number;
    if (input.payout.rail === "wallet") {
      payoutAddr = input.payout.walletAddr;
      rail = 0;
    } else {

      payoutAddr = input.assetIsNative ? swapCustody : this.cfg.offrampCustody;
      rail = 1;
    }

    const { ref } = await this.chain.recordIdentityClaim({
      cell: input.cell,
      index: item.index,
      descriptorHash: item.descriptorHash!,
      weight: item.weight,
      proof: item.proof,
      payoutAddr,
      rail,
    });

    let payoutRef: string | undefined;
    let usdcOut: bigint | undefined;
    if (input.payout.rail === "bank") {
      let amountUsdc = input.slice!;
      if (input.assetIsNative) {
        const swapped = await this.swap!.ethToUsdc({ amountWei: input.slice!, to: this.cfg.offrampCustody });
        amountUsdc = swapped.usdcOut;
      }
      usdcOut = amountUsdc;
      const payout = await this.offramp.createPayout({
        subject: input.subject,
        amountUsdc,
        custody: this.cfg.offrampCustody,
        bank: input.payout.bank,
      });
      if (!payout.ok) return payout;
      const settled = await this.offramp.settlePayout(payout.payout.id);
      if (!settled.ok) return settled;
      payoutRef = payout.payout.id;
    }

    return ok({
      txRef: ref,
      matched: true,
      needsGuardian: false,
      kycStatus: resolved.session.status,
      payoutRef,
      usdcOut,
    });
  }
}

import { keccak256, toHex } from "viem";

export function inviteToken(cell: `0x${string}`, index: number, descriptorHash: Hex): string {
  return keccak256(toHex(`claim-invite:${cell.toLowerCase()}:${index}:${descriptorHash}`)).slice(2, 26);
}
