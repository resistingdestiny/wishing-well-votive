import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { agentDataDir } from "@/lib/ingest";
import { buildCapabilityDataset } from "@/core/bench/dataset";
import { CapabilityStore } from "@/core/sweep/capabilityStore";
import type { SignedRunLogEntry } from "@/core/runlog/verify";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: { capabilityId: string } },
) {
  const capId = params.capabilityId;
  if (!/^0x[0-9a-fA-F]{64}$/.test(capId)) {
    return NextResponse.json({ error: "invalid capability id" }, { status: 400 });
  }
  const dir = agentDataDir();
  const file = path.join(dir, "runlog.jsonl");
  const entries: SignedRunLogEntry[] = fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as SignedRunLogEntry)
    : [];

  const cap = new CapabilityStore(dir).get(capId as `0x${string}`);
  const dataset = buildCapabilityDataset(capId as `0x${string}`, entries, {
    summary: cap?.summary,
    eval: cap?.eval,
  });
  if (dataset.records.length === 0) {
    return NextResponse.json(
      { error: "no capability checks recorded for this id" },
      { status: 404 },
    );
  }

  const download = new URL(req.url).searchParams.get("download") === "1";
  return new NextResponse(JSON.stringify(dataset, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(download
        ? { "content-disposition": `attachment; filename="wwbench-${capId.slice(0, 10)}.json"` }
        : {}),
    },
  });
}
