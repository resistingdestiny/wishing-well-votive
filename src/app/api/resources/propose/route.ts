import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";
import { agentDataDir } from "@/lib/ingest";
import { ResourceStore } from "@/core/resources/store";
import { ResourceKindSchema, toPublic } from "@/core/resources/resource";

export const dynamic = "force-dynamic";

const PUBLIC_KINDS = new Set(["tool", "mcp", "data", "credential"]);
const MAX_PENDING = 50;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    kind?: string;
    name?: string;
    description?: string;
    provider?: string;
    payout?: string;
    ref?: string;
    allowedTools?: unknown;
  };

  const kind = ResourceKindSchema.safeParse(body.kind);
  if (!kind.success || !PUBLIC_KINDS.has(kind.data)) {
    return NextResponse.json(
      { error: "kind must be tool, mcp, data or credential — to commit capital, deposit into the resource pool (on-chain)" },
      { status: 400 },
    );
  }
  const name = (body.name ?? "").trim();
  if (name.length < 3 || name.length > 80) {
    return NextResponse.json({ error: "name must be 3–80 chars" }, { status: 400 });
  }
  const provider = (body.provider ?? "").trim();
  if (provider.length < 1 || provider.length > 80) {
    return NextResponse.json({ error: "provider (your name / handle) required, ≤80 chars" }, { status: 400 });
  }
  if (body.payout !== undefined && body.payout !== "" && !isAddress(body.payout)) {
    return NextResponse.json({ error: "payout must be a valid 0x address (or omitted)" }, { status: 400 });
  }
  const description = (body.description ?? "").slice(0, 500);
  const ref = body.ref === undefined || body.ref === "" ? undefined : body.ref.slice(0, 200);
  const allowedTools = Array.isArray(body.allowedTools)
    ? (body.allowedTools as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 20).map((t) => t.slice(0, 60))
    : undefined;

  const store = new ResourceStore(agentDataDir());
  const pendingCount = store.shared().filter((r) => r.status === "pending").length;
  if (pendingCount >= MAX_PENDING) {
    return NextResponse.json(
      { error: "the review queue is full — try again after the curator catches up" },
      { status: 429 },
    );
  }

  const resource = store.propose({
    kind: kind.data,
    name,
    description,
    provider,
    payout: body.payout ? getAddress(body.payout) : undefined,
    ref,
    allowedTools,
    revoked: false,
  });
  return NextResponse.json({ ok: true, resource: toPublic(resource) });
}
