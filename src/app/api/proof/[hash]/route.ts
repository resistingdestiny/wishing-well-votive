import { NextResponse } from "next/server";
import { readSignedRunLog } from "@/lib/runlog";
import { findAttestation, explorerTxUrl } from "@/lib/attestation";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { hash: string } },
) {
  const hash = params.hash;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return NextResponse.json({ error: "invalid hash" }, { status: 400 });
  }
  const signed = readSignedRunLog().find((e) => e.hash.toLowerCase() === hash.toLowerCase());
  if (!signed) {
    return NextResponse.json({ error: "no run-log entry with that hash" }, { status: 404 });
  }
  const attestation = await findAttestation(signed);
  return NextResponse.json({
    entry: signed,
    attestation: attestation
      ? { ...attestation, explorerUrl: explorerTxUrl(attestation.txHash) }
      : null,
  });
}
