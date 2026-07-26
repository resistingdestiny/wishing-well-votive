"use client";

import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { isAddress, type Chain } from "viem";

const chainId = Number(process.env.NEXT_PUBLIC_WELL_CHAIN_ID ?? 31337);
const rpcUrl = process.env.NEXT_PUBLIC_WELL_RPC_URL ?? "http://127.0.0.1:8545";

export const appChain: Chain = {
  id: chainId,
  name: chainId === 84532 ? "Base Sepolia" : `Local fork (${chainId})`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  ...(chainId === 84532
    ? { blockExplorers: { default: { name: "Basescan", url: "https://sepolia.basescan.org" } } }
    : {}),
};

/**
 * The payments rail lives on Hedera, not on the chain the rest of the app uses.
 *
 * It has to be declared here or `switchChain` cannot offer it: wagmi will only
 * switch to a chain in its own config, so without this the rail's controls fail
 * with a wallet error that names no network and suggests no remedy.
 */
const hederaRpc = process.env.NEXT_PUBLIC_HEDERA_RPC_URL;
const hederaId = Number(process.env.NEXT_PUBLIC_HEDERA_CHAIN_ID ?? 296);

export const hederaChain: Chain = {
  id: hederaId,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [hederaRpc ?? "https://testnet.hashio.io/api"] } },
  blockExplorers: { default: { name: "HashScan", url: "https://hashscan.io/testnet" } },
};

/** True only when the rail is actually deployed for this environment. */
export const HAS_HEDERA_RAIL =
  typeof process.env.NEXT_PUBLIC_HEDERA_BOUNTY_RAIL === "string" &&
  /^0x[0-9a-fA-F]{40}$/.test(process.env.NEXT_PUBLIC_HEDERA_BOUNTY_RAIL);

export const wagmiConfig = createConfig({
  // A tuple, because wagmi types `chains` as non-empty.
  chains: hederaChain.id === appChain.id ? [appChain] : [appChain, hederaChain],
  connectors: [injected()],
  transports: {
    [appChain.id]: http(rpcUrl),
    [hederaChain.id]: http(hederaRpc ?? "https://testnet.hashio.io/api"),
  },
});

export const FACTORY_ADDRESS = process.env.NEXT_PUBLIC_WELL_FACTORY as
  | `0x${string}`
  | undefined;

export const REGISTRY_ADDRESS = process.env.NEXT_PUBLIC_WELL_REGISTRY as
  | `0x${string}`
  | undefined;

export const POSITION_REGISTRY_ADDRESS = process.env.NEXT_PUBLIC_WELL_POSITION_REGISTRY as
  | `0x${string}`
  | undefined;

export const RESOURCE_POOL_ADDRESS = process.env.NEXT_PUBLIC_WELL_RESOURCE_POOL as
  | `0x${string}`
  | undefined;

export interface TokenOption {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
}

export const FUNDING_TOKENS: TokenOption[] = (process.env.NEXT_PUBLIC_WELL_TOKENS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [address, symbol, decimals] = s.split(":");
    return {
      address: address as `0x${string}`,
      symbol: symbol ?? "TOKEN",
      decimals: Number(decimals ?? 18),
    };
  })
  .filter((t) => isAddress(t.address));
