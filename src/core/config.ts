import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorldConfig, type WorldConfig } from "./world/agentkit.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface AgentConfig {

  rpcUrl: string;
  chainId: number;

  factoryAddress?: `0x${string}`;
  registryAddress?: `0x${string}`;

  oraclePrivateKey?: `0x${string}`;

  executorPrivateKey?: `0x${string}`;

  dataDir: string;

  modelsFile: string;

  artifactsDir: string;

  perWishTokenBudget: number;

  perWishUsdBudget?: number;

  distributeMode: "public-overflow" | "pro-rata";

  publicOverflowDest?: `0x${string}`;

  perRunMaxTokens: number;

  evalTrials: number;

  passThreshold: number;

  wilsonZ: number;

  requiredStreak: number;

  graphUrl?: string;

  graphMaxLagBlocks: number;

  hederaOperatorId?: string;
  hederaOperatorKey?: string;
  hederaAuditTopic?: string;

  sweepIntervalMs: number;

  releaseCheckIntervalMs: number;

  webhookHost: string;
  webhookPort: number;

  providers: ProvidersConfig;

  world: WorldConfig;

  worldBaseCeilingUsd: number;

  worldStepUpUsd: number;
}

export interface ProvidersConfig {

  blockedJurisdictions: string[];

  usdcAddress?: `0x${string}`;

  privyAppId?: string;
  privyAppSecret?: string;
  privyBaseUrl?: string;

  onrampVendor?: "moonpay" | "transak";
  onrampApiKey?: string;
  onrampBaseUrl?: string;

  bankRailVendor?: "bridge" | "bvnk";
  bankRailApiKey?: string;
  bankRailBaseUrl?: string;

  forceMock: boolean;
}

function parseCsvList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

export function loadProvidersConfig(env: NodeJS.ProcessEnv = process.env): ProvidersConfig {
  return {

    blockedJurisdictions: parseCsvList(env.WELL_BLOCKED_JURISDICTIONS ?? "IR,KP,SY,CU,RU"),
    usdcAddress: (env.WELL_USDC ?? env.NEXT_PUBLIC_WELL_USDC) as `0x${string}` | undefined,
    privyAppId: env.PRIVY_APP_ID,
    privyAppSecret: env.PRIVY_APP_SECRET,
    privyBaseUrl: env.PRIVY_BASE_URL,
    onrampVendor: env.ONRAMP_VENDOR === "transak" ? "transak" : env.ONRAMP_VENDOR === "moonpay" ? "moonpay" : undefined,
    onrampApiKey: env.ONRAMP_API_KEY,
    onrampBaseUrl: env.ONRAMP_BASE_URL,
    bankRailVendor: env.BANK_RAIL_VENDOR === "bvnk" ? "bvnk" : env.BANK_RAIL_VENDOR === "bridge" ? "bridge" : undefined,
    bankRailApiKey: env.BANK_RAIL_API_KEY,
    bankRailBaseUrl: env.BANK_RAIL_BASE_URL,
    forceMock: env.WELL_MOCK_PROVIDERS === "1",
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return {
    rpcUrl: env.WELL_RPC_URL ?? "http://127.0.0.1:8545",
    chainId: Number(env.WELL_CHAIN_ID ?? 31337),
    factoryAddress: env.WELL_FACTORY as `0x${string}` | undefined,
    registryAddress: env.WELL_REGISTRY as `0x${string}` | undefined,
    oraclePrivateKey: env.WELL_ORACLE_PK as `0x${string}` | undefined,
    executorPrivateKey: env.WELL_EXECUTOR_PK as `0x${string}` | undefined,
    dataDir: env.WELL_DATA_DIR ?? path.join(here, "..", "..", "data"),
    modelsFile: env.WELL_MODELS_FILE ?? path.join(here, "..", "models.json"),
    artifactsDir:
      env.WELL_ARTIFACTS_DIR ?? path.join(here, "..", "..", "contracts", "out"),
    perWishTokenBudget: Number(env.WELL_PER_WISH_TOKEN_BUDGET ?? 100_000),
    perWishUsdBudget:
      env.WELL_PER_WISH_USD_BUDGET !== undefined
        ? Number(env.WELL_PER_WISH_USD_BUDGET)
        : undefined,
    distributeMode: env.WELL_DISTRIBUTE_MODE === "pro-rata" ? "pro-rata" : "public-overflow",
    publicOverflowDest: env.WELL_PUBLIC_OVERFLOW_DEST as `0x${string}` | undefined,
    perRunMaxTokens: Number(env.WELL_PER_RUN_MAX_TOKENS ?? 2_000),
    evalTrials: Number(env.WELL_EVAL_TRIALS ?? 5),
    passThreshold: Number(env.WELL_PASS_THRESHOLD ?? 0.5),
    wilsonZ: Number(env.WELL_WILSON_Z ?? 1.96),
    requiredStreak: Number(env.WELL_REQUIRED_STREAK ?? 3),
    graphUrl: env.WELL_GRAPH_URL,
    graphMaxLagBlocks: Number(env.WELL_GRAPH_MAX_LAG_BLOCKS ?? 60),
    hederaOperatorId: env.HEDERA_OPERATOR_ID,
    hederaOperatorKey: env.HEDERA_OPERATOR_KEY,
    hederaAuditTopic: env.HEDERA_AUDIT_TOPIC,
    sweepIntervalMs: Number(env.WELL_SWEEP_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
    releaseCheckIntervalMs: Number(env.WELL_RELEASE_CHECK_INTERVAL_MS ?? 60 * 60 * 1000),
    webhookHost: "127.0.0.1",
    webhookPort: Number(env.WELL_WEBHOOK_PORT ?? 8790),
    providers: loadProvidersConfig(env),
    world: loadWorldConfig(env),
    worldBaseCeilingUsd: Number(env.WELL_HUMAN_SHARED_CAP_USD ?? 100),
    worldStepUpUsd: Number(env.WELL_ORB_STEPUP_USD ?? 0),
  };
}
