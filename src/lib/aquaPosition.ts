/**
 * A votive as a tradeable Aqua position, read live.
 *
 * The protocol holds a wish and waits. Aqua turns that wait into something
 * somebody else can take the other side of: a position priced by four SwapVM
 * instructions that read the protocol directly, so it *cannot* be filled until the
 * frontier has reached the job the wish was opened for.
 *
 * Everything here is a read. The gates are asked of the same attestation registry
 * the VM asks, and the balances of the same Aqua contract that custodies them, so
 * what this page says and what a fill would actually do cannot drift apart.
 */
import { createPublicClient, http, parseAbi, type Chain } from "viem";
import { prisma } from "@/lib/db";
import { explorerAddress } from "@/lib/txLog";

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
const word = (k: string): `0x${string}` | undefined => {
  const v = process.env[k];
  return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as `0x${string}`) : undefined;
};

export const AQUA = {
  aqua: addr("NEXT_PUBLIC_AQUA"),
  router: addr("NEXT_PUBLIC_AQUA_ROUTER"),
  tokenA: addr("NEXT_PUBLIC_AQUA_TOKEN_A"),
  tokenB: addr("NEXT_PUBLIC_AQUA_TOKEN_B"),
  taker: addr("NEXT_PUBLIC_AQUA_TAKER"),
  strategy: word("NEXT_PUBLIC_AQUA_STRATEGY"),
  votive: addr("NEXT_PUBLIC_AQUA_VOTIVE"),
};

const aquaAbi = parseAbi([
  "function safeBalances(address maker, address vm, bytes32 strategyHash, address tokenA, address tokenB) view returns (uint256, uint256)",
]);

const routerAbi = parseAbi([
  "function votiveOpcodeBase() view returns (uint256)",
  "function VOTIVE_OPCODE_COUNT() view returns (uint256)",
]);

const registryAbi = parseAbi([
  "function isCapabilityOpen(bytes32) view returns (bool)",
  "function isConditionMet(address votive, bytes32 conditionHash) view returns (bool)",
]);

const votiveAbi = parseAbi([
  "function state() view returns (uint8)",
  "function strategyHash() view returns (bytes32)",
  "function offered() view returns (uint256)",
  "function principal() view returns (uint256)",
  "struct Intent { uint8 kind; address founder; address guardian; address beneficiary; address fallbackTo; bytes32 capabilityId; bytes32 conditionHash; bytes32 storyHash; uint256 expenseBudget; bool irrevocable; }",
  "function intent() view returns (Intent)",
]);

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
]);

/** Why a position cannot be filled, in the order the VM checks. */
export type PositionBlocker =
  | "none"
  | "settled"
  | "capability-closed"
  | "condition-unmet"
  | "not-configured";

export interface AquaPosition {
  configured: boolean;
  /**
   * Whether the votive itself says it has a position open.
   *
   * The contract, not our record of it. A row in the database says a position was
   * shipped once; only `strategyHash()` says one is open now — and the two part
   * company the moment anybody docks, which is exactly what happened the first
   * time this was wired up: the page offered "close" on a position that had
   * already been closed.
   */
  open: boolean;
  /**
   * Whether the chain actually answered.
   *
   * Every read here has a fallback, which is right — one missing symbol should
   * not blank the panel. But when the *whole* set falls back, the zeros are not
   * facts: they render as "0 instructions, 0 balance, already settled", which is
   * a confident description of a position that is fine. A page whose only job is
   * to be checkable must not do that, so a total failure is reported as one.
   */
  degraded: boolean;
  aqua: string;
  router: string;
  strategy: string;
  votive: string;

  /** Where our four instructions sit in the router's opcode table. */
  opcodeBase: number;
  opcodeCount: number;

  /** The votive the position is priced off. */
  votiveState: number;
  principal: bigint;

  capabilityOpen: boolean;
  conditionMet: boolean;
  fillable: boolean;
  blocker: PositionBlocker;

  /**
   * What the maker has committed to this strategy.
   *
   * Not a custodial balance. Aqua holds no tokens at all — `ship` writes an
   * accounting entry and a fill does `safeTransferFrom(maker, taker, …)` against
   * the maker's own allowance. Verified on chain: this strategy declares 146 VDA
   * while the Aqua contract's own token balance is zero.
   */
  makerTokenA: bigint;
  makerTokenB: bigint;
  takerTokenB: bigint;
  treasuryTokenA: bigint;
  symbolA: string;
  symbolB: string;

