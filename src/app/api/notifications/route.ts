import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const ADDR = /^0x[0-9a-f]{40}$/;

function normAddr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const a = v.toLowerCase();
  return ADDR.test(a) ? a : undefined;
}

export async function GET(req: Request) {
  const subscriber = normAddr(new URL(req.url).searchParams.get("subscriber"));
  if (!subscriber) {
    return NextResponse.json({ error: "valid subscriber address required" }, { status: 400 });
  }
  try {
    const [notifications, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { subscriber },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.notification.count({ where: { subscriber, read: false } }),
    ]);
    return NextResponse.json({ notifications, unread });
  } catch (e) {
    console.error("notifications GET:", (e as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    subscriber?: unknown;
    id?: unknown;
    all?: unknown;
  };
  const subscriber = normAddr(body.subscriber);
  if (!subscriber) {
    return NextResponse.json({ error: "valid subscriber address required" }, { status: 400 });
  }
  const all = body.all === true;
  const id = typeof body.id === "string" && body.id.length > 0 ? body.id : undefined;
  if (!all && !id) {
    return NextResponse.json({ error: "id or all required" }, { status: 400 });
  }
  try {
    await prisma.notification.updateMany({
      where: { subscriber, read: false, ...(all ? {} : { id }) },
      data: { read: true },
    });
    const unread = await prisma.notification.count({ where: { subscriber, read: false } });
    return NextResponse.json({ ok: true, unread });
  } catch (e) {
    console.error("notifications POST:", (e as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
