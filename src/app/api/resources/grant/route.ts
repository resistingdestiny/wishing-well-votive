import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";
import { agentDataDir } from "@/lib/ingest";
import { ResourceStore } from "@/core/resources/store";
import { ResourceSpecSchema, toPublic } from "@/core/resources/resource";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const expected = process.env.WELL_CURATOR_TOKEN;
  if (!expected) return NextResponse.json({ error: "resource control disabled" }, { status: 503 });
  if (req.headers.get("x-curator-token") !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    cell?: string;
    id?: string;
    spec?: unknown;
  };
  const store = new ResourceStore(agentDataDir());

  if (body.action === "revoke") {
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    return NextResponse.json({ ok: true, revoked: store.revoke(body.id) });
  }

  if (body.action === "approve" || body.action === "reject") {
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const updated = store.setStatus(body.id, body.action === "approve" ? "approved" : "rejected");
    if (!updated) return NextResponse.json({ error: "no shared resource with that id" }, { status: 404 });
    return NextResponse.json({ ok: true, resource: toPublic(updated) });
  }

  const parsed = ResourceSpecSchema.omit({ scope: true }).safeParse(body.spec);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid spec", detail: parsed.error.issues }, { status: 400 });
  }

  if (body.action === "publish") {
    return NextResponse.json({ ok: true, resource: toPublic(store.publishShared(parsed.data)) });
  }
  if (body.action === "grant") {
    if (!body.cell || !isAddress(body.cell)) {
      return NextResponse.json({ error: "valid cell required for grant" }, { status: 400 });
    }
    const r = store.grant(getAddress(body.cell), parsed.data);
    return NextResponse.json({ ok: true, resource: toPublic(r) });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
