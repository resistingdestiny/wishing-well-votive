import Link from "next/link";
import { agentDataDir } from "@/lib/ingest";
import { readSignedRunLog } from "@/lib/runlog";
import { CapabilityStore } from "@/core/sweep/capabilityStore";
import { buildCorpus } from "@/core/bench/corpus";
import { formatUsd } from "@/core/models/pricing";
import { RunLogVerifier } from "@/app/RunLogVerifier";
import { shortHash } from "@/lib/format";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Votive Bench: a signature-provable record of the AI frontier",
  description:
    "The signed, hash-chained, capital-weighted record of what AI models can and can't do: the wishes people funded, as an open dataset. Every row is independently verifiable and provably not fabricated after the fact.",
};

export default async function Bench() {
  const entries = readSignedRunLog();
  const corpus = buildCorpus(entries, { store: new CapabilityStore(agentDataDir()) });
  const t = corpus.totals;

  return (
    <main>
      <SectionNav section="research" />
      <PageHead
        title="Votive Bench"
        description="The signed, hash-chained corpus of every capability check Votive has ever run. Download it, or verify its integrity in your browser."
      />

      <div className="grid cols-3">
        <div className="panel stat">
          <div className="value" data-count={t.capabilities}>{t.capabilities}</div>
          <div className="label">capabilities</div>
        </div>
        <div className="panel stat">
          <div className="value">
            <span data-count={t.checks}>{t.checks}</span>
            <span className="muted" style={{ fontSize: "0.9rem" }}>
              {" "}
              ({t.fails} failed)
            </span>
          </div>
          <div className="label">signed checks</div>
        </div>
        <div className="panel stat">
          <div className="value" data-count={t.models}>{t.models}</div>
          <div className="label">
            models · {t.providers} provider{t.providers === 1 ? "" : "s"}
          </div>
        </div>
        <div className="panel stat">
          <div className="value">{formatUsd(t.costUsd)}</div>
          <div className="label">compute spent</div>
        </div>
      </div>

      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Content address <span className="mono">{shortHash(corpus.corpusHash)}</span> · version{" "}
        <span className="mono">{corpus.version}</span> · licensed {corpus.license}
        {t.firstTs ? (
          <>
            {" "}
            · window {t.firstTs.slice(0, 10)} → {t.lastTs?.slice(0, 10)}
          </>
        ) : null}
      </p>

      <h2>Verify it yourself</h2>
      <RunLogVerifier />

      <h2>Download</h2>
      <div className="panel" style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap" }}>
        <a className="pill" href="/api/bench/corpus?format=jsonl&download=1" data-testid="download-jsonl">
          ↓ corpus.jsonl
        </a>
        <a className="pill" href="/api/bench/corpus?format=csv&download=1">
          ↓ corpus.csv
        </a>
        <a className="pill" href="/api/bench/corpus?format=datasheet&download=1">
          ↓ datasheet.md
        </a>
        <a className="pill" href="/api/bench/corpus">
          corpus.json (metadata)
        </a>
      </div>
      <p className="muted" style={{ fontSize: "0.8rem" }}>
        CSV is columnar. Use <span className="mono">pandas.read_csv(&quot;corpus.csv&quot;).to_parquet(&quot;corpus.parquet&quot;)</span> for Parquet.
      </p>

      <h2>How to verify a row</h2>
      <ol className="muted" style={{ lineHeight: 1.7 }}>
        <li>
          Recompute <span className="mono">keccak256</span> of the canonical entry. It must
          equal the row&rsquo;s <span className="mono">hash</span>.
        </li>
        <li>
          <span className="mono">ecrecover(hash, signature)</span> must equal{" "}
          <span className="mono">signer</span> (the oracle).
        </li>
        <li>
          Find the on-chain <span className="mono">attestCapability</span> event whose evidence
          hash equals the row&rsquo;s <span className="mono">hash</span>. The timestamp is
          anchored, not asserted.
        </li>
      </ol>
      <p className="muted">
        <Link href="/verify">Verify any hash or entry now →</Link>
      </p>

      <h2>Per-capability datasets</h2>
      {corpus.capabilities.length === 0 ? (
        <p className="muted">No checks recorded yet.</p>
      ) : (
        <div className="panel tableWrap">
          <table>
            <thead>
              <tr>
                <th>Capability</th>
                <th>Checks</th>
                <th>Content address</th>
                <th>Dataset</th>
              </tr>
            </thead>
            <tbody>
              {corpus.capabilities.map((c) => (
                <tr key={c.capabilityId}>
                  <td>{c.summary ?? <span className="mono">{c.capabilityId.slice(0, 18)}…</span>}</td>
                  <td>{c.checks}</td>
                  <td className="mono muted" style={{ fontSize: "0.78rem" }}>
                    {shortHash(c.contentHash)}
                  </td>
                  <td>
                    <a href={`/api/bench/${c.capabilityId}?download=1`}>↓ json</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted" style={{ marginTop: "1.5rem" }}>
        ← Back to the <Link href="/board">capability board</Link>.
      </p>
    </main>
  );
}
