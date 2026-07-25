import {
  createPublicClient,
  http,
  parseAbi,
  keccak256,
  toHex,
  decodeAbiParameters,
  encodeFunctionData,
  type AbiParameter,
  type Chain,
} from "viem";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

/**
 * The protocol's real factory.
 *
 * The names here are the contract's, not the UI's: a wish is a *votive*, its
 * machine-readable form is an `Intent`, and opening one is `open`. The UI keeps
 * its own vocabulary — this module is the one place the two meet, and translating
 * once here is what keeps every page from having to know both.
 */
export const factoryAbi = parseAbi([
  "function liveVotives() view returns (address[])",
  "function allVotivesLength() view returns (uint256)",
  "function votiveAt(uint256) view returns (address)",
  "function allVotives() view returns (address[])",
  "function isVotive(address) view returns (bool)",
  "function isLive(address) view returns (bool)",
  "function treasury() view returns (address)",
  "function executor() view returns (address)",
  "function registry() view returns (address)",
  "function accessGate() view returns (address)",
  "function allowedToken(address) view returns (bool)",
  "function defaultDeadlines() view returns (uint64 guardianAfter, uint64 escheatAfter, uint64 attemptWindow)",
  "function defaultTerms() view returns (uint16 streamBps, uint16 performanceBps)",
  "struct Intent { uint8 kind; address founder; address guardian; address beneficiary; address fallbackTo; bytes32 capabilityId; bytes32 conditionHash; bytes32 storyHash; uint256 expenseBudget; bool irrevocable; }",
  "struct Deadlines { uint64 guardianAfter; uint64 escheatAfter; uint64 attemptWindow; }",
  "struct Terms { uint16 streamBps; uint16 performanceBps; }",
  "function open(Intent intent, Deadlines deadlineOverrides, Terms maxTerms) payable returns (address)",
  "function openWithToken(Intent intent, Deadlines deadlineOverrides, Terms maxTerms, address token, uint256 amount) returns (address)",
]);

const FIAT_PROBE_ABI = parseAbi(["function allowedVault(address) view returns (bool)"]);

export async function factorySupportsFiatSchema(
  client: unknown,
  factory: `0x${string}`,
): Promise<boolean> {

  const rc = (client as { readContract: (a: unknown) => Promise<unknown> }).readContract;
  try {
    await rc({
      address: factory,
      abi: FIAT_PROBE_ABI,
      functionName: "allowedVault",
      args: [ZERO_ADDR],
    });
    return true;
  } catch {
    return false;
  }
}

/** One votive. Same translation note as the factory above. */
export const cellAbi = parseAbi([
  "function state() view returns (uint8)",

  "struct Intent { uint8 kind; address founder; address guardian; address beneficiary; address fallbackTo; bytes32 capabilityId; bytes32 conditionHash; bytes32 storyHash; uint256 expenseBudget; bool irrevocable; }",
  "function intent() view returns (Intent)",
  "function principal() view returns (uint256)",
  "function parked() view returns (uint256)",
  "function offerings() view returns (uint256)",
  "function unpaidStream() view returns (uint256)",
  "function pendingStream() view returns (uint256)",
  "function streamAccrued() view returns (uint256)",
  "function streamPaid() view returns (uint256)",
  "function performanceCharged() view returns (uint256)",
  "function lastFounderSignal() view returns (uint64)",
  "function lastAccrual() view returns (uint64)",
  "function attemptStartedAt() view returns (uint64)",

  "function deadlines() view returns (uint64 guardianAfter, uint64 escheatAfter, uint64 attemptWindow)",
  "function terms() view returns (uint16 streamBps, uint16 performanceBps)",
  "function guardianOpensAt() view returns (uint256)",
  "function escheatOpensAt() view returns (uint256)",
  "function deferredTotal() view returns (uint256)",
  "function deferred(address) view returns (uint256)",
  "function redirectNonce() view returns (uint256)",

  "function asset() view returns (address)",
  "function beneficiary() view returns (address)",
  "function registry() view returns (address)",
  "function factory() view returns (address)",

  // Sharing with the still-waiting — our ShareWithActive settlement.
  "function shareRoot() view returns (bytes32)",
  "function shareTotal() view returns (uint256)",
  "function shareClaimed() view returns (uint256)",
  "function shareTotalWeight() view returns (uint256)",
  "function shareSnapshotBlock() view returns (uint64)",
  "function shareChallengeEndsAt() view returns (uint64)",
  "function shareClaimEndsAt() view returns (uint64)",
  "function unclaimedShares() view returns (uint256)",
  "function hasClaimedShare(uint256 index) view returns (bool)",
  "function fulfilBySharing(bytes32 root, uint256 totalWeight, uint64 snapshotBlock)",
  "function claimShare(uint256 index, address account, uint256 weight, bytes32[] proof)",
  "function correctShares(bytes32 newRoot, uint256 newTotalWeight)",
  "function sweepUnclaimedShares()",

  "function heartbeat()",
  "function topUp() payable",
  "function accrue()",
  "function settleStream()",
  "function redirect(address to)",
  "function redirectBySignature(address to, uint256 deadline, bytes signature)",
  "function invalidateSignatures()",
  "function claimDeferred()",
  "function beginAttempt()",
  "function endAttempt()",
  "function fulfil()",
  "function escheat()",
  "function sweepStray()",
]);

