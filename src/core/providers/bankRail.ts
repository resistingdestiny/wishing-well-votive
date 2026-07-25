import { keccak256, toHex } from "viem";
import { type ProviderResult, type NamedProvider, type Settlement, type UsdcAmount, ok, err } from "./types.js";
import { ProviderStore, type StoredVirtualAccount, type StoredBankTransfer } from "./store.js";
import type { FetchLike } from "./wallet.js";

export interface VirtualAccount {
  id: string;
  owner: string;
  currency: string;
  bankName: string;
  accountNumber: string;
  routingNumber: string;
  reference: string;
  destination: `0x${string}`;
  provider: string;
}

export interface BankTransfer {
  id: string;
  virtualAccountId: string;
  amountUsdc: UsdcAmount;
  status: "pending" | "settled";
  provider: string;
  settledRef?: string;
}

export interface BankRailProvider extends NamedProvider {

  issueVirtualAccount(args: {
    owner: string;
    destination: `0x${string}`;
    currency?: string;
  }): Promise<ProviderResult<{ account: VirtualAccount }>>;

  receiveTransfer(args: {
    virtualAccountId: string;
    amountUsdc: UsdcAmount;
    externalRef?: string;
  }): Promise<ProviderResult<{ transfer: BankTransfer }>>;

  settleTransfer(transferId: string): Promise<ProviderResult<{ transfer: BankTransfer }>>;
  getVirtualAccount(id: string): Promise<VirtualAccount | undefined>;
  getTransfer(id: string): Promise<BankTransfer | undefined>;
}

function nowIso(): string {
  return new Date().toISOString();
}
function vaToStored(v: VirtualAccount): StoredVirtualAccount {
  return { ...v, createdAt: nowIso() };
}
function vaFromStored(v: StoredVirtualAccount): VirtualAccount {
  const { createdAt: _drop, ...rest } = v;
  return rest;
}
function txToStored(t: BankTransfer): StoredBankTransfer {
  return {
    id: t.id,
    virtualAccountId: t.virtualAccountId,
    amountUsdc: t.amountUsdc.toString(),
    status: t.status,
    provider: t.provider,
    receivedAt: nowIso(),
    settledRef: t.settledRef,
  };
}
function txFromStored(t: StoredBankTransfer): BankTransfer {
  return {
    id: t.id,
    virtualAccountId: t.virtualAccountId,
    amountUsdc: BigInt(t.amountUsdc),
    status: t.status,
    provider: t.provider,
    settledRef: t.settledRef,
  };
}

export class MockBankRailProvider implements BankRailProvider {
  readonly kind = "bank-rail";
  readonly provider = "mock";
  constructor(
    private readonly store: ProviderStore,
    private readonly settlement: Settlement,
  ) {}

  async issueVirtualAccount(args: {
    owner: string;
    destination: `0x${string}`;
    currency?: string;
  }): Promise<ProviderResult<{ account: VirtualAccount }>> {
    const existing = this.store.virtualAccountFor(args.owner);
    if (existing) return ok({ account: vaFromStored(existing) });
    const seed = keccak256(toHex(`va:${args.owner.toLowerCase()}`));
    const account: VirtualAccount = {
      id: `va_${seed.slice(2, 14)}`,
      owner: args.owner,
      currency: args.currency ?? "USD",
      bankName: "Votive Custody Bank (sandbox)",
      accountNumber: BigInt("0x" + seed.slice(2, 18)).toString().padStart(10, "0").slice(0, 10),
      routingNumber: "021000021",
      reference: `WISH-${seed.slice(2, 10).toUpperCase()}`,
      destination: args.destination,
      provider: this.provider,
    };
    this.store.putVirtualAccount(vaToStored(account));
    return ok({ account });
  }

  async receiveTransfer(args: {
    virtualAccountId: string;
    amountUsdc: UsdcAmount;
    externalRef?: string;
  }): Promise<ProviderResult<{ transfer: BankTransfer }>> {
    const va = this.store.virtualAccount(args.virtualAccountId);
    if (!va) return err("not_found", `no virtual account ${args.virtualAccountId}`, false);
    if (args.amountUsdc <= 0n) return err("bad_request", "amount must be positive");

    const key = args.externalRef ?? `${args.virtualAccountId}:${args.amountUsdc}`;
    const id = `btx_${keccak256(toHex(key)).slice(2, 18)}`;
    const existing = this.store.bankTransfer(id);
    if (existing) return ok({ transfer: txFromStored(existing) });
    const transfer: BankTransfer = {
      id,
      virtualAccountId: args.virtualAccountId,
      amountUsdc: args.amountUsdc,
      status: "pending",
      provider: this.provider,
    };
    this.store.putBankTransfer(txToStored(transfer));
    return ok({ transfer });
  }

  async settleTransfer(transferId: string): Promise<ProviderResult<{ transfer: BankTransfer }>> {
    const stored = this.store.bankTransfer(transferId);
    if (!stored) return err("not_found", `no transfer ${transferId}`, false);
    const transfer = txFromStored(stored);
    if (transfer.status === "settled") return ok({ transfer });
    const va = this.store.virtualAccount(transfer.virtualAccountId);
    if (!va) return err("not_found", `no virtual account for transfer ${transferId}`, false);
    const { ref } = await this.settlement.credit(va.destination, transfer.amountUsdc);
    transfer.status = "settled";
    transfer.settledRef = ref;
    this.store.putBankTransfer(txToStored(transfer));
    return ok({ transfer });
  }

