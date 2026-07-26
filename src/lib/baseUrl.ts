/**
 * The URL this deployment answers on, as seen from outside it.
 *
 * Every skill we serve has to name the host an agent will fetch it from, and the
 * agent then has to POST back to that same host. A skill file with a literal
 * origin baked into the source is wrong on every deployment but the one it was
 * written for — localhost, a preview build, a tunnel, production — so the origin
 * is read from the request that asked for the file. That is the one source which
 * is correct by construction.
 *
 * `WELL_BASE_URL` overrides it, for the single case a request cannot answer for
 * itself: a proxy that rewrites `Host` to something the agent cannot reach back
 * on. It is read from the environment rather than guessed at, because guessing
 * would hand an agent a URL that resolves for us and 404s for them.
 *
 * `x-forwarded-*` is trusted here and that is a deliberate, bounded decision. The
 * only thing derived from it is a URL printed into documentation; nothing is
 * authenticated or authorised by it, so a spoofed header produces a skill file
 * with a wrong address in it, and not a security hole. Anything that *did* grant
 * access on the strength of a header would have to stop trusting these.
 */
import { headers } from "next/headers";

/** Strip a trailing slash so `${base}/skills` never doubles it. */
function tidy(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * The origin, from the incoming request.
 *
 * Falls back to the dev server's own address rather than to a placeholder: a
 * skill file is useless without a reachable host, and `http://example.com` in a
 * curl command is worse than a localhost URL that at least works for whoever is
 * running the thing locally.
 */
export function baseUrl(): string {
  const configured = process.env.WELL_BASE_URL;
  if (configured) return tidy(configured);

  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return "http://127.0.0.1:3100";

  // A forwarded proto is authoritative when present; otherwise infer from the
  // host, because a loopback address is never behind TLS and everything else on
  // the public internet now is.
  const proto =
    h.get("x-forwarded-proto")?.split(",")[0]?.trim() ??
    (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host) ? "http" : "https");

  return tidy(`${proto}://${host}`);
}
