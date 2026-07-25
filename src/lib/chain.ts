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

export const factoryAbi = parseAbi([
  "function activeCells() view returns (address[])",
  "function allCellsLength() view returns (uint256)",
  "function allCells(uint256) view returns (address)",
  "function isCell(address) view returns (bool)",
  "function feeRecipient() view returns (address)",
  "function executor() view returns (address)",
  "function positionRegistry() view returns (address)",
  "function allowedToken(address) view returns (bool)",
  "struct StorySchema { uint8 kind; address wisher; address guardian; address beneficiary; bytes32 capabilityId; bytes32 conditionHash; bytes32 storyHash; uint256 actionBudget; bool isSealed; address fallbackBeneficiary; bytes32 beneficiariesRoot; }",
  "struct Timeouts { uint64 amendAfter; uint64 escheatAfter; uint64 attemptAfter; uint64 claimWindow; }",
  "function createWish(StorySchema schema, Timeouts timeoutOverrides) payable returns (address)",
  "function createWishERC20(StorySchema schema, Timeouts timeoutOverrides, address token, uint256 amount) returns (address)",
]);

export const legacyFactoryAbi = parseAbi([
  "struct StorySchema { uint8 kind; address wisher; address guardian; address beneficiary; bytes32 capabilityId; bytes32 conditionHash; bytes32 storyHash; uint256 actionBudget; bool isSealed; address fallbackBeneficiary; }",
  "struct Timeouts { uint64 amendAfter; uint64 escheatAfter; uint64 attemptAfter; }",
  "function createWish(StorySchema schema, Timeouts timeoutOverrides) payable returns (address)",
  "function createWishERC20(StorySchema schema, Timeouts timeoutOverrides, address token, uint256 amount) returns (address)",
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

export const cellAbi = parseAbi([
  "function state() view returns (uint8)",

  "struct StorySchema { uint8 kind; address wisher; address guardian; address beneficiary; bytes32 capabilityId; bytes32 conditionHash; bytes32 storyHash; uint256 actionBudget; bool isSealed; address fallbackBeneficiary; }",
  "function schema() view returns (StorySchema)",
  "function principal() view returns (uint256)",
  "function parked() view returns (uint256)",
  "function uncollectedStreamFees() view returns (uint256)",
  "function pendingStreamFees() view returns (uint256)",
  "function extraProceeds() view returns (uint256)",
  "function streamFeesAccrued() view returns (uint256)",
  "function streamFeesCollected() view returns (uint256)",
  "function perfFeeTaken() view returns (uint256)",
  "function lastWisherActivity() view returns (uint64)",
  "function attemptStartedAt() view returns (uint64)",

  "function timeouts() view returns (uint64 amendAfter, uint64 escheatAfter, uint64 attemptAfter)",
  "function owedTotal() view returns (uint256)",
  "function amendNonce() view returns (uint256)",
  "function owed(address) view returns (uint256)",

  "function asset() view returns (address)",
  "function positioned() view returns (bool)",
  "function payee() view returns (address)",
  "function positionTokenId() view returns (uint256)",
  "function distributionRoot() view returns (bytes32)",
  "function distributionTotal() view returns (uint256)",
  "function distributionClaimed() view returns (uint256)",
  "function distributionChallengeDeadline() view returns (uint64)",
  "function distributionClaimDeadline() view returns (uint64)",
  "function isClaimed(uint256 index) view returns (bool)",

  "function claimRoot() view returns (bytes32)",
  "function claimTotal() view returns (uint256)",
  "function claimClaimed() view returns (uint256)",
  "function claimTotalWeight() view returns (uint256)",
  "function claimUnclaimed() view returns (uint256)",
  "function claimDeadline() view returns (uint64)",
  "function isBeneficiaryClaimed(uint256 index) view returns (bool)",

  "function fulfilToBeneficiaries(bytes32 merkleRoot, uint256 totalWeight)",
  "function claimBeneficiary(uint256 index, address account, uint256 weight, bytes32[] proof)",
  "function recordIdentityClaim(uint256 index, bytes32 descriptorHash, uint256 weight, bytes32[] proof, address payoutAddr, uint8 rail)",
  "function closeExpiredClaim()",

  "function ping()",
  "function topUp() payable",
  "function topUpERC20(uint256 amount)",
  "function amend(address payout)",
  "function amendWithSig(address payout, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function invalidateAmendSignatures()",
  "function claimOwed()",
  "function claimDistribution(uint256 index, address account, uint256 weight, bytes32[] proof)",
  "function escheat()",
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
  "function capabilityPassed(bytes32) view returns (bool)",
  "function wishCapability(address) view returns (bytes32)",
  "function conditionMet(address cell, bytes32 conditionHash) view returns (bool)",
  "function conditionBinding(bytes32) view returns (bytes32 resolverId, address impl, bytes params, bool bound)",
  "function resolvers(bytes32) view returns (address)",
  "function bindCondition(bytes32 conditionHash, bytes32 resolverId, bytes params)",
]);

export const RESOLVER_KIND: Record<string, string> = {
  [keccak256(toHex("block-number"))]: "block height",
  [keccak256(toHex("price-feed"))]: "price feed",
  [keccak256(toHex("erc20-received"))]: "ERC-20 received",
};

export const WISH_STATES = [
  "Created",
  "Waiting",
  "Attempting",
  "Fulfilled",
  "Amended",
  "Escheated",
  "Claimable",
  "Closed",
] as const;

export const WISH_KINDS = [
  "Return on condition",
  "Distribute to active wishers",
  "Off-chain action (experimental)",
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

export function publicClient() {
  const { chain, rpcUrl } = chainConfig();
  return createPublicClient({ chain, transport: http(rpcUrl) });
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

const SCHEMA_COMPONENTS_BASE: readonly AbiParameter[] = [
  { name: "kind", type: "uint8" },
  { name: "wisher", type: "address" },
  { name: "guardian", type: "address" },
  { name: "beneficiary", type: "address" },
  { name: "capabilityId", type: "bytes32" },
  { name: "conditionHash", type: "bytes32" },
  { name: "storyHash", type: "bytes32" },
  { name: "actionBudget", type: "uint256" },
  { name: "isSealed", type: "bool" },
  { name: "fallbackBeneficiary", type: "address" },
];
const SCHEMA_TUPLE_BASE: AbiParameter = { type: "tuple", components: SCHEMA_COMPONENTS_BASE };
const SCHEMA_TUPLE_FULL: AbiParameter = {
  type: "tuple",
  components: [...SCHEMA_COMPONENTS_BASE, { name: "beneficiariesRoot", type: "bytes32" }],
};

async function readSchema(
  client: ReturnType<typeof publicClient>,
  address: `0x${string}`,
): Promise<SchemaShape> {
  const res = await client.call({
    to: address,
    data: encodeFunctionData({ abi: cellAbi, functionName: "schema" }),
  });
  const ret = (res.data ?? "0x") as `0x${string}`;
  const byteLen = (ret.length - 2) / 2;
  const tuple = byteLen >= 11 * 32 ? SCHEMA_TUPLE_FULL : SCHEMA_TUPLE_BASE;
  const [decoded] = decodeAbiParameters([tuple], ret);
  return decoded as unknown as SchemaShape;
}

const TIMEOUTS_4: readonly AbiParameter[] = [
  { name: "amendAfter", type: "uint64" },
  { name: "escheatAfter", type: "uint64" },
  { name: "attemptAfter", type: "uint64" },
  { name: "claimWindow", type: "uint64" },
];
const TIMEOUTS_3: readonly AbiParameter[] = TIMEOUTS_4.slice(0, 3);

async function readTimeouts(
  client: ReturnType<typeof publicClient>,
  address: `0x${string}`,
): Promise<readonly [bigint, bigint, bigint, bigint?]> {
  const res = await client.call({
    to: address,
    data: encodeFunctionData({ abi: cellAbi, functionName: "timeouts" }),
  });
  const ret = (res.data ?? "0x") as `0x${string}`;
  const byteLen = (ret.length - 2) / 2;
  const params = byteLen >= 4 * 32 ? TIMEOUTS_4 : TIMEOUTS_3;
  const d = decodeAbiParameters(params, ret) as readonly bigint[];
  return [d[0] ?? 0n, d[1] ?? 0n, d[2] ?? 0n, d[3]];
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
      read("streamFeesAccrued"),
      read("pendingStreamFees"),
      read("perfFeeTaken"),
      read("extraProceeds"),
      read("owedTotal"),
      read("lastWisherActivity"),
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
    read("positioned"),
    read("payee"),
    read("positionTokenId"),
    read("distributionRoot"),
    read("distributionTotal"),
    read("distributionClaimed"),
    read("distributionChallengeDeadline"),
    read("distributionClaimDeadline"),
    read("claimRoot"),
    read("claimTotal"),
    read("claimClaimed"),
    read("claimTotalWeight"),
    read("claimUnclaimed"),
    read("claimDeadline"),
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
    functionName: "allCellsLength",
  })) as bigint;
  const target = address.toLowerCase();
  for (let i = 0; i < Number(n); i++) {
    const a = (await client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "allCells",
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
    functionName: "allCellsLength",
  })) as bigint;
  const addrs = await Promise.all(
    Array.from({ length: Number(n) }, (_, i) =>
      client.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "allCells",
        args: [BigInt(i)],
      }),
    ),
  );
  return Promise.all((addrs as `0x${string}`[]).map(readCell));
}
