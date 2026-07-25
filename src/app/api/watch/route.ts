import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const ADDR = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;

function normAddr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const a = v.toLowerCase();
  return ADDR.test(a) ? a : undefined;
}

function normTarget(kind: string, v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.toLowerCase();
  if (kind === "cell") return ADDR.test(t) ? t : undefined;
  if (kind === "capability") return BYTES32.test(t) ? t : undefined;
  return undefined;
}

export async function GET(req: Request) {
  const subscriber = normAddr(new URL(req.url).searchParams.get("subscriber"));
  if (!subscriber) {
    return NextResponse.json({ error: "valid subscriber address required" }, { status: 400 });
  }
  try {
    const watches = await prisma.watch.findMany({ where: { subscriber } });
    return NextResponse.json({ watches });
  } catch (e) {
    console.error("watch GET:", (e as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    subscriber?: unknown;
    kind?: unknown;
    target?: unknown;
    watching?: unknown;
  };
  const subscriber = normAddr(body.subscriber);
  const kind = body.kind === "cell" || body.kind === "capability" ? body.kind : undefined;
  const target = kind ? normTarget(kind, body.target) : undefined;
  if (!subscriber || !kind || !target) {
    return NextResponse.json(
      { error: "subscriber (address), kind (cell|capability), target (address|bytes32) required" },
      { status: 400 },
    );
  }
  try {
    if (body.watching === false) {
      await prisma.watch.deleteMany({ where: { subscriber, kind, target } });
      return NextResponse.json({ ok: true, watching: false });
    }
    await prisma.watch.upsert({
      where: { subscriber_kind_target: { subscriber, kind, target } },
      update: {},
      create: { subscriber, kind, target },
    });
    return NextResponse.json({ ok: true, watching: true });
  } catch (e) {
    console.error("watch POST:", (e as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
