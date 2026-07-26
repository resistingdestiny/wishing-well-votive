/**
 * Every on-chain read the agent platform needs, with failure kept visible.
 *
 * **The rule, and it has no exceptions in this file: no `.catch(() => 0n)`.**
 * This repo has already shipped a fabricated capability row and labelled VOTIVE
 * balances "ETH", and both reached a demo. The mechanism in both cases was a
 * failed read rendered as a confident value. `operatorStanding` in
 * `protocolState.ts` still does it — each read there is individually
 * `.catch(() => 0n)`, so an RPC outage renders as an operator with no standing
 * rather than as an operator we could not look up.
 *
 * So every function here returns `Read<T>`: either a value we actually read, or
 * `{ ok: false, degraded }` carrying why. Callers render `ReadFailure`. An empty
 * list and a zero are answers, and this module only ever gives an answer it got.
 *
 * The one place a revert is *not* a failure is {@link standingGate}, where the
 * absence of the function is the fact being established.
 */
import { createPublicClient, http, parseAbi, type Chain } from "viem";
import type { TxChain } from "@/lib/txLog";

export type Read<T> = { ok: true; value: T } | { ok: false; degraded: string };

const addr = (k: string): `0x${string}` | undefined => {
  const v = process.env[k];
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : undefined;
};

export const AGENT_CONTRACTS = {
  humanRegistry: addr("NEXT_PUBLIC_WELL_HUMAN_REGISTRY"),
  standingLedger: addr("NEXT_PUBLIC_WELL_STANDING_LEDGER"),
  resourceRegistry: addr("NEXT_PUBLIC_WELL_RESOURCE_REGISTRY"),
  standingAdapter: addr("NEXT_PUBLIC_WELL_STANDING_ADAPTER"),
  baseRail: addr("NEXT_PUBLIC_WELL_BOUNTY_RAIL"),
  hederaRail: addr("NEXT_PUBLIC_HEDERA_BOUNTY_RAIL"),
};

const BASE_SEPOLIA: Chain = {
  id: Number(process.env.NEXT_PUBLIC_WELL_CHAIN_ID ?? 84532),
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_WELL_RPC_URL ?? "https://sepolia.base.org"] },
  },
};

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

function clientFor(chain: TxChain = "base-sepolia") {
  const c = chain === "hedera-testnet" ? HEDERA_TESTNET : BASE_SEPOLIA;
  return createPublicClient({
    chain: c,
    transport: http(undefined, { batch: { wait: 12 } }),
    batch: { multicall: { wait: 12 } },
  });
}

/**
 * A reason short enough to render and specific enough to act on.
 *
 * viem's `message` is several paragraphs of docs and ABI dump, and its first line
 * alone is often a dangling clause — "reverted with the following signature:"
 * with the signature on the next line. `shortMessage` is the one-sentence form,
 * and the revert name is what actually tells a caller whether the bounty does not
 * exist or the endpoint is down.
 */
const why = (e: unknown): string => {
  const err = e as { shortMessage?: string; message?: string; cause?: { data?: { errorName?: string } } };
  const named = err?.cause?.data?.errorName;
  const head = err?.shortMessage ?? err?.message ?? String(e);
  // Collapsed to one line: these are rendered inside a paragraph, and viem's
  // messages carry embedded newlines that would break the layout.
  const flat = head.replace(/\s+/g, " ").trim();
  return (named ? `${named} — ${flat}` : flat).slice(0, 220);
};

const missing = (name: string): string =>
  `${name} is not configured on this deployment (no address set)`;

// ------------------------------------------------------------------- the ABIs

const humanBackingAbi = parseAbi([
  "function humanOf(address wallet) view returns (bytes32)",
  "function assuranceOf(address wallet) view returns (uint8)",
  "function walletCount(bytes32 humanId) view returns (uint256)",
]);

const standingAbi = parseAbi([
  "function isBarred(bytes32 humanId) view returns (bool)",
  "function multiplierBpsOf(bytes32 humanId) view returns (uint256)",
  "struct Standing { uint32 fulfilments; uint32 failures; uint96 penaltyBps; uint32 reports; uint64 barredUntil; uint8 worstSeverity; }",
  "function standingOf(bytes32 humanId) view returns (Standing)",
]);

