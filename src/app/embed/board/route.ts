import { readSignedRunLog } from "@/lib/runlog";
import { buildFrontierReport } from "@/core/frontier/report";

export const dynamic = "force-dynamic";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

export async function GET() {
  let r;
  try {
    r = buildFrontierReport(readSignedRunLog());
  } catch {
    r = null;
  }
  const cleared = r?.totals.cleared ?? 0;
  const backlog = r?.totals.backlog ?? 0;
  const median = r?.medianSweepsToUnlock ?? "—";
  const flips = (r?.flips ?? []).slice(0, 4);

  const flipsHtml =
    flips.length > 0
      ? flips
          .map(
            (f) =>
              `<li><b>${esc(f.model)}</b> unlocked ${esc(f.summary ?? f.capabilityId.slice(0, 12) + "…")}</li>`,
          )
          .join("")
      : "<li style='color:#6B7280'>Nothing has flipped fail→pass yet.</li>";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Votive — the AI frontier</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, sans-serif; background:#F6F7F9; color:#0F1115; padding:18px; }
  .h { font-size:12px; letter-spacing:2px; color:#6B7280; }
  .t { font-size:20px; font-weight:700; margin:2px 0 14px; }
  .row { display:flex; gap:14px; margin-bottom:14px; }
  .s { flex:1; background:#ffffff; border:1px solid #E5E7EB; border-radius:10px; padding:10px 12px; }
  .v { font-size:30px; font-weight:700; }
  .g { color:#2563EB; } .o { color:#6B7280; }
  .l { font-size:11px; color:#6B7280; }
  ul { margin:0; padding-left:18px; font-size:13px; line-height:1.6; }
  a { color:#2563EB; font-size:11px; text-decoration:none; }
  a:hover { text-decoration:underline; }
</style></head>
<body>
  <div class="h">VOTIVE</div>
  <div class="t">The AI frontier</div>
  <div class="row">
    <div class="s"><div class="v g">${cleared}</div><div class="l">unlocked</div></div>
    <div class="s"><div class="v o">${backlog}</div><div class="l">out of reach</div></div>
    <div class="s"><div class="v">${median}</div><div class="l">median sweeps</div></div>
  </div>
  <ul>${flipsHtml}</ul>
  <div style="margin-top:14px"><a href="/frontier" target="_blank" rel="noopener">Signed &amp; verifiable → votive /frontier</a></div>
</body></html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "frame-ancestors *",
      "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
