import { keccak256, toHex } from "viem";
import { type ProviderResult, type NamedProvider, type Settlement, type UsdcAmount, ok, err } from "./types.js";
import { ProviderStore, type StoredPayout } from "./store.js";

export interface BankAccount {
  holderName: string;

  accountNumber: string;
  routingNumber?: string;
  bankName?: string;

  country: string;
}

export interface Payout {
  id: string;
  subject: string;
  amountUsdc: UsdcAmount;
  custody: `0x${string}`;
  bankHolder: string;
  bankAccount: string;
  status: "pending" | "paid" | "failed";
  provider: string;
  settledRef?: string;
}

export interface OfframpProvider extends NamedProvider {

  createPayout(args: {
    subject: string;
    amountUsdc: UsdcAmount;
    custody: `0x${string}`;
    bank: BankAccount;
  }): Promise<ProviderResult<{ payout: Payout }>>;

  settlePayout(id: string): Promise<ProviderResult<{ payout: Payout }>>;
  getPayout(id: string): Promise<Payout | undefined>;
}

function nowIso(): string {
  return new Date().toISOString();
}
function toStored(p: Payout): StoredPayout {
  return {
    id: p.id,
    subject: p.subject,
    amountUsdc: p.amountUsdc.toString(),
    custody: p.custody,
    bankHolder: p.bankHolder,
    bankAccount: p.bankAccount,
    status: p.status,
    provider: p.provider,
    createdAt: nowIso(),
    settledRef: p.settledRef,
  };
}
function fromStored(p: StoredPayout): Payout {
  return {
    id: p.id,
    subject: p.subject,
    amountUsdc: BigInt(p.amountUsdc),
    custody: p.custody,
    bankHolder: p.bankHolder,
    bankAccount: p.bankAccount,
    status: p.status,
    provider: p.provider,
    settledRef: p.settledRef,
  };
}

function maskAccount(acct: string): string {
  const tail = acct.slice(-4);
  return `••••${tail}`;
}

export class MockOfframpProvider implements OfframpProvider {
  readonly kind = "offramp";
  readonly provider = "mock";
  constructor(
    private readonly store: ProviderStore,
    private readonly settlement: Settlement,
  ) {}

  async createPayout(args: {
    subject: string;
    amountUsdc: UsdcAmount;
    custody: `0x${string}`;
    bank: BankAccount;
  }): Promise<ProviderResult<{ payout: Payout }>> {
    if (args.amountUsdc <= 0n) return err("bad_request", "amount must be positive");
    if (!args.bank.holderName.trim() || !args.bank.accountNumber.trim()) {
      return err("bad_request", "bank holder name and account number are required");
    }
    const id = `payout_${keccak256(toHex(`${args.subject}:${args.custody}:${args.amountUsdc}:${nowIso()}`)).slice(2, 18)}`;
    const payout: Payout = {
      id,
      subject: args.subject,
      amountUsdc: args.amountUsdc,
      custody: args.custody,
      bankHolder: args.bank.holderName,
      bankAccount: maskAccount(args.bank.accountNumber),
      status: "pending",
      provider: this.provider,
    };
    this.store.putPayout(toStored(payout));
    return ok({ payout });
  }

  async settlePayout(id: string): Promise<ProviderResult<{ payout: Payout }>> {
    const stored = this.store.payout(id);
    if (!stored) return err("not_found", `no payout ${id}`, false);
    const payout = fromStored(stored);
    if (payout.status === "paid") return ok({ payout });
    const { ref } = await this.settlement.debit(payout.custody, payout.amountUsdc);
    payout.status = "paid";
    payout.settledRef = ref;
    this.store.putPayout(toStored(payout));
    return ok({ payout });
  }

  async getPayout(id: string): Promise<Payout | undefined> {
    const p = this.store.payout(id);
    return p ? fromStored(p) : undefined;
  }
}
