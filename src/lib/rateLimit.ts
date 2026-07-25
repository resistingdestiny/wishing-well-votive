interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();
let lastSweep = 0;

export function clientIp(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return "unknown";
}

export interface RateResult {
  ok: boolean;
  retryAfter: number;
}

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateResult {

  if (now - lastSweep > 60_000) {
    for (const [k, w] of buckets) if (w.resetAt <= now) buckets.delete(k);
    lastSweep = now;
  }
  const w = buckets.get(key);
  if (!w || w.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  if (w.count >= limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
  }
  w.count += 1;
  return { ok: true, retryAfter: 0 };
}

export function enforceRateLimit(
  req: Request,
  route: string,
  limit: number,
  windowMs: number,
): Response | null {

  if (process.env.WELL_RATELIMIT_DISABLED === "1") return null;
  const res = rateLimit(`${route}:${clientIp(req.headers)}`, limit, windowMs);
  if (res.ok) return null;
  return new Response(
    JSON.stringify({ error: "rate limit exceeded — slow down", retryAfter: res.retryAfter }),
    { status: 429, headers: { "content-type": "application/json", "retry-after": String(res.retryAfter) } },
  );
}
