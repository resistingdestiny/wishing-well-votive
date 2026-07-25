/**
 * What the protocol looks like right now, asked of the contracts themselves.
 *
 * Every number here comes from a view function on each read. Nothing is cached and
 * nothing is reconstructed from events: a votive's phase, an operator's standing
 * and what is left of an allowance can all change without this application being
 * involved, and a cached answer to any of them is a wrong answer that looks
 * authoritative.
 *
 * The companion to this is `txLog`, which records what *happened*. History is
 * written once and read back; state is read fresh and never written down.
 */
import { createPublicClient, http, parseAbi, type Chain } from "viem";
import { cellAbi, factoryAbi } from "@/lib/chain";
import { explorerAddress, type TxChain } from "@/lib/txLog";

const BASE_SEPOLIA: Chain = {
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_WELL_RPC_URL ?? "https://sepolia.base.org"] },
  },
};

const addr = (k: string): `0x${string}` | undefined => {
  const v = process.env[k];
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : undefined;
};

export const CONTRACTS = {
  factory: addr("NEXT_PUBLIC_WELL_FACTORY"),
  registry: addr("NEXT_PUBLIC_WELL_REGISTRY"),
  humanRegistry: addr("NEXT_PUBLIC_WELL_HUMAN_REGISTRY"),
  standingLedger: addr("NEXT_PUBLIC_WELL_STANDING_LEDGER"),
  commonsPool: addr("NEXT_PUBLIC_WELL_COMMONS_POOL"),
  resourceRegistry: addr("NEXT_PUBLIC_WELL_RESOURCE_REGISTRY"),
  humanGate: addr("NEXT_PUBLIC_WELL_HUMAN_GATE"),
  bountyRailHedera: addr("NEXT_PUBLIC_HEDERA_BOUNTY_RAIL"),
};

export const humanBackingAbi = parseAbi([
  "function humanOf(address wallet) view returns (bytes32)",
  "function assuranceOf(address wallet) view returns (uint8)",
  "function isHumanBacked(address wallet) view returns (bool)",
  "function walletCount(bytes32 humanId) view returns (uint256)",
]);

export const standingAbi = parseAbi([
  "function isBarred(bytes32 humanId) view returns (bool)",
  "function multiplierBpsOf(bytes32 humanId) view returns (uint256)",
  "struct Standing { uint32 fulfilments; uint32 failures; uint96 penaltyBps; uint32 reports; uint64 barredUntil; uint8 worstSeverity; }",
  "function standingOf(bytes32 humanId) view returns (Standing)",
]);

export const commonsAbi = parseAbi([
  "function ceilingOf(address wallet) view returns (uint256)",
  "function remainingOf(address wallet) view returns (uint256)",
  "function baseAllowance() view returns (uint256)",
  "function currentEpoch() view returns (uint256)",
]);

export const resourceAbi = parseAbi([
  "struct Resource { address provider; uint32 baseLimit; uint8 minAssurance; bool active; bytes32 termsHash; }",
  "function resourceOf(bytes32 resourceId) view returns (Resource)",
  "function effectiveLimitOf(address wallet, bytes32 resourceId) view returns (uint32)",
  "function quote(address wallet, bytes32 resourceId) view returns (bool allowed, uint8 reason, uint32 effectiveLimit, uint32 remaining)",
]);

export const gateAbi = parseAbi([
  "function isPermitted(address account) view returns (bool permitted)",
]);

/**
 * One client, batching aggressively.
 *
 * This page asks a dozen small questions — a votive's phase, its principal, an
 * operator's tier, what is left of an allowance — and against a public endpoint
 * each round trip costs over a second. Answered one at a time that was a
 * twenty-second page load for data that fits in a single response.
 *
 * `batch` collapses them into JSON-RPC batches, and `multicall` lets viem fold
 * eligible reads into one `Multicall3` call. Both are transport-level, so the
 * code above stays a list of plain reads and does not have to be written as a
 * batch to benefit from being one.
 */
