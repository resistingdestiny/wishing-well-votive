import { NextResponse } from "next/server";
import { agentDataDir } from "@/lib/ingest";
import { readSignedRunLog } from "@/lib/runlog";
import { CapabilityStore } from "@/core/sweep/capabilityStore";
import {
  buildCorpus,
  corpusRows,
  rowsToJsonl,
  rowsToCsv,
  datasheet,
} from "@/core/bench/corpus";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "json";
  const download = url.searchParams.get("download") === "1";
  const entries = readSignedRunLog();
  const store = new CapabilityStore(agentDataDir());

  const attach = (filename: string, type: string, body: string) =>
    new NextResponse(body, {
      headers: {
        "content-type": type,
        ...(download ? { "content-disposition": `attachment; filename="${filename}"` } : {}),
      },
    });

  if (format === "jsonl") {
    const summaries = new Map(
      buildCorpus(entries, { store }).capabilities.map((c) => [c.capabilityId, c.summary ?? ""]),
    );
    return attach("corpus.jsonl", "application/x-ndjson; charset=utf-8", rowsToJsonl(corpusRows(entries, { summaries })));
  }
  if (format === "csv") {
    const summaries = new Map(
      buildCorpus(entries, { store }).capabilities.map((c) => [c.capabilityId, c.summary ?? ""]),
    );
    return attach("corpus.csv", "text/csv; charset=utf-8", rowsToCsv(corpusRows(entries, { summaries })));
  }
  if (format === "datasheet") {
    return attach("datasheet.md", "text/markdown; charset=utf-8", datasheet(buildCorpus(entries, { store })));
  }
  return NextResponse.json(buildCorpus(entries, { store }));
}
