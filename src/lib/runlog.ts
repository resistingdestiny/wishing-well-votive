import fs from "node:fs";
import path from "node:path";
import { agentDataDir } from "@/lib/ingest";
import type { SignedRunLogEntry } from "@/core/runlog/verify";

export function readSignedRunLog(): SignedRunLogEntry[] {
  const file = path.join(agentDataDir(), "runlog.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SignedRunLogEntry);
}
