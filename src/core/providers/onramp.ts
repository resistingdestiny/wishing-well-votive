import { keccak256, toHex } from "viem";
import { type ProviderResult, type NamedProvider, type Settlement, type UsdcAmount, ok, err } from "./types.js";
import { ProviderStore, type StoredOnrampSession } from "./store.js";
import type { FetchLike } from "./wallet.js";

export const GOOD_TEST_CARD = "4242424242424242";
export const DECLINE_TEST_CARD = "4000000000000002";
export const INSUFFICIENT_FUNDS_CARD = "4000000000009995";

export interface MockCard {
  number: string;
}

export interface OnrampSession {
  id: string;
  owner: string;
  amountUsdc: UsdcAmount;
  destination: `0x${string}`;
  status: "created" | "completed" | "declined";
  checkoutUrl: string;
  provider: string;
  settledRef?: string;
  declineReason?: string;
}

export interface OnrampProvider extends NamedProvider {

  startCheckout(args: {
    owner: string;
    amountUsdc: UsdcAmount;
    destination: `0x${string}`;
  }): Promise<ProviderResult<{ session: OnrampSession }>>;

  completeCheckout(id: string, opts?: { card?: MockCard }): Promise<ProviderResult<{ session: OnrampSession }>>;
  getSession(id: string): Promise<OnrampSession | undefined>;
}

function nowIso(): string {
  return new Date().toISOString();
}
function toStored(s: OnrampSession): StoredOnrampSession {
  return {
    id: s.id,
    owner: s.owner,
    amountUsdc: s.amountUsdc.toString(),
    destination: s.destination,
    status: s.status,
    provider: s.provider,
    createdAt: nowIso(),
    settledRef: s.settledRef,
    declineReason: s.declineReason,
  };
}
function fromStored(s: StoredOnrampSession): OnrampSession {
  return {
    id: s.id,
    owner: s.owner,
    amountUsdc: BigInt(s.amountUsdc),
    destination: s.destination,
    status: s.status,
    checkoutUrl: `mock://onramp/checkout/${s.id}`,
    provider: s.provider,
    settledRef: s.settledRef,
    declineReason: s.declineReason,
  };
}

export class MockOnrampProvider implements OnrampProvider {
  readonly kind = "onramp";
  readonly provider = "mock";
  constructor(
    private readonly store: ProviderStore,
    private readonly settlement: Settlement,
  ) {}

  async startCheckout(args: {
    owner: string;
    amountUsdc: UsdcAmount;
    destination: `0x${string}`;
  }): Promise<ProviderResult<{ session: OnrampSession }>> {
    if (args.amountUsdc <= 0n) return err("bad_request", "amount must be positive");
    const id = `onramp_${keccak256(toHex(`${args.owner}:${args.destination}:${args.amountUsdc}:${nowIso()}`)).slice(2, 18)}`;
    const session: OnrampSession = {
      id,
      owner: args.owner,
      amountUsdc: args.amountUsdc,
      destination: args.destination,
      status: "created",
      checkoutUrl: `mock://onramp/checkout/${id}`,
      provider: this.provider,
    };
    this.store.putOnrampSession(toStored(session));
    return ok({ session });
  }

  async completeCheckout(
    id: string,
    opts?: { card?: MockCard },
  ): Promise<ProviderResult<{ session: OnrampSession }>> {
    const stored = this.store.onrampSession(id);
    if (!stored) return err("not_found", `no onramp session ${id}`, false);
    const session = fromStored(stored);

    if (session.status === "completed") return ok({ session });
    if (session.status === "declined") {
      return err("card_declined", session.declineReason ?? "card was declined");
    }

    const card = opts?.card?.number ?? GOOD_TEST_CARD;
    if (card === DECLINE_TEST_CARD || card === INSUFFICIENT_FUNDS_CARD) {
      const reason = card === INSUFFICIENT_FUNDS_CARD ? "insufficient_funds" : "card_declined";
      session.status = "declined";
      session.declineReason = reason;
      this.store.putOnrampSession(toStored(session));
      return err(reason, `checkout ${id} declined (${reason})`);
    }

    const { ref } = await this.settlement.credit(session.destination, session.amountUsdc);
    session.status = "completed";
    session.settledRef = ref;
    this.store.putOnrampSession(toStored(session));
    return ok({ session });
  }

  async getSession(id: string): Promise<OnrampSession | undefined> {
    const s = this.store.onrampSession(id);
    return s ? fromStored(s) : undefined;
  }
}

export class HostedOnrampProvider implements OnrampProvider {
  readonly kind = "onramp";
  readonly provider: string;
  private readonly base: string;

  constructor(
    private readonly vendor: "moonpay" | "transak",
    private readonly apiKey: string,
    private readonly store: ProviderStore,
    baseUrl?: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.provider = vendor;
    this.base = (baseUrl ?? (vendor === "moonpay" ? "https://api.moonpay.com" : "https://api.transak.com")).replace(
      /\/+$/,
      "",
    );
  }

  async startCheckout(args: {
    owner: string;
    amountUsdc: UsdcAmount;
    destination: `0x${string}`;
  }): Promise<ProviderResult<{ session: OnrampSession }>> {
    const id = `${this.vendor}_${keccak256(toHex(`${args.owner}:${args.destination}:${args.amountUsdc}`)).slice(2, 18)}`;

    const usd = (Number(args.amountUsdc) / 1_000_000).toFixed(2);
    const url =
      this.vendor === "moonpay"
        ? `https://buy.moonpay.com?apiKey=${this.apiKey}&currencyCode=usdc&walletAddress=${args.destination}&baseCurrencyAmount=${usd}`
        : `https://global.transak.com?apiKey=${this.apiKey}&cryptoCurrencyCode=USDC&walletAddress=${args.destination}&fiatAmount=${usd}`;
    const session: OnrampSession = {
      id,
      owner: args.owner,
      amountUsdc: args.amountUsdc,
      destination: args.destination,
      status: "created",
      checkoutUrl: url,
      provider: this.provider,
    };
    this.store.putOnrampSession(toStored(session));
    return ok({ session });
  }

  async completeCheckout(id: string): Promise<ProviderResult<{ session: OnrampSession }>> {
    const stored = this.store.onrampSession(id);
    if (!stored) return err("not_found", `no onramp session ${id}`, false);
    const session = fromStored(stored);
    if (session.status !== "created") return ok({ session });
    let res;
    try {
      res = await this.fetchImpl(`${this.base}/v1/transactions/${id}`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.apiKey}` },
      });
    } catch (e) {
      return err("provider_unreachable", `${this.vendor}: ${(e as Error).message}`);
    }
    if (!res.ok) return err("provider_error", `${this.vendor} status ${res.status}`);
    const body = (await res.json()) as { status?: string };
    if (body.status === "completed") {
      session.status = "completed";
      this.store.putOnrampSession(toStored(session));
      return ok({ session });
    }
    if (body.status === "failed") {
      session.status = "declined";
      session.declineReason = "vendor_failed";
      this.store.putOnrampSession(toStored(session));
      return err("card_declined", `${this.vendor} transaction failed`);
    }
    return err("pending", `${this.vendor} transaction still ${body.status ?? "pending"}`, false);
  }

  async getSession(id: string): Promise<OnrampSession | undefined> {
    const s = this.store.onrampSession(id);
    return s ? fromStored(s) : undefined;
  }
}
