import fs from "node:fs";
import path from "node:path";
import { prisma } from "./db";
import { generateNotifications } from "./notify";

interface SignedEntry {
  entry: {
    seq: number;
    ts: string;
    trigger: string;
    kind: string;
    capabilityId?: string;
    cell?: string;
    model: string;
    provider: string;
    pass?: boolean;
    score?: number;
    detail: unknown;
    inputTokens: number;
    outputTokens: number;
  };
  hash: string;
  signature: string;
  signer: string;
}

export async function ingestRunLog(
  dataDir: string,
): Promise<{ ingested: number; total: number; notified: number }> {
  const file = path.join(dataDir, "runlog.jsonl");
  if (!fs.existsSync(file)) return { ingested: 0, total: 0, notified: 0 };
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

  let ingested = 0;
  for (const line of lines) {
    const signed = JSON.parse(line) as SignedEntry;
    const e = signed.entry;
    await prisma.runEntry.upsert({
      where: { seq: e.seq },
      update: {},
      create: {
        seq: e.seq,
        ts: new Date(e.ts),
        trigger: e.trigger,
        kind: e.kind,
        capabilityId: e.capabilityId ?? null,
        cell: e.cell ?? null,
        model: e.model,
        provider: e.provider,
        pass: e.pass ?? null,
        score: e.score ?? null,
        detail: (e.detail ?? {}) as object,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        hash: signed.hash,
        signature: signed.signature,
        signer: signed.signer,
      },
    });
    ingested++;
  }

  const notified = await generateNotifications();
  return { ingested, total: lines.length, notified };
}

export function agentDataDir(): string {
  return process.env.WELL_DATA_DIR ?? path.resolve(process.cwd(), "..", "data");
}
