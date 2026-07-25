import webpush from "web-push";
import { prisma } from "@/lib/db";
import { isAllowedPushEndpoint } from "@/lib/pushEndpoint";

let configured: boolean | null = null;

function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:admin@wishing-well.local";
  if (!pub || !priv) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export async function sendPushToSubscriber(
  subscriber: string,
  payload: PushPayload,
): Promise<number> {
  if (!ensureConfigured()) return 0;
  const subs = await prisma.pushSubscription
    .findMany({ where: { subscriber: subscriber.toLowerCase() } })
    .catch(() => []);
  let sent = 0;
  const body = JSON.stringify(payload);
  for (const s of subs) {

    if (!isAllowedPushEndpoint(s.endpoint)) {
      await prisma.pushSubscription.delete({ where: { endpoint: s.endpoint } }).catch(() => {});
      continue;
    }
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
      );
      sent += 1;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await prisma.pushSubscription.delete({ where: { endpoint: s.endpoint } }).catch(() => {});
      }
    }
  }
  return sent;
}
