import Link from "next/link";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Embed the frontier · Votive",
  description:
    "Drop the live AI-frontier widget on your site, or read the open, CORS-enabled public API. Every figure is independently verifiable.",
};

const IFRAME_SNIPPET = `<iframe
  src="/embed/board"
  width="360" height="420"
  style="border:0;border-radius:12px"
  title="Votive · the AI frontier"
  loading="lazy"></iframe>`;

const FETCH_SNIPPET = `// CORS-enabled, cached ~60s. Every figure is verifiable at /bench.
const r = await fetch("https://YOUR-HOST/api/public/board");
const { totals, flips, backlog } = await r.json();`;

export default function Embed() {
  return (
    <main>
      <SectionNav section="research" />
      <PageHead
        title="Embed & API"
        description="Drop the live backlog into any page with one iframe, or read the same data as JSON from the public API."
      />

      <h2>The widget</h2>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) 380px", gap: "1.5rem", alignItems: "start" }}>
        <div className="panel">
          <p className="muted" style={{ marginTop: 0 }}>Paste this anywhere:</p>
          <pre className="tableWrap" style={{ overflowX: "auto", padding: "0.8rem" }}>
            <code className="mono">{IFRAME_SNIPPET}</code>
          </pre>
        </div>
        <div>
          <p className="muted" style={{ marginTop: 0 }}>Live preview:</p>
          <iframe
            src="/embed/board"
            width="360"
            height="420"
            style={{ border: 0, borderRadius: 12 }}
            title="Votive · the AI frontier"
            data-testid="embed-preview"
          />
        </div>
      </div>

      <h2>The public API</h2>
      <p>
        <span className="mono">GET /api/public/board</span>: CORS-open, edge-cached (~60s). A
        compact frontier summary: totals (incl. compute spent), what unlocked, and the
        demand-weighted backlog.
      </p>
      <div className="panel">
        <pre className="tableWrap" style={{ overflowX: "auto", padding: "0.8rem" }}>
          <code className="mono">{FETCH_SNIPPET}</code>
        </pre>
      </div>

      <p className="muted" style={{ marginTop: "1.5rem" }}>
        Every number resolves to a signed, on-chain-attested check. Audit them in the{" "}
        <Link href="/bench">Votive Bench</Link> or verify one at{" "}
        <Link href="/verify">/verify</Link>.
      </p>
    </main>
  );
}