/**
 * A token-funded votive.
 *
 * Kept apart from `cellAbi` because `topUp` differs between the two: the native
 * one takes value and no arguments, the token one takes an amount and pulls it.
 * Declaring both in one ABI would make `functionName: "topUp"` ambiguous at every
 * call site, and viem resolves that ambiguity by argument count rather than by
 * what the caller meant.
 */
export const tokenVotiveAbi = parseAbi([
  "function topUp(uint256 amount)",
  "function recoverToken(address other)",
  "function recoverNative()",
]);

export const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const erc4626Abi = parseAbi([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
]);

export const registryAbi = parseAbi([
  "function isCapabilityOpen(bytes32) view returns (bool)",
  "function requiredCapability(address) view returns (bytes32)",
  "function isConditionMet(address votive, bytes32 conditionHash) view returns (bool)",
  "function demonstratedBy(bytes32) view returns (uint256)",
  "function pioneer(bytes32) view returns (bytes32)",
  "function attestor() view returns (address)",
  "function attestCapability(bytes32 capabilityId, bytes32 modelId, bool verdict, bytes32 evidence)",
  "function attestCondition(address votive, bytes32 conditionHash, bool verdict, bytes32 evidence)",
]);

export const RESOLVER_KIND: Record<string, string> = {
  [keccak256(toHex("block-number"))]: "block height",
  [keccak256(toHex("price-feed"))]: "price feed",
  [keccak256(toHex("erc20-received"))]: "ERC-20 received",
};

/**
 * `VotiveState`, in the contract's order.
 *
 * The ordinals are what the chain returns, so this array is positional and must
 * not be reordered or padded — index 4 is Redirected, not "Amended", and reading
 * it as anything else mislabels a settled wish on every page that shows a status.
 */
export const WISH_STATES = [
  "Nascent",
  "Waiting",
  "Attempting",
  "Fulfilled",
  "Redirected",
  "Escheated",
] as const;

/**
 * `VotiveKind`, also positional.
 *
 * Worth stating because an earlier vocabulary had these in a different order:
 * index 1 is the real-world task, index 2 is sharing with everyone still waiting.
 * Swapping them would show a wish paying one person as one paying hundreds.
 */
export const WISH_KINDS = [
  "Release on condition",
  "Real-world task",
  "Share with everyone still waiting",
] as const;

