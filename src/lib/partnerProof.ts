/**
 * Live proof that the partner rails answer — read from their own chains on every
 * load, in keeping with the rest of /live: a cached claim about an integration
 * is a wrong claim as soon as the integration breaks.
 *
 * Hedera is asked directly: the bounty rail's own counters and its latest bounty,
 * over the public JSON-RPC relay. World is asked through the same lookup the
 * verify flow uses, so what this panel reports and what a real verification
 * would do cannot drift apart. Every read degrades to an honest "could not be
 * read" rather than a confident zero.
 */
import { createPublicClient, http, parseAbi, type Chain } from "viem";
import { DEFAULT_AGENTBOOK, lookupHumanBacking, worldConfigured } from "@/lib/worldVerify";
import { explorerAddress } from "@/lib/txLog";

const HEDERA_TESTNET: Chain = {
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_HEDERA_RPC_URL ?? "https://testnet.hashio.io/api"],
    },
  },
};

const railAbi = parseAbi([
  "function bountyCount() view returns (uint256)",
  "function escrowed() view returns (uint256)",
  "struct Bounty { address funder; address agent; address votive; bytes32 taskHash; bytes32 capabilityId; uint256 total; uint256 paid; uint64 claimExpiresAt; uint64 refundableAt; bool closed; }",
  "function bountyOf(uint256 id) view returns (Bounty)",
]);

export interface HederaProof {
  configured: boolean;
  /** True when the rail itself answered; false renders as a failure, not zeros. */
  answering: boolean;
  rail: string;
  bounties: number;
  /** The rail holds native HBAR; these are tinybars (8 decimals), pre-formatted. */
  escrowedHbar: string;
  latest: { id: number; agent: string; totalHbar: string; paidHbar: string; closed: boolean } | null;
  explorer: string;
}

export interface WorldProof {
  configured: boolean;
  /** backed | no-human | unreachable — `no-human` still proves the read path. */
  state: string;
  detail: string;
  agentBook: string;
  explorer: string;
}

/** Tinybars → a display HBAR figure. The relay reports balances in 18 decimals
 *  but the rail's own accounting is native tinybars — this is the 8-decimal side. */
const hbar = (tinybars: bigint): string => {
  const n = Number(tinybars) / 1e8;
  return n.toFixed(n === Math.trunc(n) ? 0 : 2);
};

export async function hederaProof(): Promise<HederaProof> {
  const rail = process.env.NEXT_PUBLIC_HEDERA_BOUNTY_RAIL;
  const none: HederaProof = {
    configured: false,
    answering: false,
    rail: rail ?? "",
    bounties: 0,
    escrowedHbar: "0",
    latest: null,
    explorer: rail ? explorerAddress("hedera-testnet", rail) : "",
  };
  if (!rail || !/^0x[0-9a-fA-F]{40}$/.test(rail)) return none;

  const pc = createPublicClient({ chain: HEDERA_TESTNET, transport: http() });
  try {
    const [count, escrowed] = await Promise.all([
      pc.readContract({ address: rail as `0x${string}`, abi: railAbi, functionName: "bountyCount" }),
      pc.readContract({ address: rail as `0x${string}`, abi: railAbi, functionName: "escrowed" }),
    ]);
    const n = Number(count);
    const latest =
      n > 0
        ? await pc
            .readContract({
              address: rail as `0x${string}`,
              abi: railAbi,
              functionName: "bountyOf",
              args: [BigInt(n)],
            })
            .then((b) => ({
              id: n,
              agent: b.agent,
              totalHbar: hbar(b.total),
              paidHbar: hbar(b.paid),
              closed: b.closed,
            }))
            .catch(() => null)
        : null;
    return {
      configured: true,
      answering: true,
      rail,
      bounties: n,
      escrowedHbar: hbar(escrowed as bigint),
      latest,
      explorer: explorerAddress("hedera-testnet", rail),
    };
  } catch {
    return { ...none, configured: true };
  }
}

export async function worldProof(probeWallet?: string): Promise<WorldProof> {
  const agentBook = process.env.WELL_AGENTBOOK_ADDRESS ?? DEFAULT_AGENTBOOK;
  const explorer = `https://worldscan.org/address/${agentBook}`;
  if (!worldConfigured()) {
    return {
      configured: false,
      state: "not-configured",
      detail: "World verification is disabled on this deployment.",
      agentBook,
      explorer,
    };
  }
  // Any wallet proves the read path: `no-human` is AgentBook answering "not
  // registered", which is exactly as much proof of liveness as a hit.
  const wallet = probeWallet ?? "0x7D4eF63858fd0338462747ac34c0D221518aB656";
  const look = await lookupHumanBacking(wallet).catch(() => null);
  if (!look) {
    return { configured: true, state: "unreachable", detail: "the lookup threw before reaching World Chain", agentBook, explorer };
  }
  const detail =
    look.state === "backed"
      ? "AgentBook answered: a verified human stands behind the probe wallet."
      : look.state === "no-human"
        ? "AgentBook answered from World Chain: no verified human is registered against the probe wallet yet — the read path is live."
        : ("because" in look && look.because) || "World Chain could not be reached.";
  return { configured: true, state: look.state, detail, agentBook, explorer };
}
