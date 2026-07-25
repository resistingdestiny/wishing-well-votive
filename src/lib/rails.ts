import {
  createWalletClient,
  http,
  parseAbi,
  getAddress,
  type Account,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainConfig, publicClient, cellAbi, factoryAbi } from "./chain";
import { agentDataDir } from "./ingest";
import { loadProvidersConfig } from "@/core/config";
import { buildProviders, type Providers } from "@/core/providers/registry";
import type { Settlement, Swap, UsdcAmount } from "@/core/providers/types";
import { ClaimService, type ClaimChain } from "@/core/claims/claimService";

const demoTokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);
const swapAbi = parseAbi([
  "function swapEthForUsdc(address to, uint256 minOut) payable returns (uint256)",
  "function quote(uint256 ethIn) view returns (uint256)",
]);

export interface RailsConfig {
  executor: Account;
  custody: `0x${string}`;
  usdc: `0x${string}`;
  swap?: `0x${string}`;
  factory: `0x${string}`;
}

export function railsConfig(): { ok: true; cfg: RailsConfig } | { ok: false; reason: string } {
  const pk = process.env.WELL_EXECUTOR_PK as `0x${string}` | undefined;
  if (!pk) return { ok: false, reason: "WELL_EXECUTOR_PK not set" };
  const usdc = (process.env.WELL_USDC ?? process.env.NEXT_PUBLIC_WELL_USDC) as `0x${string}` | undefined;
  if (!usdc) return { ok: false, reason: "WELL_USDC / NEXT_PUBLIC_WELL_USDC not set" };
  const { factory } = chainConfig();
  if (!factory) return { ok: false, reason: "WELL_FACTORY not set" };
  const executor = privateKeyToAccount(pk);
  const swap = (process.env.WELL_SWAP ?? process.env.NEXT_PUBLIC_WELL_SWAP) as `0x${string}` | undefined;
  const custody = (process.env.WELL_CUSTODY as `0x${string}` | undefined) ?? executor.address;
  return { ok: true, cfg: { executor, custody: getAddress(custody), usdc: getAddress(usdc), swap: swap ? getAddress(swap) : undefined, factory } };
}

function executorWallet(cfg: RailsConfig): WalletClient {
  const { chain, rpcUrl } = chainConfig();
  return createWalletClient({ account: cfg.executor, chain, transport: http(rpcUrl) });
}

class ChainSettlement implements Settlement {
  constructor(private readonly cfg: RailsConfig, private readonly wallet: WalletClient) {}
  async credit(to: `0x${string}`, amount: UsdcAmount): Promise<{ ref: string }> {
    const client = publicClient();
    const hash = await this.wallet.writeContract({
      address: this.cfg.usdc, abi: demoTokenAbi, functionName: "mint", args: [to, amount],
      account: this.cfg.executor, chain: this.wallet.chain,
    });
    await client.waitForTransactionReceipt({ hash });
    return { ref: hash };
  }
  async debit(_from: `0x${string}`, _amount: UsdcAmount): Promise<{ ref: string }> {

    return { ref: `offramp-fiat:${_amount.toString()}` };
  }
}

class ChainSwap implements Swap {
  constructor(private readonly cfg: RailsConfig, private readonly wallet: WalletClient) {}
  async ethToUsdc(args: { amountWei: bigint; to: `0x${string}`; minOut?: UsdcAmount }): Promise<{ usdcOut: UsdcAmount; ref: string }> {
    if (!this.cfg.swap) throw new Error("MockSwap not configured (WELL_SWAP)");
    const client = publicClient();
    const usdcOut = (await client.readContract({ address: this.cfg.swap, abi: swapAbi, functionName: "quote", args: [args.amountWei] })) as bigint;
    const hash = await this.wallet.writeContract({
      address: this.cfg.swap, abi: swapAbi, functionName: "swapEthForUsdc",
      args: [args.to, args.minOut ?? 0n], value: args.amountWei,
      account: this.cfg.executor, chain: this.wallet.chain,
    });
    await client.waitForTransactionReceipt({ hash });
    return { usdcOut, ref: hash };
  }
}

class ChainClaimChain implements ClaimChain {
  constructor(private readonly cfg: RailsConfig, private readonly wallet: WalletClient) {}
  async recordIdentityClaim(args: {
    cell: `0x${string}`; index: number; descriptorHash: `0x${string}`; weight: bigint;
    proof: `0x${string}`[]; payoutAddr: `0x${string}`; rail: number;
  }): Promise<{ ref: string }> {
    const client = publicClient();
    const hash = await this.wallet.writeContract({
      address: args.cell, abi: cellAbi, functionName: "recordIdentityClaim",
      args: [BigInt(args.index), args.descriptorHash, args.weight, args.proof, args.payoutAddr, args.rail],
      account: this.cfg.executor, chain: this.wallet.chain,
    });
    await client.waitForTransactionReceipt({ hash });
    return { ref: hash };
  }
}

export interface Rails {
  cfg: RailsConfig;
  providers: Providers;
  claim: ClaimService;
  settlement: Settlement;
  swap: Swap;
  chain: ClaimChain;
  wallet: WalletClient;

  createFundedUsdcWish(args: {
    schema: {
      kind: number; guardian: `0x${string}`; beneficiary: `0x${string}`;
      capabilityId: `0x${string}`; conditionHash: `0x${string}`; storyHash: `0x${string}`;
      actionBudget: bigint; isSealed: boolean; fallbackBeneficiary: `0x${string}`;
      beneficiariesRoot: `0x${string}`;
    };
    amountUsdc: bigint;
  }): Promise<`0x${string}`>;
}

export function getRails(): Rails {
  const r = railsConfig();
  if (!r.ok) throw new Error(`fiat rails unavailable: ${r.reason}`);
  const cfg = r.cfg;
  const wallet = executorWallet(cfg);
  const settlement = new ChainSettlement(cfg, wallet);
  const swap = new ChainSwap(cfg, wallet);
  const chain = new ChainClaimChain(cfg, wallet);
  const providersCfg = loadProvidersConfig(process.env);
  const providers = buildProviders(providersCfg, agentDataDir(), settlement);
  const claim = new ClaimService(
    providers.kyc,
    providers.offramp,
    chain,
    { offrampCustody: cfg.custody, swapCustody: cfg.custody },
    swap,
  );

  const createFundedUsdcWish: Rails["createFundedUsdcWish"] = async ({ schema, amountUsdc }) => {
    const client = publicClient();

    const approveHash = await wallet.writeContract({
      address: cfg.usdc, abi: demoTokenAbi, functionName: "approve", args: [cfg.factory, amountUsdc],
      account: cfg.executor, chain: wallet.chain,
    });
    await client.waitForTransactionReceipt({ hash: approveHash });
    const fullSchema = { ...schema, wisher: cfg.executor.address } as const;
    const timeouts = { amendAfter: 0n, escheatAfter: 0n, attemptAfter: 0n, claimWindow: 0n } as const;
    const hash = await wallet.writeContract({
      address: cfg.factory, abi: factoryAbi, functionName: "createWishERC20",
      args: [fullSchema, timeouts, cfg.usdc, amountUsdc], account: cfg.executor, chain: wallet.chain,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const created = receipt.logs.find((l) => l.address.toLowerCase() === cfg.factory.toLowerCase());
    if (!created?.topics[1]) throw new Error("no WishCreated event");
    return getAddress(`0x${created.topics[1].slice(26)}`);
  };

  return { cfg, providers, claim, settlement, swap, chain, wallet, createFundedUsdcWish };
}