function client() {
  return createPublicClient({
    chain: BASE_SEPOLIA,
    transport: http(undefined, { batch: { wait: 12 } }),
    batch: { multicall: { wait: 12 } },
  });
}

// ---------------------------------------------------------------- the shapes

export interface VotivePosition {
  address: `0x${string}`;
  state: number;
  stateName: string;
  kind: number;
  principal: bigint;
  parked: bigint;
  pendingStream: bigint;
  explorerUrl: string;
}

export interface OperatorStanding {
  wallet: `0x${string}`;
  humanId: `0x${string}` | null;
  assurance: number;
  walletCount: bigint;
  barred: boolean;
  multiplierBps: bigint;
  fulfilments: number;
  failures: number;
  reports: number;
  ceiling: bigint;
  remaining: bigint;
  admitted: boolean;
}

const STATES = ["Nascent", "Waiting", "Attempting", "Fulfilled", "Redirected", "Escheated"];
const ZERO_WORD = `0x${"0".repeat(64)}`;

/**
 * Every votive the factory has ever opened, with its current phase.
 *
 * `allVotives()` is one call that returns the whole list, which is why this needs
 * no event replay and no block-range window: the factory already keeps the index.
 */
export async function votivePositions(limit = 50): Promise<VotivePosition[]> {
  if (!CONTRACTS.factory) return [];
  const pc = client();

  const all = (await pc
    .readContract({ address: CONTRACTS.factory, abi: factoryAbi, functionName: "allVotives" })
    .catch(() => [])) as `0x${string}`[];

  const recent = all.slice(-limit).reverse();

  const settled = await Promise.allSettled(
    recent.map(async (address) => {
      const read = (functionName: string) =>
        pc.readContract({ address, abi: cellAbi, functionName } as never);
      const [state, intent, principal, parked, pending] = await Promise.all([
        read("state"),
        read("intent"),
        read("principal"),
        read("parked"),
        read("pendingStream"),
      ]);
      const kind = Number((intent as { kind: number | bigint }).kind);
      return {
        address,
        state: Number(state),
        stateName: STATES[Number(state)] ?? "?",
        kind,
        principal: principal as bigint,
        parked: parked as bigint,
        pendingStream: pending as bigint,
        explorerUrl: explorerAddress("base-sepolia", address),
      } satisfies VotivePosition;
    }),
  );

  return settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

/**
 * Everything the protocol currently believes about one operator.
 *
 * Deliberately one wallet at a time and driven by the caller. There is no way to
 * enumerate humans from the chain — that is the privacy property working, not a
 * gap — so the wallets worth showing come from what we have transacted with.
 */
export async function operatorStanding(
  wallet: `0x${string}`,
): Promise<OperatorStanding | null> {
  if (!CONTRACTS.humanRegistry || !CONTRACTS.standingLedger) return null;
  const pc = client();

  const humanId = (await pc
    .readContract({
      address: CONTRACTS.humanRegistry,
      abi: humanBackingAbi,
      functionName: "humanOf",
      args: [wallet],
    })
    .catch(() => ZERO_WORD)) as `0x${string}`;

  const backed = humanId !== ZERO_WORD;

  const [assurance, walletCount, barred, multiplier, standing, ceiling, remaining, admitted] =
    await Promise.all([
      pc
        .readContract({
          address: CONTRACTS.humanRegistry,
          abi: humanBackingAbi,
          functionName: "assuranceOf",
          args: [wallet],
        })
        .catch(() => 0),
      backed
        ? pc
            .readContract({
              address: CONTRACTS.humanRegistry,
              abi: humanBackingAbi,
              functionName: "walletCount",
              args: [humanId],
            })
            .catch(() => 0n)
        : Promise.resolve(0n),
      backed
        ? pc
            .readContract({
              address: CONTRACTS.standingLedger,
              abi: standingAbi,
              functionName: "isBarred",
              args: [humanId],
            })
            .catch(() => false)
        : Promise.resolve(false),
      backed
        ? pc
            .readContract({
              address: CONTRACTS.standingLedger,
              abi: standingAbi,
              functionName: "multiplierBpsOf",
              args: [humanId],
            })
            .catch(() => 0n)
        : Promise.resolve(0n),
      backed
        ? pc
            .readContract({
              address: CONTRACTS.standingLedger,
              abi: standingAbi,
              functionName: "standingOf",
              args: [humanId],
            })
            .catch(() => null)
        : Promise.resolve(null),
      CONTRACTS.commonsPool
        ? pc
            .readContract({
              address: CONTRACTS.commonsPool,
              abi: commonsAbi,
              functionName: "ceilingOf",
              args: [wallet],
            })
            .catch(() => 0n)
        : Promise.resolve(0n),
      CONTRACTS.commonsPool
        ? pc
            .readContract({
              address: CONTRACTS.commonsPool,
              abi: commonsAbi,
              functionName: "remainingOf",
              args: [wallet],
            })
            .catch(() => 0n)
        : Promise.resolve(0n),
      CONTRACTS.humanGate
        ? pc
            .readContract({
              address: CONTRACTS.humanGate,
              abi: gateAbi,
              functionName: "isPermitted",
              args: [wallet],
            })
            .catch(() => false)
        : Promise.resolve(false),
    ]);

  const s = standing as {
    fulfilments?: number;
    failures?: number;
    reports?: number;
  } | null;

  return {
    wallet,
    humanId: backed ? humanId : null,
    assurance: Number(assurance),
    walletCount: walletCount as bigint,
    barred: barred as boolean,
    multiplierBps: multiplier as bigint,
    fulfilments: Number(s?.fulfilments ?? 0),
    failures: Number(s?.failures ?? 0),
    reports: Number(s?.reports ?? 0),
    ceiling: ceiling as bigint,
    remaining: remaining as bigint,
    admitted: admitted as boolean,
  };
}

export interface ResourceState {
  resourceId: `0x${string}`;
  provider: `0x${string}`;
  baseLimit: number;
  minAssurance: number;
  active: boolean;
}

export async function resourceState(
  resourceId: `0x${string}`,
): Promise<ResourceState | null> {
  if (!CONTRACTS.resourceRegistry) return null;
  const pc = client();
  const r = (await pc
    .readContract({
      address: CONTRACTS.resourceRegistry,
      abi: resourceAbi,
      functionName: "resourceOf",
      args: [resourceId],
    })
    .catch(() => null)) as ResourceState | null;
  if (!r || !r.provider || /^0x0{40}$/.test(r.provider)) return null;
  return {
    resourceId,
    provider: r.provider,
    baseLimit: Number(r.baseLimit),
    minAssurance: Number(r.minAssurance),
    active: Boolean(r.active),
  };
}

export function contractLinks(): { label: string; address: string; explorerUrl: string; chain: TxChain }[] {
  const rows: [string, `0x${string}` | undefined, TxChain][] = [
    ["VotiveFactory", CONTRACTS.factory, "base-sepolia"],
    ["AttestationRegistry", CONTRACTS.registry, "base-sepolia"],
    ["HumanBackingRegistry", CONTRACTS.humanRegistry, "base-sepolia"],
    ["StandingLedger", CONTRACTS.standingLedger, "base-sepolia"],
    ["CommonsPool", CONTRACTS.commonsPool, "base-sepolia"],
    ["ResourceRegistry", CONTRACTS.resourceRegistry, "base-sepolia"],
    ["HumanBackedAccessGate", CONTRACTS.humanGate, "base-sepolia"],
    ["AgentBountyRail", CONTRACTS.bountyRailHedera, "hedera-testnet"],
  ];
  return rows
    .filter(([, a]) => a)
    .map(([label, a, chain]) => ({
      label,
      address: a as string,
      chain,
      explorerUrl: explorerAddress(chain, a as string),
    }));
}
