/**
 * Mirroring a World lookup onto Base Sepolia.
 *
 * `HumanBackingRegistry.attest` is `onlyAttestor`, so this is the one place in
 * the application that signs with `WELL_ATTESTOR_PK`. The key is read into a viem
 * account and never leaves this module: it is not logged, not returned, and not
 * included in any error message handed back to a caller.
 *
 * **The assurance tier is passed explicitly, and it is DEVICE.** `loadWorldConfig`
 * defaults to `"selfie"`, and inheriting that default here would be a lie with a
 * badge attached: AgentBook tells us a unique human exists and says nothing about
 * how that was evidenced. `SELFIE` asserts a liveness check we never observed.
 * `DEVICE` is what we can actually back, and the badge shown to a user is then
 * rendered from `assuranceOf()` read *back* off the chain rather than from what
 * we believe we wrote.
 *
 * **A broadcast is not a success.** The result is `ok` only after a mined receipt
 * with `status === "success"`. A transaction hash on its own means a transaction
 * exists, not that it did anything, and reporting "verified" off a hash is how a
 * reverted attestation ends up rendered as a green tick.
 */
import { createPublicClient, createWalletClient, http, parseAbi, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ZERO_HUMAN_ID } from "@/core/world/humanId";

/**
 * `AssuranceTiers.DEVICE`. Mirrors `contracts/src/world/AssuranceTiers.sol`:
 * NONE 0, DEVICE 1, SELFIE 2, ORB 3.
 */
export const ATTESTED_ASSURANCE = 1;

const chainId = Number(process.env.NEXT_PUBLIC_WELL_CHAIN_ID ?? 84532);

const CHAIN: Chain = {
  id: chainId,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_WELL_RPC_URL ?? "https://sepolia.base.org"] },
  },
};

const registryAbi = parseAbi([
  "function attest(address wallet, bytes32 humanId, uint8 assurance, bytes32 evidenceHash)",
  "function revoke(address wallet)",
  "function humanOf(address wallet) view returns (bytes32)",
  "function attestor() view returns (address)",
]);

function humanRegistry(): `0x${string}` | null {
  const v = process.env.NEXT_PUBLIC_WELL_HUMAN_REGISTRY;
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : null;
}

function attestorKey(): `0x${string}` | null {
  const v = process.env.WELL_ATTESTOR_PK;
  return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as `0x${string}`) : null;
}

export function attestorConfigured(): boolean {
  return attestorKey() !== null && humanRegistry() !== null;
}

/** The public address we attest from. Safe to display; the key is not. */
export function attestorAddress(): `0x${string}` | null {
  const pk = attestorKey();
  if (!pk) return null;
  try {
    return privateKeyToAccount(pk).address;
  } catch {
    return null;
  }
}

export type AttestResult =
  | { ok: true; txHash: `0x${string}` }
  | {
      ok: false;
      reason: "rebind-refused" | "tx-reverted" | "not-configured" | "send-failed";
      detail: string;
    };

export async function attestHuman(
  wallet: string,
  humanIdOnChain: `0x${string}`,
  assurance: number,
  evidenceHash: `0x${string}`,
): Promise<AttestResult> {
  const registry = humanRegistry();
  const pk = attestorKey();
  if (!registry || !pk) {
    return {
      ok: false,
      reason: "not-configured",
      detail: "no attestor key or human registry address on this deployment",
    };
  }

  const account = privateKeyToAccount(pk);
  const pub = createPublicClient({ chain: CHAIN, transport: http() });
  const address = wallet.trim() as `0x${string}`;

  // The registry reverts `WalletBoundToAnotherHuman` rather than rebinding, and
  // it is right to: silently moving a wallet to a different human would detach a
  // bar from the person it was filed against. Checking first turns a wasted gas
  // fee and an opaque revert into a sentence the caller can put on screen.
  let current: `0x${string}`;
  try {
    current = await pub.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "humanOf",
      args: [address],
    });
  } catch (e) {
    return {
      ok: false,
      reason: "send-failed",
      detail: `could not read current backing: ${(e as Error).message}`.slice(0, 300),
    };
  }

  if (current !== ZERO_HUMAN_ID && current.toLowerCase() !== humanIdOnChain.toLowerCase()) {
    return {
      ok: false,
      reason: "rebind-refused",
      detail: "this wallet is already bound to a different human; it must be revoked first",
    };
  }

  let txHash: `0x${string}`;
  try {
    const wallet_ = createWalletClient({ account, chain: CHAIN, transport: http() });
    // Simulate first so a revert costs nothing and arrives with its reason
    // attached, instead of as a failed receipt with no explanation.
    const { request } = await pub.simulateContract({
      account,
      address: registry,
      abi: registryAbi,
      functionName: "attest",
      args: [address, humanIdOnChain, assurance, evidenceHash],
    });
    txHash = await wallet_.writeContract(request);
  } catch (e) {
    return {
      ok: false,
      reason: "send-failed",
      // The message can carry calldata but never the signing key, which is only
      // ever held in `account`.
      detail: (e as Error).message.slice(0, 300),
    };
  }

  try {
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      return { ok: false, reason: "tx-reverted", detail: `reverted in ${txHash}` };
    }
  } catch (e) {
    return {
      ok: false,
      reason: "send-failed",
      detail: `sent ${txHash} but could not confirm it: ${(e as Error).message}`.slice(0, 300),
    };
  }

  return { ok: true, txHash };
}
