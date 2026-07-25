import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { prisma } from "@/lib/db";
import { isAllowedPushEndpoint } from "@/lib/pushEndpoint";
import { enforceRateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "push-subscribe", 20, 60_000);
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as {
    subscriber?: string;
    subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  };
  const sub = body.subscription;
  if (!body.subscriber || !isAddress(body.subscriber)) {
    return NextResponse.json({ error: "valid subscriber required" }, { status: 400 });
  }
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return NextResponse.json({ error: "invalid subscription" }, { status: 400 });
  }

  if (!isAllowedPushEndpoint(sub.endpoint)) {
    return NextResponse.json({ error: "unrecognised push endpoint" }, { status: 400 });
  }
  await prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: {
      subscriber: body.subscriber.toLowerCase(),
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
    },
    update: { subscriber: body.subscriber.toLowerCase(), p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { endpoint } = (await req.json().catch(() => ({}))) as { endpoint?: string };
  if (!endpoint) return NextResponse.json({ error: "endpoint required" }, { status: 400 });
  await prisma.pushSubscription.delete({ where: { endpoint } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