  explorer: { aqua: string; router: string; votive: string };
}

const ZERO_WORD = `0x${"0".repeat(64)}`;

const TREASURY = "0x0000000000000000000000000000000000000FEE" as const;

/** Where a position's identifying details come from. */
interface StrategyRecord {
  votive: `0x${string}`;
  strategyHash: `0x${string}`;
  aqua: `0x${string}`;
  router: `0x${string}`;
  maker: `0x${string}`;
  taker?: `0x${string}`;
  tokenA: `0x${string}`;
  tokenB: `0x${string}`;
}

/**
 * Find the position shipped for a votive.
 *
 * The database first, because Aqua keys custody on (maker, vm, strategyHash,
 * pair) and none of that is derivable from a votive's address — a protocol with
 * more than one position cannot find the second one any other way. Environment
 * variables are the fallback, and they can only ever describe one.
 */
export async function strategyFor(
  votive?: `0x${string}`,
): Promise<StrategyRecord | null> {
  const row = await prisma.aquaStrategy
    .findFirst({
      ...(votive ? { where: { votive: votive.toLowerCase() } } : {}),
      orderBy: { createdAt: "desc" },
    })
    .catch(() => null);

  if (row) {
    return {
      votive: row.votive as `0x${string}`,
      strategyHash: row.strategyHash as `0x${string}`,
      aqua: row.aqua as `0x${string}`,
      router: row.router as `0x${string}`,
      maker: row.maker as `0x${string}`,
      ...(row.taker ? { taker: row.taker as `0x${string}` } : {}),
      tokenA: row.tokenA as `0x${string}`,
      tokenB: row.tokenB as `0x${string}`,
    };
  }

  const maker = addr("NEXT_PUBLIC_AQUA_MAKER");
  if (!AQUA.aqua || !AQUA.router || !AQUA.tokenA || !AQUA.tokenB || !AQUA.strategy || !AQUA.votive || !maker) {
    return null;
  }
  // Only answer from the environment when it describes the votive being asked
  // about; otherwise a wish with no position would show somebody else's.
  if (votive && votive.toLowerCase() !== AQUA.votive.toLowerCase()) return null;

  return {
    votive: AQUA.votive,
    strategyHash: AQUA.strategy,
    aqua: AQUA.aqua,
    router: AQUA.router,
    maker,
    ...(AQUA.taker ? { taker: AQUA.taker } : {}),
    tokenA: AQUA.tokenA,
    tokenB: AQUA.tokenB,
  };
}

