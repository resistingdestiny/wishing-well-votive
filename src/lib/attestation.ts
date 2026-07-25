import { parseAbiItem } from "viem";
import { publicClient, chainConfig } from "@/lib/chain";
import type { SignedRunLogEntry } from "@/core/runlog/verify";

const CAP_ATTESTED = parseAbiItem(
  "event CapabilityAttested(bytes32 indexed capabilityId, bytes32 indexed modelId, bool pass, bytes32 evidenceHash)",
);
const COND_ATTESTED = parseAbiItem(
  "event ConditionAttested(address indexed cell, bytes32 indexed conditionHash, bool met, bytes32 evidenceHash)",
);

export interface AttestationRef {
  txHash: `0x${string}`;
  blockNumber: string;
  kind: "capability" | "condition";

  onchainPass: boolean;
}

export async function findAttestation(
  signed: SignedRunLogEntry,
): Promise<AttestationRef | null> {
  const cfg = chainConfig();
  if (!cfg.registry) return null;
  const client = publicClient();
  const e = signed.entry;
  try {
    if (e.kind === "capability-check" && e.capabilityId) {
      const logs = await client.getLogs({
        address: cfg.registry,
        event: CAP_ATTESTED,
        args: { capabilityId: e.capabilityId },
        fromBlock: 0n,
        toBlock: "latest",
      });
      const m = logs.find(
        (l) => (l.args.evidenceHash ?? "").toLowerCase() === signed.hash.toLowerCase(),
      );
      if (m?.transactionHash) {
        return {
          txHash: m.transactionHash,
          blockNumber: (m.blockNumber ?? 0n).toString(),
          kind: "capability",
          onchainPass: !!m.args.pass,
        };
      }
    } else if (e.kind === "fulfilment-attempt" && e.cell) {
      const logs = await client.getLogs({
        address: cfg.registry,
        event: COND_ATTESTED,
        args: { cell: e.cell },
        fromBlock: 0n,
        toBlock: "latest",
      });
      const m = logs.find(
        (l) => (l.args.evidenceHash ?? "").toLowerCase() === signed.hash.toLowerCase(),
      );
      if (m?.transactionHash) {
        return {
          txHash: m.transactionHash,
          blockNumber: (m.blockNumber ?? 0n).toString(),
          kind: "condition",
          onchainPass: !!m.args.met,
        };
      }
    }
  } catch {

  }
  return null;
}

export function explorerTxUrl(txHash: string): string {
  const { chainId } = chainConfig();
  if (chainId === 84532) return `https://sepolia.basescan.org/tx/${txHash}`;
  if (chainId === 8453) return `https://basescan.org/tx/${txHash}`;
  return `#${txHash}`;
}
