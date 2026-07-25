import type { ProvidersConfig } from "../config.js";
import type { Settlement } from "./types.js";
import { ProviderStore } from "./store.js";
import { type WalletProvider, MockWalletProvider, PrivyWalletProvider } from "./wallet.js";
import { type OnrampProvider, MockOnrampProvider, HostedOnrampProvider } from "./onramp.js";
import { type BankRailProvider, MockBankRailProvider, HostedBankRailProvider } from "./bankRail.js";
import { type KycProvider, MockKycProvider } from "./kyc.js";
import { type OfframpProvider, MockOfframpProvider } from "./offramp.js";

export interface Providers {
  wallet: WalletProvider;
  onramp: OnrampProvider;
  bankRail: BankRailProvider;
  kyc: KycProvider;
  offramp: OfframpProvider;
  store: ProviderStore;

  modes: Record<string, string>;
}

export function buildProviders(cfg: ProvidersConfig, dataDir: string, settlement: Settlement): Providers {
  const store = new ProviderStore(dataDir);
  const live = !cfg.forceMock;

  const wallet: WalletProvider =
    live && cfg.privyAppId && cfg.privyAppSecret
      ? new PrivyWalletProvider(cfg.privyAppId, cfg.privyAppSecret, store, cfg.privyBaseUrl)
      : new MockWalletProvider(store);

  const onramp: OnrampProvider =
    live && cfg.onrampApiKey && cfg.onrampVendor
      ? new HostedOnrampProvider(cfg.onrampVendor, cfg.onrampApiKey, store, cfg.onrampBaseUrl)
      : new MockOnrampProvider(store, settlement);

  const bankRail: BankRailProvider =
    live && cfg.bankRailApiKey && cfg.bankRailVendor
      ? new HostedBankRailProvider(cfg.bankRailVendor, cfg.bankRailApiKey, store, cfg.bankRailBaseUrl)
      : new MockBankRailProvider(store, settlement);
  const kyc: KycProvider = new MockKycProvider(store);
  const offramp: OfframpProvider = new MockOfframpProvider(store, settlement);

  return {
    wallet,
    onramp,
    bankRail,
    kyc,
    offramp,
    store,
    modes: {
      wallet: wallet.provider,
      onramp: onramp.provider,
      bankRail: bankRail.provider,
      kyc: kyc.provider,
      offramp: offramp.provider,
    },
  };
}
