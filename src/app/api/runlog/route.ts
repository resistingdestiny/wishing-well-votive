import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { agentDataDir } from "@/lib/ingest";
import type { SignedRunLogEntry } from "@/core/runlog/verify";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const file = path.join(agentDataDir(), "runlog.jsonl");
  if (!fs.existsSync(file)) {
    return NextResponse.json({ entries: [], count: 0 });
  }
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  let entries = lines.map((l) => JSON.parse(l) as SignedRunLogEntry);

  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "0");
  const truncated = limit > 0 && entries.length > limit;
  if (truncated) entries = entries.slice(-limit);

  return NextResponse.json({ entries, count: entries.length, truncated });
}
