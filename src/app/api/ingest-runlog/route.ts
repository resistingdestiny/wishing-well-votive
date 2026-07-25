import { NextResponse } from "next/server";
import { ingestRunLog, agentDataDir } from "@/lib/ingest";

export async function POST() {
  try {
    const result = await ingestRunLog(agentDataDir());
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
