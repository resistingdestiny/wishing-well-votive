import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";
import { agentDataDir } from "@/lib/ingest";
import { DistributionStore } from "@/core/distribution/store";

export async function GET(
  req: Request,
  { params }: { params: { cell: string } },
) {
  const cell = params.cell;
  if (!isAddress(cell)) {
    return NextResponse.json({ error: "invalid cell" }, { status: 400 });
  }
  const dist = new DistributionStore(agentDataDir()).get(cell as `0x${string}`);
  if (!dist) {
    return NextResponse.json({ error: "no distribution posted" }, { status: 404 });
  }

  const account = new URL(req.url).searchParams.get("account");
  if (!account || !isAddress(account)) {
    return NextResponse.json({
      root: dist.root,
      totalWeight: dist.totalWeight,
      count: dist.claims.length,
    });
  }

  const target = getAddress(account);
  const leaf = dist.claims.find((c) => getAddress(c.account) === target);
  if (!leaf) {
    return NextResponse.json({ error: "no claim for this account" }, { status: 404 });
  }
  return NextResponse.json(leaf);
}