  async getVirtualAccount(id: string): Promise<VirtualAccount | undefined> {
    const v = this.store.virtualAccount(id);
    return v ? vaFromStored(v) : undefined;
  }
  async getTransfer(id: string): Promise<BankTransfer | undefined> {
    const t = this.store.bankTransfer(id);
    return t ? txFromStored(t) : undefined;
  }
}

export class HostedBankRailProvider implements BankRailProvider {
  readonly kind = "bank-rail";
  readonly provider: string;
  private readonly base: string;

  constructor(
    private readonly vendor: "bridge" | "bvnk",
    private readonly apiKey: string,
    private readonly store: ProviderStore,
    baseUrl?: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.provider = vendor;
    this.base = (baseUrl ?? (vendor === "bridge" ? "https://api.bridge.xyz" : "https://api.bvnk.com")).replace(
      /\/+$/,
      "",
    );
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, "api-key": this.apiKey, "content-type": "application/json" };
  }

  async issueVirtualAccount(args: {
    owner: string;
    destination: `0x${string}`;
    currency?: string;
  }): Promise<ProviderResult<{ account: VirtualAccount }>> {
    const existing = this.store.virtualAccountFor(args.owner);
    if (existing) return ok({ account: vaFromStored(existing) });
    let res;
    try {
      res = await this.fetchImpl(`${this.base}/v0/customers/${encodeURIComponent(args.owner)}/virtual_accounts`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          source: { currency: (args.currency ?? "usd").toLowerCase() },
          destination: { currency: "usdc", payment_rail: "base", address: args.destination },
        }),
      });
    } catch (e) {
      return err("provider_unreachable", `${this.vendor}: ${(e as Error).message}`);
    }
    if (!res.ok) return err("provider_error", `${this.vendor} virtual_accounts ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      id?: string;
      source_deposit_instructions?: { bank_name?: string; bank_account_number?: string; bank_routing_number?: string; payment_reference?: string };
    };
    const di = body.source_deposit_instructions ?? {};
    if (!body.id || !di.bank_account_number) return err("provider_error", `${this.vendor}: incomplete virtual account`);
    const account: VirtualAccount = {
      id: body.id,
      owner: args.owner,
      currency: args.currency ?? "USD",
      bankName: di.bank_name ?? `${this.vendor} partner bank`,
      accountNumber: di.bank_account_number,
      routingNumber: di.bank_routing_number ?? "",
      reference: di.payment_reference ?? body.id,
      destination: args.destination,
      provider: this.provider,
    };
    this.store.putVirtualAccount(vaToStored(account));
    return ok({ account });
  }

  async receiveTransfer(args: {
    virtualAccountId: string;
    amountUsdc: UsdcAmount;
    externalRef?: string;
  }): Promise<ProviderResult<{ transfer: BankTransfer }>> {

    const va = this.store.virtualAccount(args.virtualAccountId);
    if (!va) return err("not_found", `no virtual account ${args.virtualAccountId}`, false);
    if (args.amountUsdc <= 0n) return err("bad_request", "amount must be positive");
    const key = args.externalRef ?? `${args.virtualAccountId}:${args.amountUsdc}`;
    const id = `btx_${keccak256(toHex(key)).slice(2, 18)}`;
    const existing = this.store.bankTransfer(id);
    if (existing) return ok({ transfer: txFromStored(existing) });
    const transfer: BankTransfer = {
      id,
      virtualAccountId: args.virtualAccountId,
      amountUsdc: args.amountUsdc,
      status: "pending",
      provider: this.provider,
    };
    this.store.putBankTransfer(txToStored(transfer));
    return ok({ transfer });
  }

  async settleTransfer(transferId: string): Promise<ProviderResult<{ transfer: BankTransfer }>> {
    const stored = this.store.bankTransfer(transferId);
    if (!stored) return err("not_found", `no transfer ${transferId}`, false);
    const transfer = txFromStored(stored);
    if (transfer.status === "settled") return ok({ transfer });
    const va = this.store.virtualAccount(transfer.virtualAccountId);
    if (!va) return err("not_found", `no virtual account for transfer ${transferId}`, false);

    let res;
    try {
      res = await this.fetchImpl(
        `${this.base}/v0/customers/${encodeURIComponent(va.owner)}/virtual_accounts/${encodeURIComponent(transfer.virtualAccountId)}/history`,
        { method: "GET", headers: this.headers() },
      );
    } catch (e) {
      return err("provider_unreachable", `${this.vendor}: ${(e as Error).message}`);
    }
    if (!res.ok) return err("provider_error", `${this.vendor} history ${res.status}`);
    const body = (await res.json()) as { data?: { type?: string; amount?: string }[] };
    const delivered = (body.data ?? []).some((a) => a.type === "funds_received" || a.type === "payment_processed");
    if (!delivered) return err("pending", `${this.vendor}: wire not yet delivered`, false);
    transfer.status = "settled";
    transfer.settledRef = `${this.vendor}:delivered`;
    this.store.putBankTransfer(txToStored(transfer));
    return ok({ transfer });
  }

  async getVirtualAccount(id: string): Promise<VirtualAccount | undefined> {
    const v = this.store.virtualAccount(id);
    return v ? vaFromStored(v) : undefined;
  }
  async getTransfer(id: string): Promise<BankTransfer | undefined> {
    const t = this.store.bankTransfer(id);
    return t ? txFromStored(t) : undefined;
  }
}
