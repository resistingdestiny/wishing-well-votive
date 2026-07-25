import {
  createAgentBookVerifier,
  createAgentkitClient,
  type AgentBookVerifier,
  type AgentkitClient,
  type AgentkitSigner,
} from "@worldcoin/agentkit";
import { privateKeyToAccount } from "viem/accounts";
import { type AssuranceTier, isAssuranceTier } from "./assurance.js";

export interface HumanBacking {
  wallet: `0x${string}`;

  humanId: string;

  assurance: AssuranceTier;
}

export const CAIP: Record<string, string> = {
  "base-sepolia": "eip155:84532",
  base: "eip155:8453",
  "world-chain": "eip155:480",
  "world-chain-sepolia": "eip155:4801",
};

export function caipFor(network: string): string {
  return CAIP[network] ?? CAIP["base-sepolia"]!;
}

export interface WorldConfig {

  enabled: boolean;

  mock: boolean;

  network: string;

  worldChainRpcUrl?: string;

  agentBookAddress?: `0x${string}`;

  mockBackings: Record<string, { humanId: string; assurance?: AssuranceTier }>;

  defaultAssurance: AssuranceTier;
}

function parseMockBackings(
  raw: string | undefined,
): Record<string, { humanId: string; assurance?: AssuranceTier }> {
  const out: Record<string, { humanId: string; assurance?: AssuranceTier }> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const wallet = pair.slice(0, eq).trim();
    const spec = pair.slice(eq + 1).trim();
    if (!wallet || !spec) continue;
    const at = spec.lastIndexOf("@");
    const humanId = at >= 0 ? spec.slice(0, at).trim() : spec;
    const tier = at >= 0 ? spec.slice(at + 1).trim() : "";
    if (!humanId) continue;
    out[wallet.toLowerCase()] = {
      humanId,
      assurance: tier && isAssuranceTier(tier) ? (tier as AssuranceTier) : undefined,
    };
  }
  return out;
}

export function loadWorldConfig(env: NodeJS.ProcessEnv = process.env): WorldConfig {
  const defTier = env.WELL_WORLD_DEFAULT_ASSURANCE;
  return {
    enabled: env.WELL_WORLD_ENABLED === "1",
    mock: env.WELL_WORLD_MOCK === "1",
    network: env.WELL_WORLD_NETWORK ?? "base-sepolia",
    worldChainRpcUrl: env.WELL_WORLD_CHAIN_RPC_URL,
    agentBookAddress: env.WELL_AGENTBOOK_ADDRESS as `0x${string}` | undefined,
    mockBackings: parseMockBackings(env.WELL_WORLD_MOCK_BACKINGS),
    defaultAssurance: defTier && isAssuranceTier(defTier) ? (defTier as AssuranceTier) : "selfie",
  };
}

export function resolveVerifier(cfg: WorldConfig): AgentBookVerifier {
  if (cfg.mock) {
    const backings = cfg.mockBackings;
    return {
      async lookupHuman(address: string): Promise<string | null> {
        return backings[address.toLowerCase()]?.humanId ?? null;
      },
    };
  }
  return createAgentBookVerifier({
    rpcUrl: cfg.worldChainRpcUrl,
    contractAddress: cfg.agentBookAddress,
  });
}

export async function verifyHumanBacking(
  wallet: `0x${string}`,
  cfg: WorldConfig,
  verifier?: AgentBookVerifier,
): Promise<HumanBacking | null> {
  if (!cfg.enabled) return null;
  const v = verifier ?? resolveVerifier(cfg);
  const humanId = await v.lookupHuman(wallet);
  if (!humanId) return null;
  const assurance =
    cfg.mockBackings[wallet.toLowerCase()]?.assurance ?? cfg.defaultAssurance;
  return { wallet, humanId, assurance };
}

export function agentkitSignerFromPrivateKey(
  privateKey: `0x${string}`,
  caipChainId: string,
): AgentkitSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    chainId: caipChainId,
    type: "eip191",
    signMessage: (message: string) => account.signMessage({ message }),
  };
}

export function createHumanBackedClient(signer: AgentkitSigner): AgentkitClient {
  return createAgentkitClient({ signer });
}

export {
  createAgentkitHooks,
  InMemoryAgentKitStorage,
  type AgentBookVerifier,
  type AgentkitSigner,
} from "@worldcoin/agentkit";