const railAbi = parseAbi([
  // The custom errors are listed so a revert decodes to a name rather than a
  // bare selector. `NoSuchBounty` in particular is the difference between "that
  // bounty does not exist" and "the endpoint is down", and a caller cannot tell
  // those apart from `0xc71b8a02`.
  "error NoSuchBounty()",
  "error BountyIsClosed()",
  "error AlreadyClaimed()",
  "error NotRegistered()",
  "error CapabilityNotOpen()",
  "error NotInGoodStanding()",
  "error NothingClaimed()",
  "error MilestoneNotAttested()",
  "error MilestoneAlreadyReleased()",
  "error ExceedsRemaining()",
  "error TooSoonToRefund()",
  "error ClaimStillHeld()",
  "error NothingCredited()",
  "struct Bounty { address funder; address agent; address votive; bytes32 taskHash; bytes32 capabilityId; uint256 total; uint256 paid; uint64 claimExpiresAt; uint64 refundableAt; bool closed; }",
  "function bountyOf(uint256 id) view returns (Bounty)",
  "function bountyCount() view returns (uint256)",
  "function payoutOf(address agent) view returns (address)",
  "function credited(address payout) view returns (uint256)",
  "function registry() view returns (address)",
  "function standing() view returns (address)",
  "function milestoneReleased(uint256 id, bytes32 milestoneHash) view returns (bool)",
]);

const resourceRegistryAbi = parseAbi([
  "error Refused(uint8 reason)",
  "error NotTheProvider()",
  "error AlreadyRegistered()",
  "error UnknownTier(uint8 tier)",
  "struct Resource { address provider; uint32 baseLimit; uint8 minAssurance; bool active; bytes32 termsHash; }",
  "function resourceOf(bytes32 resourceId) view returns (Resource)",
  "function quote(address wallet, bytes32 resourceId) view returns (bool allowed, uint8 reason, uint32 effectiveLimit, uint32 remaining)",
  "function epochLength() view returns (uint64)",
  "function currentEpoch() view returns (uint256)",
  "function grantCount() view returns (uint256)",
]);

const adapterAbi = parseAbi(["function isRail(address rail) view returns (bool)"]);

// ------------------------------------------------------------------ the reads

export async function humanBacking(
  wallet: string,
): Promise<Read<{ humanId: `0x${string}`; assurance: number; walletCount: number }>> {
  const registry = AGENT_CONTRACTS.humanRegistry;
  if (!registry) return { ok: false, degraded: missing("HumanBackingRegistry") };
  const pc = clientFor();
  const address = wallet as `0x${string}`;
  try {
    const [humanId, assurance] = await Promise.all([
      pc.readContract({
        address: registry,
        abi: humanBackingAbi,
        functionName: "humanOf",
        args: [address],
      }),
      pc.readContract({
        address: registry,
        abi: humanBackingAbi,
        functionName: "assuranceOf",
        args: [address],
      }),
    ]);
    const count = await pc.readContract({
      address: registry,
      abi: humanBackingAbi,
      functionName: "walletCount",
      args: [humanId],
    });
    return {
      ok: true,
      value: { humanId, assurance: Number(assurance), walletCount: Number(count) },
    };
  } catch (e) {
    return { ok: false, degraded: `could not read human backing: ${why(e)}` };
  }
}

export async function standingFor(humanId: `0x${string}`): Promise<
  Read<{
    barred: boolean;
    multiplierBps: bigint;
    fulfilments: number;
    failures: number;
    reports: number;
    penaltyBps: number;
    barredUntil: number;
  }>
> {
  const ledger = AGENT_CONTRACTS.standingLedger;
  if (!ledger) return { ok: false, degraded: missing("StandingLedger") };
  const pc = clientFor();
  try {
    const [barred, multiplierBps, standing] = await Promise.all([
      pc.readContract({
        address: ledger,
        abi: standingAbi,
        functionName: "isBarred",
        args: [humanId],
      }),
      pc.readContract({
        address: ledger,
        abi: standingAbi,
        functionName: "multiplierBpsOf",
        args: [humanId],
      }),
      pc.readContract({
        address: ledger,
        abi: standingAbi,
        functionName: "standingOf",
        args: [humanId],
      }),
    ]);
    return {
      ok: true,
      value: {
        barred,
        multiplierBps,
        fulfilments: standing.fulfilments,
        failures: standing.failures,
        reports: standing.reports,
        penaltyBps: Number(standing.penaltyBps),
        barredUntil: Number(standing.barredUntil),
      },
    };
  } catch (e) {
    return { ok: false, degraded: `could not read standing: ${why(e)}` };
  }
}

export async function bountyOf(
  rail: `0x${string}`,
  id: number,
  chain: TxChain = "base-sepolia",
): Promise<
  Read<{
    funder: `0x${string}`;
    agent: `0x${string}`;
    votive: `0x${string}`;
    taskHash: `0x${string}`;
    capabilityId: `0x${string}`;
    total: bigint;
    paid: bigint;
    claimExpiresAt: number;
    refundableAt: number;
    closed: boolean;
  }>
