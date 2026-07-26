/**
 * Asking World whether there is a human behind a wallet — and being honest about
 * the difference between "no" and "we could not find out".
 *
 * **The bug this module exists to avoid.** `@worldcoin/agentkit`'s
 * `lookupHuman` ends `catch { return null }` (verified in
 * `node_modules/@worldcoin/agentkit-core/dist/cjs/index.js`). An RPC timeout, a
 * wrong contract address, a rate-limited endpoint and a genuinely unregistered
 * wallet all produce the identical `null`. Rendering that as "this wallet is not
 * backed by a human" is telling someone they are not a person because a server
 * in someone else's data centre was busy.
 *
 * So a `null` is never believed on its own. Before it is reported as `no-human`,
 * the World Chain endpoint is probed independently — chain id, and bytecode at
 * the AgentBook address. If the probe cannot be completed, or there is no
 * contract at that address, the answer is `unreachable` with the reason attached,
 * and the caller is expected to render that as a third visibly different thing.
 *
 * The four states are exhaustive and none of them collapses into another:
 *   `backed`          — AgentBook returned an identifier.
 *   `no-human`        — AgentBook answered, and the answer was nobody.
 *   `unreachable`     — we asked and could not get an answer we trust.
 *   `not-configured`  — this deployment has not been pointed at World at all.
 */
import { createPublicClient, http, type Chain } from "viem";
import { loadWorldConfig, resolveVerifier } from "@/core/world/agentkit";
import { humanIdToBytes32 } from "@/core/world/humanId";

/** AgentBook on World Chain, as shipped by `@worldcoin/agentkit-core`. */
export const DEFAULT_AGENTBOOK = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA" as const;

const WORLD_CHAIN: Chain = {
  id: 480,
  name: "World Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        process.env.WELL_WORLD_CHAIN_RPC_URL ??
          "https://worldchain-mainnet.g.alchemy.com/public",
      ],
    },
  },
};

export type WorldLookup =
  | { state: "backed"; humanIdRaw: string; humanIdOnChain: `0x${string}` }
  | { state: "no-human" }
  | { state: "unreachable"; because: string }
  | { state: "not-configured" };

export function worldConfigured(): boolean {
  const cfg = loadWorldConfig();
  return cfg.enabled;
}

/**
 * Confirm the endpoint is answering and AgentBook is actually deployed there.
 *
 * Two questions rather than one: a reachable endpoint pointed at the wrong chain,
 * or at an address with no code, would answer every lookup with a confident
 * `null`. Checking for bytecode is what turns a silent misconfiguration into a
 * visible one.
 */
async function probeWorldChain(agentBook: `0x${string}`): Promise<string | null> {
  try {
    const client = createPublicClient({ chain: WORLD_CHAIN, transport: http() });
    const id = await client.getChainId();
    if (id !== WORLD_CHAIN.id) {
      return `World Chain RPC reported chain ${id}, expected ${WORLD_CHAIN.id}`;
    }
    const code = await client.getBytecode({ address: agentBook });
    if (!code || code === "0x") {
      return `no contract at AgentBook address ${agentBook} on chain ${id}`;
    }
    return null;
  } catch (e) {
    return `World Chain RPC unreachable: ${(e as Error).message}`.slice(0, 300);
  }
}

export async function lookupHumanBacking(wallet: string): Promise<WorldLookup> {
  const cfg = loadWorldConfig();
  if (!cfg.enabled) return { state: "not-configured" };

  const address = wallet.trim() as `0x${string}`;

  let raw: string | null;
  try {
    raw = await resolveVerifier(cfg).lookupHuman(address);
  } catch (e) {
    // The verifier swallows its own errors, so reaching here means something
    // failed before the call — a bad address, a missing dependency.
    return { state: "unreachable", because: (e as Error).message.slice(0, 300) };
  }

  if (raw) {
    // `lookupHuman` returns `toHex` of a uint256, which is minimal-width rather
    // than padded — so this is almost always hashed rather than passed through.
    // That is the intended direction: nothing about the person should be
    // recoverable from what we store on chain.
    return { state: "backed", humanIdRaw: raw, humanIdOnChain: humanIdToBytes32(raw) };
  }

  // Mock mode has no endpoint to probe, and its `null` is the whole point of it.
  if (cfg.mock) return { state: "no-human" };

  const because = await probeWorldChain(cfg.agentBookAddress ?? DEFAULT_AGENTBOOK);
  if (because) return { state: "unreachable", because };

  return { state: "no-human" };
}
