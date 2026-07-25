import Link from "next/link";
import { readSignedRunLog } from "@/lib/runlog";
import { shortHash } from "@/lib/format";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";
import { AttestationStats } from "./AttestationStats";
import { VerifyClient } from "./VerifyClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Verify an attestation · Votive",
  description:
    "Paste an evidence hash or a signed run-log entry. Your browser recomputes every keccak and recovers every signature. Nothing trusts the server.",
};

export default function Verify() {
  const entries = readSignedRunLog();
  const recent = entries.slice(-8).reverse();
  const example = entries.at(-1)?.hash ?? null;

  return (
    <main>
      <SectionNav section="research" />
      <PageHead
        title="Verify an attestation"
        description="Paste a hash or a full signed entry. Your browser recomputes the keccak and the signature, no trust required."
      />

      {entries.length > 0 ? <AttestationStats entries={entries} /> : null}

      <VerifyClient exampleHash={example} />

      {recent.length > 0 ? (
        <div className="panel tableWrap" style={{ marginTop: "1.5rem" }} data-testid="verify-recent">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Model</th>
                <th>Result</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((e) => (
                <tr key={e.hash}>
                  <td className="muted">{e.entry.ts.slice(0, 10)}</td>
                  <td>{e.entry.kind}</td>
                  <td className="mono">{e.entry.model}</td>
                  <td>
                    {e.entry.pass === undefined ? (
                      <span className="muted">-</span>
                    ) : (
                      <span className={`badge ${e.entry.pass ? "pass" : "fail"}`}>
                        {e.entry.pass ? "PASS" : "FAIL"}
                      </span>
                    )}
                  </td>
                  <td>
                    <Link className="mono" href={`/proof/${e.hash}`}>
                      {shortHash(e.hash)}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="muted" style={{ marginTop: "1.5rem" }}>
        Every row of the <Link href="/bench">Votive Bench</Link> carries its hash +
        signature, so you can verify any of them here.
      </p>
      <p className="muted">
        Curious who&rsquo;s behind the agents earning on the frontier? Every earning agent is
        backed by a unique verified human —{" "}
        <Link href="/agents/human-backed">the human-backing register</Link>.
      </p>
    </main>
  );
}