> {
  try {
    const b = await clientFor(chain).readContract({
      address: rail,
      abi: railAbi,
      functionName: "bountyOf",
      args: [BigInt(id)],
    });
    return {
      ok: true,
      value: {
        funder: b.funder,
        agent: b.agent,
        votive: b.votive,
        taskHash: b.taskHash,
        capabilityId: b.capabilityId,
        total: b.total,
        paid: b.paid,
        claimExpiresAt: Number(b.claimExpiresAt),
        refundableAt: Number(b.refundableAt),
        closed: b.closed,
      },
    };
  } catch (e) {
    return { ok: false, degraded: `could not read bounty #${id}: ${why(e)}` };
  }
}

export async function bountyCount(
  rail: `0x${string}`,
  chain: TxChain = "base-sepolia",
): Promise<Read<number>> {
  try {
    const n = await clientFor(chain).readContract({
      address: rail,
      abi: railAbi,
      functionName: "bountyCount",
    });
    return { ok: true, value: Number(n) };
  } catch (e) {
    return { ok: false, degraded: `could not read bounty count: ${why(e)}` };
  }
}

export async function payoutOf(
  rail: `0x${string}`,
  agent: `0x${string}`,
  chain: TxChain = "base-sepolia",
): Promise<Read<`0x${string}`>> {
  try {
    const v = await clientFor(chain).readContract({
      address: rail,
      abi: railAbi,
      functionName: "payoutOf",
      args: [agent],
    });
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, degraded: `could not read payout address: ${why(e)}` };
  }
}

export async function creditedTo(
  rail: `0x${string}`,
  payout: `0x${string}`,
  chain: TxChain = "base-sepolia",
): Promise<Read<bigint>> {
  try {
    const v = await clientFor(chain).readContract({
      address: rail,
      abi: railAbi,
      functionName: "credited",
      args: [payout],
    });
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, degraded: `could not read credited balance: ${why(e)}` };
  }
}

/**
 * Which attestation registry this rail actually obeys.
 *
 * Read from the rail, never from `NEXT_PUBLIC_WELL_REGISTRY`. The Base rail's
 * registry is `0x7823d1…` while that environment variable holds `0x9620b2…`, and
 * both accept our attestor — so attesting to the wrong one *succeeds*, and then
 * `release` reverts `MilestoneNotAttested`. On screen that reads as "the vote did
 * not count", which is the most misleading failure this system could produce.
 */
export async function railRegistry(
  rail: `0x${string}`,
  chain: TxChain = "base-sepolia",
): Promise<Read<`0x${string}`>> {
  try {
    const v = await clientFor(chain).readContract({
      address: rail,
      abi: railAbi,
      functionName: "registry",
    });
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, degraded: `could not read the rail's registry: ${why(e)}` };
  }
}

export async function milestoneReleased(
  rail: `0x${string}`,
  id: number,
  milestoneHash: `0x${string}`,
  chain: TxChain = "base-sepolia",
): Promise<Read<boolean>> {
  try {
    const v = await clientFor(chain).readContract({
      address: rail,
      abi: railAbi,
      functionName: "milestoneReleased",
      args: [BigInt(id), milestoneHash],
    });
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, degraded: `could not read milestone state: ${why(e)}` };
  }
}

/**
 * Whether this rail checks standing before letting an agent take work on.
 *
 * The only read here where a revert is an answer rather than a failure. The
 * Hedera rail at `0x65E761…` predates the standing gate, and `standing` is an
 * immutable with no owner, so its getter reverts with empty data and cannot be
 * fixed in place. `RailPanel` currently states the gate as fact on a page pointed
 * at that rail, which is false. Distinguishing a revert from an unreachable
 * endpoint is what lets the UI say which of the three situations it is in rather
 * than guessing.
 */
export async function standingGate(
  rail: `0x${string}`,
  chain: TxChain = "base-sepolia",
): Promise<Read<{ gated: boolean; adapter: `0x${string}` | null; reverted: boolean }>> {
  const pc = clientFor(chain);
  let adapter: `0x${string}`;
  try {
    adapter = await pc.readContract({ address: rail, abi: railAbi, functionName: "standing" });
  } catch (e) {
    const name = (e as Error)?.name ?? "";
    const msg = (e as Error)?.message ?? "";
    // A reverted or non-existent function is a fact about the bytecode. A
    // transport error is a fact about us, and must not be reported as the former.
    const isRevert =
      name.includes("ContractFunctionExecutionError") ||
      name.includes("ContractFunctionRevertedError") ||
      /reverted|returned no data|does not exist/i.test(msg);
    if (isRevert) {
      return { ok: true, value: { gated: false, adapter: null, reverted: true } };
    }
    return { ok: false, degraded: `could not check the standing gate: ${why(e)}` };
  }

  const ZERO = "0x0000000000000000000000000000000000000000";
  if (adapter.toLowerCase() === ZERO) {
    return { ok: true, value: { gated: false, adapter: null, reverted: false } };
  }
  return { ok: true, value: { gated: true, adapter, reverted: false } };
}

