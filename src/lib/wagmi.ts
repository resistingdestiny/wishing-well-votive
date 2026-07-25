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

export const wagmiConfig = createConfig({
  chains: [appChain],
  connectors: [injected()],
  transports: { [appChain.id]: http(rpcUrl) },
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
