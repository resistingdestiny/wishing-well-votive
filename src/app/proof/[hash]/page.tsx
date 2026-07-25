import Link from "next/link";
import { readSignedRunLog } from "@/lib/runlog";
import { findAttestation, explorerTxUrl } from "@/lib/attestation";
import { ProofCard } from "@/app/ProofCard";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";
import { AttestationStats } from "@/app/verify/AttestationStats";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Attestation proof · Votive",
  description: "Zero-trust proof of a signed capability check, verified in your browser.",
};

export default async function Proof({ params }: { params: { hash: string } }) {
  const hash = params.hash;
  const valid = /^0x[0-9a-fA-F]{64}$/.test(hash);
  const entries = readSignedRunLog();
  const signed = valid
    ? entries.find((e) => e.hash.toLowerCase() === hash.toLowerCase())
    : undefined;
  const att = signed ? await findAttestation(signed) : null;

  return (
    <main>
      <SectionNav section="research" />
      <PageHead
        title="Attestation proof"
        description="One signed run-log entry with its on-chain attestation: the evidence behind a sweep or fulfilment."
      />

      {entries.length > 0 ? <AttestationStats entries={entries} /> : null}

      {!valid ? (
        <div className="panel emptyState">
          <h3>Not a 32-byte hash</h3>
          <p className="muted" style={{ margin: 0 }}>
            A proof permalink looks like <span className="mono">/proof/0x…64 hex chars</span>.
          </p>
          <Link href="/verify" className="pill pillPrimary">
            Paste a hash or an entry to verify
          </Link>
        </div>
      ) : !signed ? (
        <div className="panel emptyState">
          <h3>No entry with that hash</h3>
          <p className="muted" style={{ margin: 0, wordBreak: "break-all" }}>
            Nothing in the signed run log matches <span className="mono">{hash}</span>.
          </p>
          <Link href="/verify" className="pill pillPrimary">
            Verify a different one
          </Link>
        </div>
      ) : (
        <ProofCard
          entry={signed}
          attestation={att ? { ...att, explorerUrl: explorerTxUrl(att.txHash) } : null}
        />
      )}

      <div className="row" style={{ marginTop: "1.5rem" }}>
        <Link href="/verify" className="pill">
          Verify another
        </Link>
        <Link href="/bench" className="pill">
          Votive Bench
        </Link>
        <Link href="/board" className="pill">
          The board
        </Link>
      </div>
    </main>
  );
}