/** Whether the adapter recognises this rail as one it records for. */
export async function adapterKnowsRail(
  adapter: `0x${string}`,
  rail: `0x${string}`,
): Promise<Read<boolean>> {
  try {
    const v = await clientFor().readContract({
      address: adapter,
      abi: adapterAbi,
      functionName: "isRail",
      args: [rail],
    });
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, degraded: `could not check the adapter: ${why(e)}` };
  }
}

export async function resourceOf(id: `0x${string}`): Promise<
  Read<{
    provider: `0x${string}`;
    baseLimit: number;
    minAssurance: number;
    active: boolean;
    termsHash: `0x${string}`;
  }>
> {
  const registry = AGENT_CONTRACTS.resourceRegistry;
  if (!registry) return { ok: false, degraded: missing("ResourceRegistry") };
  try {
    const r = await clientFor().readContract({
      address: registry,
      abi: resourceRegistryAbi,
      functionName: "resourceOf",
      args: [id],
    });
    return {
      ok: true,
      value: {
        provider: r.provider,
        baseLimit: r.baseLimit,
        minAssurance: r.minAssurance,
        active: r.active,
        termsHash: r.termsHash,
      },
    };
  } catch (e) {
    return { ok: false, degraded: `could not read the resource: ${why(e)}` };
  }
}

/** `Refusal` in `ResourceRegistry.sol`, by index. */
export const REFUSALS = [
  "None",
  "NoSuchResource",
  "Retired",
  "NotHumanBacked",
  "Barred",
  "BelowMinimumAssurance",
  "QuotaExhausted",
] as const;

export function refusalName(code: number): string {
  return REFUSALS[code] ?? `Unknown(${code})`;
}

export async function quoteResource(
  wallet: string,
  id: `0x${string}`,
): Promise<
  Read<{ allowed: boolean; refusal: number; effectiveLimit: bigint; remaining: bigint }>
> {
  const registry = AGENT_CONTRACTS.resourceRegistry;
  if (!registry) return { ok: false, degraded: missing("ResourceRegistry") };
  try {
    const [allowed, reason, effectiveLimit, remaining] = await clientFor().readContract({
      address: registry,
      abi: resourceRegistryAbi,
      functionName: "quote",
      args: [wallet as `0x${string}`, id],
    });
    return {
      ok: true,
      value: {
        allowed,
        refusal: Number(reason),
        effectiveLimit: BigInt(effectiveLimit),
        remaining: BigInt(remaining),
      },
    };
  } catch (e) {
    return { ok: false, degraded: `could not quote the resource: ${why(e)}` };
  }
}

export async function resourceEpoch(): Promise<
  Read<{ epochLength: number; currentEpoch: number; grantCount: number }>
> {
  const registry = AGENT_CONTRACTS.resourceRegistry;
  if (!registry) return { ok: false, degraded: missing("ResourceRegistry") };
  try {
    const pc = clientFor();
    const [epochLength, currentEpoch, grantCount] = await Promise.all([
      pc.readContract({
        address: registry,
        abi: resourceRegistryAbi,
        functionName: "epochLength",
      }),
      pc.readContract({
        address: registry,
        abi: resourceRegistryAbi,
        functionName: "currentEpoch",
      }),
      pc.readContract({
        address: registry,
        abi: resourceRegistryAbi,
        functionName: "grantCount",
      }),
    ]);
    return {
      ok: true,
      value: {
        epochLength: Number(epochLength),
        currentEpoch: Number(currentEpoch),
        grantCount: Number(grantCount),
      },
    };
  } catch (e) {
    return { ok: false, degraded: `could not read the resource registry: ${why(e)}` };
  }
}

/** The block every vote weight in a tally should be pinned to. */
export async function currentBlock(chain: TxChain = "base-sepolia"): Promise<Read<bigint>> {
  try {
    return { ok: true, value: await clientFor(chain).getBlockNumber() };
  } catch (e) {
    return { ok: false, degraded: `could not read the block number: ${why(e)}` };
  }
}