export function chainConfig() {
  const rpcUrl = process.env.WELL_RPC_URL ?? "http://127.0.0.1:8545";
  const chainId = Number(process.env.WELL_CHAIN_ID ?? 31337);
  const factory = process.env.WELL_FACTORY as `0x${string}` | undefined;
  const registry = process.env.WELL_REGISTRY as `0x${string}` | undefined;
  const positionRegistry = process.env.WELL_POSITION_REGISTRY as `0x${string}` | undefined;
  const oracle = process.env.WELL_ORACLE as `0x${string}` | undefined;
  const chain: Chain = {
    id: chainId,
    name: chainId === 84532 ? "Base Sepolia" : `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  return { rpcUrl, chainId, factory, registry, positionRegistry, oracle, chain };
}

/**
 * The read client, batching.
 *
 * `readCell` alone asks a votive about twenty questions. Sent one HTTP request at
 * a time that is twenty round trips, and a public endpoint starts refusing part
 * way through — which showed up as the Aqua panel on the same page reporting a
 * position that did not exist, because its reads were the ones that got turned
 * away.
 *
 * Batching folds them into a handful of requests and multicall folds the eligible
 * ones into a single call. Both are transport-level, so nothing above has to be
 * written as a batch to benefit from being one.
 */
export function publicClient() {
  const { chain, rpcUrl } = chainConfig();
  return createPublicClient({
    chain,
    transport: http(rpcUrl, { batch: { wait: 12 } }),
    batch: { multicall: { wait: 12 } },
  });
}

export interface CellView {
  address: `0x${string}`;
  state: number;
  stateName: string;
  kind: number;
  kindName: string;
  wisher: `0x${string}`;
  guardian: `0x${string}`;
  beneficiary: `0x${string}`;
  capabilityId: `0x${string}`;
  conditionHash: `0x${string}`;
  storyHash: `0x${string}`;
  actionBudget: bigint;
  isSealed: boolean;
  fallbackBeneficiary: `0x${string}`;

  beneficiariesRoot: `0x${string}`;
  hasBeneficiaries: boolean;
  principal: bigint;
  balance: bigint;
  parked: bigint;
  feesAccrued: bigint;
  pendingFees: bigint;
  perfFeeTaken: bigint;
  extraProceeds: bigint;
  owedTotal: bigint;
  lastWisherActivity: bigint;
  timeouts: { amendAfter: bigint; escheatAfter: bigint; attemptAfter: bigint; claimWindow: bigint };

  asset: `0x${string}`;
  assetIsNative: boolean;
  assetDecimals: number;
  assetSymbol: string;

  positioned: boolean;
  payee: `0x${string}`;
  positionTokenId: bigint;

  distributionRoot: `0x${string}`;
  distributionTotal: bigint;
  distributionClaimed: bigint;
  distributionChallengeDeadline: bigint;
  distributionClaimDeadline: bigint;

  claimRoot: `0x${string}`;
  claimTotal: bigint;
  claimClaimed: bigint;
  claimTotalWeight: bigint;
  claimUnclaimed: bigint;
  claimDeadline: bigint;
}

const ZERO_ROOT = ("0x" + "0".repeat(64)) as `0x${string}`;

function settled<T>(r: PromiseSettledResult<unknown>, d: T): T {
  return r.status === "fulfilled" ? (r.value as T) : d;
}

/**
 * The UI's view of a wish's fixed terms.
 *
 * Field names are the UI's (`wisher`, `actionBudget`, `isSealed`) and are mapped
 * from the contract's `Intent` (`founder`, `expenseBudget`, `irrevocable`) in one
 * place, just below. Keeping the translation here rather than in the pages means
 * a rename on either side is a single edit.
 */
interface SchemaShape {
  kind: number;
  wisher: `0x${string}`;
  guardian: `0x${string}`;
  beneficiary: `0x${string}`;
  capabilityId: `0x${string}`;
  conditionHash: `0x${string}`;
  storyHash: `0x${string}`;
  actionBudget: bigint;
  isSealed: boolean;
  fallbackBeneficiary: `0x${string}`;
  beneficiariesRoot?: `0x${string}`;
}

/** The contract's `Intent`, as viem decodes it. */
interface IntentShape {
  kind: number;
  founder: `0x${string}`;
  guardian: `0x${string}`;
  beneficiary: `0x${string}`;
  fallbackTo: `0x${string}`;
  capabilityId: `0x${string}`;
  conditionHash: `0x${string}`;
  storyHash: `0x${string}`;
  expenseBudget: bigint;
  irrevocable: boolean;
}

async function readSchema(
  client: ReturnType<typeof publicClient>,
  address: `0x${string}`,
): Promise<SchemaShape> {
  const rc = client.readContract as (a: unknown) => Promise<unknown>;
  const intent = (await rc({ address, abi: cellAbi, functionName: "intent" })) as IntentShape;

  // The share root is not part of the intent — it only exists once a
  // ShareWithActive votive has actually settled — so it is read separately and
  // treated as absent when the votive is still waiting.
  let beneficiariesRoot: `0x${string}` = ZERO_ROOT;
  try {
    beneficiariesRoot = (await rc({
      address,
      abi: cellAbi,
      functionName: "shareRoot",
    })) as `0x${string}`;
  } catch {
    // Not every votive has one, and not having one is not an error.
  }

  return {
    kind: Number(intent.kind),
    wisher: intent.founder,
    guardian: intent.guardian,
    beneficiary: intent.beneficiary,
    capabilityId: intent.capabilityId,
    conditionHash: intent.conditionHash,
    storyHash: intent.storyHash,
    actionBudget: intent.expenseBudget,
    isSealed: intent.irrevocable,
    fallbackBeneficiary: intent.fallbackTo,
    beneficiariesRoot,
  };
}

async function readTimeouts(
  client: ReturnType<typeof publicClient>,
  address: `0x${string}`,
): Promise<readonly [bigint, bigint, bigint, bigint?]> {
  const rc = client.readContract as (a: unknown) => Promise<unknown>;
  const d = (await rc({
    address,
    abi: cellAbi,
    functionName: "deadlines",
  })) as readonly bigint[];
  // guardianAfter, escheatAfter, attemptWindow. There is no fourth clock: the
  // share claim window is a protocol constant rather than a per-votive setting.
  return [d[0] ?? 0n, d[1] ?? 0n, d[2] ?? 0n, undefined];
}

export async function readCell(address: `0x${string}`): Promise<CellView> {
  const client = publicClient();

  const rc = client.readContract as (a: unknown) => Promise<unknown>;
  const read = (functionName: string, args?: readonly unknown[]): Promise<unknown> =>
    rc({ address, abi: cellAbi, functionName, args });

  const [state, schema, principal, parked, feesAccrued, pendingFees, perfFeeTaken, extra, owedTotal, lastActivity, timeouts, balance] =
    await Promise.all([
      read("state"),
      readSchema(client, address),
      read("principal"),
      read("parked"),
      read("streamAccrued"),
      read("pendingStream"),
      read("performanceCharged"),
      read("offerings"),
      read("deferredTotal"),
      read("lastFounderSignal"),
      readTimeouts(client, address),
      client.getBalance({ address }),
    ]);

  const [
    assetR,
    positionedR,
    payeeR,
    tokenIdR,
    distRootR,
    distTotalR,
    distClaimedR,
    distChalR,
    distClaimDlR,
    claimRootR,
    claimTotalR,
    claimClaimedR,
    claimTotalWeightR,
    claimUnclaimedR,
    claimDeadlineR,
  ] = await Promise.allSettled([
    read("asset"),
    read("beneficiary"),
    read("beneficiary"),
    read("redirectNonce"),
    read("shareRoot"),
    read("shareTotal"),
    read("shareClaimed"),
    read("shareChallengeEndsAt"),
    read("shareClaimEndsAt"),
    read("shareRoot"),
    read("shareTotal"),
    read("shareClaimed"),
    read("shareTotalWeight"),
    read("unclaimedShares"),
    read("shareClaimEndsAt"),
  ]);

  const s: SchemaShape = schema;

  const t = timeouts;

  const asset = settled<`0x${string}`>(assetR, ZERO_ADDR);
  const assetIsNative = asset === ZERO_ADDR;
  let assetDecimals = 18;
  let assetSymbol = "ETH";
  if (!assetIsNative) {
    const [decR, symR] = await Promise.allSettled([
      client.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" }),
      client.readContract({ address: asset, abi: erc20Abi, functionName: "symbol" }),
    ]);
    assetDecimals = Number(settled<number | bigint>(decR, 18));
    assetSymbol = settled<string>(symR, "TOKEN");
  }

  return {
    address,
    state: Number(state),
    stateName: WISH_STATES[Number(state)] ?? "?",
    kind: Number(s.kind),
    kindName: WISH_KINDS[Number(s.kind)] ?? "?",
    wisher: s.wisher,
    guardian: s.guardian,
    beneficiary: s.beneficiary,
    capabilityId: s.capabilityId,
    conditionHash: s.conditionHash,
    storyHash: s.storyHash,
    actionBudget: s.actionBudget,
    isSealed: s.isSealed,
    fallbackBeneficiary: s.fallbackBeneficiary,
    beneficiariesRoot: (s.beneficiariesRoot ?? ZERO_ROOT) as `0x${string}`,
    hasBeneficiaries: (s.beneficiariesRoot ?? ZERO_ROOT) !== ZERO_ROOT,
    principal: principal as bigint,
    balance,
    parked: parked as bigint,
    feesAccrued: feesAccrued as bigint,
    pendingFees: pendingFees as bigint,
    perfFeeTaken: perfFeeTaken as bigint,
    extraProceeds: extra as bigint,
    owedTotal: owedTotal as bigint,
    lastWisherActivity: lastActivity as bigint,
    timeouts: { amendAfter: t[0], escheatAfter: t[1], attemptAfter: t[2], claimWindow: t[3] ?? 0n },
    asset,
    assetIsNative,
    assetDecimals,
    assetSymbol,
    positioned: settled<boolean>(positionedR, false),
    payee: settled<`0x${string}`>(payeeR, s.beneficiary === ZERO_ADDR ? s.wisher : s.beneficiary),
    positionTokenId: settled<bigint>(tokenIdR, 0n),
    distributionRoot: settled<`0x${string}`>(distRootR, ZERO_ROOT),
    distributionTotal: settled<bigint>(distTotalR, 0n),
    distributionClaimed: settled<bigint>(distClaimedR, 0n),
    distributionChallengeDeadline: settled<bigint>(distChalR, 0n),
    distributionClaimDeadline: settled<bigint>(distClaimDlR, 0n),
    claimRoot: settled<`0x${string}`>(claimRootR, ZERO_ROOT),
    claimTotal: settled<bigint>(claimTotalR, 0n),
    claimClaimed: settled<bigint>(claimClaimedR, 0n),
    claimTotalWeight: settled<bigint>(claimTotalWeightR, 0n),
    claimUnclaimed: settled<bigint>(claimUnclaimedR, 0n),
    claimDeadline: settled<bigint>(claimDeadlineR, 0n),
  };
}

export async function cellNumber(address: `0x${string}`): Promise<number> {
  const { factory } = chainConfig();
  if (!factory) return 0;
  const client = publicClient();
  const n = (await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "allVotivesLength",
  })) as bigint;
  const target = address.toLowerCase();
  for (let i = 0; i < Number(n); i++) {
    const a = (await client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "votiveAt",
      args: [BigInt(i)],
    })) as `0x${string}`;
    if (a.toLowerCase() === target) return i + 1;
  }
  return 0;
}

export async function listAllCells(): Promise<CellView[]> {
  const { factory } = chainConfig();
  if (!factory) return [];
  const client = publicClient();
  const n = (await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "allVotivesLength",
  })) as bigint;
  const addrs = await Promise.all(
    Array.from({ length: Number(n) }, (_, i) =>
      client.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "votiveAt",
        args: [BigInt(i)],
      }),
    ),
  );
  return Promise.all((addrs as `0x${string}`[]).map(readCell));
}

/**
 * The UI's story schema, as the contract's `Intent`.
 *
 * The two describe the same wish with different names and a different field
 * order, so this is the single place the translation happens. Doing it once, here,
 * is what lets every page keep the vocabulary its copy is written in while the
 * chain keeps the vocabulary its storage is written in.
 *
 * `founder` falls back to the caller because a wish opened without naming one
 * belongs to whoever opened it — the contract requires a non-zero founder and
 * would otherwise revert with nothing useful to say.
 */
export interface StorySchemaLike {
  kind: number | bigint;
  wisher?: `0x${string}`;
  guardian: `0x${string}`;
  beneficiary: `0x${string}`;
  capabilityId: `0x${string}`;
  conditionHash: `0x${string}`;
  storyHash: `0x${string}`;
  actionBudget: bigint;
  isSealed: boolean;
  fallbackBeneficiary: `0x${string}`;
}

export interface IntentArg {
  kind: number;
  founder: `0x${string}`;
  guardian: `0x${string}`;
  beneficiary: `0x${string}`;
  fallbackTo: `0x${string}`;
  capabilityId: `0x${string}`;
  conditionHash: `0x${string}`;
  storyHash: `0x${string}`;
  expenseBudget: bigint;
  irrevocable: boolean;
}

export function toIntent(schema: StorySchemaLike, caller: `0x${string}`): IntentArg {
  const kind = Number(schema.kind);
  return {
    kind,
    founder: schema.wisher && schema.wisher !== ZERO_ADDR ? schema.wisher : caller,
    guardian: schema.guardian,
    beneficiary: schema.beneficiary,
    fallbackTo: schema.fallbackBeneficiary,
    capabilityId: schema.capabilityId,
    conditionHash: schema.conditionHash,
    storyHash: schema.storyHash,
    // Only a real-world task may carry a budget; the contract rejects one on any
    // other kind, so a stale value from a switched form is dropped here rather
    // than reverting the transaction the user just paid gas to send.
    expenseBudget: kind === 1 ? schema.actionBudget : 0n,
    irrevocable: schema.isSealed,
  };
}

/** Clocks left at zero mean "use the factory's defaults". */
export const DEFAULT_DEADLINES = {
  guardianAfter: 0n,
  escheatAfter: 0n,
  attemptWindow: 0n,
} as const;

/** "Whatever you quote" — the ceiling only matters to a founder who set one. */
export const ANY_TERMS = { streamBps: 65535, performanceBps: 65535 } as const;
