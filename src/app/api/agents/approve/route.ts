import { NextResponse } from "next/server";
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { approveProposal, onchainModelId, readProposals } from "@/lib/solverAgents";

export const dynamic = "force-dynamic";

const registrySolverAbi = parseAbi([
  "function setSolver(bytes32 modelId, address payout)",
  "function solverOf(bytes32 modelId) view returns (address)",
]);

export async function POST(req: Request) {
  const expected = process.env.WELL_CURATOR_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "approvals disabled (no curator token configured)" },
      { status: 503 },
    );
  }
  if (req.headers.get("x-curator-token") !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { id?: string };
  if (!body.id || !readProposals().some((p) => p.id === body.id)) {
    return NextResponse.json({ error: "unknown proposal id" }, { status: 404 });
  }

  try {
    const proposal = approveProposal(body.id);

    let solverTx: string | undefined;
    const ownerPk = process.env.WELL_SOLVER_OWNER_PK as `0x${string}` | undefined;
    const registry = process.env.WELL_REGISTRY as `0x${string}` | undefined;
    if (ownerPk && registry) {
      const rpcUrl = process.env.WELL_RPC_URL ?? "http://127.0.0.1:8545";
      const chain = {
        id: Number(process.env.WELL_CHAIN_ID ?? 31337),
        name: "well",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      };
      const account = privateKeyToAccount(ownerPk);
      const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
      const pub = createPublicClient({ chain, transport: http(rpcUrl) });
      solverTx = await wallet.writeContract({
        address: registry,
        abi: registrySolverAbi,
        functionName: "setSolver",
        args: [onchainModelId(proposal.model), proposal.payout],
        account,
        chain,
      });
      await pub.waitForTransactionReceipt({ hash: solverTx as `0x${string}` });
    }
    return NextResponse.json({ proposal, solverTx: solverTx ?? null });
  } catch (e) {
    console.error("agent approve:", (e as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
