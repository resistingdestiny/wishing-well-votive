import { keccak256, toHex, getAddress, type Hex } from "viem";
import { type ProviderResult, type NamedProvider, ok, err } from "./types.js";
import { ProviderStore, type StoredWallet } from "./store.js";

export interface EmbeddedWallet {
  id: string;
  owner: string;
  address: `0x${string}`;
  via: "email" | "passkey";
  provider: string;
}

export interface WalletProvider extends NamedProvider {

  getOrCreateWallet(args: {
    owner: string;
    via: "email" | "passkey";
  }): Promise<ProviderResult<{ wallet: EmbeddedWallet }>>;

  getWallet(owner: string): Promise<EmbeddedWallet | undefined>;
}

function toStored(w: EmbeddedWallet): StoredWallet {
  return { id: w.id, owner: w.owner, address: w.address, via: w.via, provider: w.provider, createdAt: nowIso() };
}
function fromStored(w: StoredWallet): EmbeddedWallet {
  return { id: w.id, owner: w.owner, address: w.address, via: w.via, provider: w.provider };
}
function nowIso(): string {
  return new Date().toISOString();
}

export class MockWalletProvider implements WalletProvider {
  readonly kind = "wallet";
  readonly provider = "mock";
  constructor(private readonly store: ProviderStore) {}

  private deriveAddress(owner: string): `0x${string}` {
    const h = keccak256(toHex(`wish-wallet:${owner.toLowerCase()}`));
    return getAddress(("0x" + h.slice(-40)) as Hex);
  }

  async getOrCreateWallet(args: {
    owner: string;
    via: "email" | "passkey";
  }): Promise<ProviderResult<{ wallet: EmbeddedWallet }>> {
    if (!args.owner.trim()) return err("bad_request", "owner is required");
    const existing = this.store.walletFor(args.owner);
    if (existing) return ok({ wallet: fromStored(existing) });
    const wallet: EmbeddedWallet = {
      id: `mockw_${keccak256(toHex(args.owner)).slice(2, 14)}`,
      owner: args.owner,
      address: this.deriveAddress(args.owner),
      via: args.via,
      provider: this.provider,
    };
    this.store.upsertWallet(toStored(wallet));
    return ok({ wallet });
  }

  async getWallet(owner: string): Promise<EmbeddedWallet | undefined> {
    const w = this.store.walletFor(owner);
    return w ? fromStored(w) : undefined;
  }
}

export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export class PrivyWalletProvider implements WalletProvider {
  readonly kind = "wallet";
  readonly provider = "privy";
  private readonly base: string;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly store: ProviderStore,
    baseUrl?: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.base = (baseUrl ?? "https://api.privy.io").replace(/\/+$/, "");
  }

  async getOrCreateWallet(args: {
    owner: string;
    via: "email" | "passkey";
  }): Promise<ProviderResult<{ wallet: EmbeddedWallet }>> {
    const existing = this.store.walletFor(args.owner);
    if (existing) return ok({ wallet: fromStored(existing) });
    const auth = Buffer.from(`${this.appId}:${this.appSecret}`).toString("base64");
    let res;
    try {
      res = await this.fetchImpl(`${this.base}/v1/wallets`, {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "privy-app-id": this.appId,
          "content-type": "application/json",
        },
        body: JSON.stringify({ chain_type: "ethereum" }),
      });
    } catch (e) {
      return err("provider_unreachable", `privy: ${(e as Error).message}`);
    }
    if (!res.ok) return err("provider_error", `privy /v1/wallets ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { id?: string; address?: string };
    if (!body.address) return err("provider_error", "privy: no wallet address in response");
    const wallet: EmbeddedWallet = {
      id: body.id ?? `privy_${args.owner}`,
      owner: args.owner,
      address: getAddress(body.address as Hex),
      via: args.via,
      provider: this.provider,
    };
    this.store.upsertWallet(toStored(wallet));
    return ok({ wallet });
  }

  async getWallet(owner: string): Promise<EmbeddedWallet | undefined> {
    const w = this.store.walletFor(owner);
    return w ? fromStored(w) : undefined;
  }
}