export async function readAquaPosition(
  forVotive?: `0x${string}`,
): Promise<AquaPosition | null> {
  const found = await strategyFor(forVotive);
  const registry = addr("NEXT_PUBLIC_WELL_REGISTRY");
  if (!found || !registry) return null;

  const { aqua, router, tokenA, tokenB, taker, strategyHash: strategy, votive } = found;

  // Batched: a dozen small reads answered one at a time against a public endpoint
  // is the difference between a page and a wait.
  const pc = createPublicClient({
    chain: BASE_SEPOLIA,
    transport: http(undefined, { batch: { wait: 12 } }),
    batch: { multicall: { wait: 12 } },
  });

  // Whoever shipped the strategy. Aqua keys custody on the maker, so with the
  // wrong one the balance read is not "zero", it is a different strategy's.
  const maker = found.maker;

  const [intent, state, principal, base, count, symA, symB, liveHash] = await Promise.all([
    pc.readContract({ address: votive, abi: votiveAbi, functionName: "intent" }).catch(() => null),
    pc.readContract({ address: votive, abi: votiveAbi, functionName: "state" }).catch(() => 0),
    pc.readContract({ address: votive, abi: votiveAbi, functionName: "principal" }).catch(() => 0n),
    pc
      .readContract({ address: router, abi: routerAbi, functionName: "votiveOpcodeBase" })
      .catch(() => 0n),
    pc
      .readContract({ address: router, abi: routerAbi, functionName: "VOTIVE_OPCODE_COUNT" })
      .catch(() => 0n),
    pc.readContract({ address: tokenA, abi: erc20, functionName: "symbol" }).catch(() => "A"),
    pc.readContract({ address: tokenB, abi: erc20, functionName: "symbol" }).catch(() => "B"),
    pc
      .readContract({ address: votive, abi: votiveAbi, functionName: "strategyHash" })
      .catch(() => ZERO_WORD),
  ]);

  // The votive's own hash wins when it has one. The stored row is only ever the
  // identifying details — which Aqua, which router, which pair — none of which a
  // votive exposes.
  const openHash = String(liveHash) !== ZERO_WORD ? (liveHash as `0x${string}`) : null;

  const i = intent as { capabilityId: `0x${string}`; conditionHash: `0x${string}` } | null;

  const [capabilityOpen, conditionMet, balances, takerB, treasuryA] = await Promise.all([
    i
      ? pc
          .readContract({
            address: registry,
            abi: registryAbi,
            functionName: "isCapabilityOpen",
            args: [i.capabilityId],
          })
          .catch(() => false)
      : Promise.resolve(false),
    i
      ? pc
          .readContract({
            address: registry,
            abi: registryAbi,
            functionName: "isConditionMet",
            args: [votive, i.conditionHash],
          })
          .catch(() => false)
      : Promise.resolve(false),
    maker
      ? pc
          .readContract({
            address: aqua,
            abi: aquaAbi,
            functionName: "safeBalances",
            args: [maker, router, strategy, tokenA, tokenB],
          })
          .catch(() => [0n, 0n] as const)
      : Promise.resolve([0n, 0n] as const),
    taker
      ? pc
          .readContract({ address: tokenB, abi: erc20, functionName: "balanceOf", args: [taker] })
          .catch(() => 0n)
      : Promise.resolve(0n),
    pc
      .readContract({ address: tokenA, abi: erc20, functionName: "balanceOf", args: [TREASURY] })
      .catch(() => 0n),
  ]);

  const s = Number(state);
  const live = s >= 1 && s <= 2;

  // The opcode base is the tell. It is a constant on a deployed router and can
  // never legitimately be zero, so a zero means the call did not land rather than
  // that the router has no instructions.
  const degraded = Number(base) === 0;

  // The order matters and mirrors the program: the lifecycle gate runs first,
  // then the capability, then the condition. Reporting them in a different order
  // would tell an operator to fix the wrong thing.
  const blocker: PositionBlocker = !live
    ? "settled"
    : !capabilityOpen
      ? "capability-closed"
      : !conditionMet
        ? "condition-unmet"
        : "none";

  return {
    configured: true,
    open: openHash !== null,
    degraded,
    aqua,
    router,
    strategy: openHash ?? strategy,
    votive,
    opcodeBase: Number(base),
    opcodeCount: Number(count),
    votiveState: s,
    principal: principal as bigint,
    capabilityOpen: capabilityOpen as boolean,
    conditionMet: conditionMet as boolean,
    fillable: blocker === "none",
    blocker,
    makerTokenA: (balances as readonly bigint[])[0] ?? 0n,
    makerTokenB: (balances as readonly bigint[])[1] ?? 0n,
    takerTokenB: takerB as bigint,
    treasuryTokenA: treasuryA as bigint,
    symbolA: symA as string,
    symbolB: symB as string,
    explorer: {
      aqua: explorerAddress("base-sepolia", aqua),
      router: explorerAddress("base-sepolia", router),
      votive: explorerAddress("base-sepolia", votive),
    },
  };
}

export function explainBlocker(blocker: PositionBlocker): string {
  switch (blocker) {
    case "none":
      return "Fillable now — both gates are open and the votive is still live.";
    case "settled":
      return "Not fillable: this votive has already settled, so its position is closed.";
    case "capability-closed":
      return "Not fillable: no model has demonstrated the capability this wish waits on. This is the point of the position — it cannot be taken until the frontier arrives.";
    case "condition-unmet":
      return "Not fillable: the frontier has arrived, but this particular wish has not been attested true yet.";
    case "not-configured":
      return "No Aqua position is configured for this deployment.";
  }
}
