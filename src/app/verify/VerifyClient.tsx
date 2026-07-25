"use client";

import { useState } from "react";
import { ProofCard, type AttestationRef } from "@/app/ProofCard";
import type { SignedRunLogEntry } from "@/core/runlog/verify";

type Result = { entry: SignedRunLogEntry; attestation: AttestationRef | null };

export function VerifyClient({ exampleHash }: { exampleHash?: string | null }) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(value?: string) {
    setError(null);
    setResult(null);
    const s = (value ?? input).trim();
    if (!s) return;
    setBusy(true);
    try {
      if (/^0x[0-9a-fA-F]{64}$/.test(s)) {
        const res = await fetch(`/api/proof/${s}`, { cache: "no-store" });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `lookup failed (${res.status})`);
        }
        const data = (await res.json()) as Result;
        setResult(data);
      } else {
        const parsed = JSON.parse(s) as SignedRunLogEntry;
        if (!parsed?.entry || !parsed.hash || !parsed.signature || !parsed.signer) {
          throw new Error("not a signed run-log entry (need entry, hash, signature, signer)");
        }
        setResult({ entry: parsed, attestation: null });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="panel">
        <textarea
          data-testid="verify-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='0x… (evidence hash)  or  {"entry":{…},"hash":"0x…","signature":"0x…","signer":"0x…"}'
          rows={5}
          style={{ width: "100%", fontFamily: "var(--mono, monospace)", fontSize: "0.85rem" }}
        />
        <div style={{ marginTop: "0.6rem", display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
          <button className="pillPrimary" onClick={() => run()} disabled={busy} data-testid="verify-run">
            {busy ? "Verifying…" : "Verify"}
          </button>
          {exampleHash ? (
            <button
              className="secondary"
              data-testid="verify-example"
              disabled={busy}
              onClick={() => {
                setInput(exampleHash);
                run(exampleHash);
              }}
            >
              Try a real recent hash
            </button>
          ) : null}
          {error ? <span style={{ color: "var(--bad)" }}>{error}</span> : null}
        </div>
        {busy ? (
          <div style={{ display: "grid", gap: "0.45rem", marginTop: "0.8rem" }} aria-hidden="true">
            <div className="skeleton" style={{ width: "48%" }} />
            <div className="skeleton" style={{ width: "31%" }} />
          </div>
        ) : null}
      </div>

      {result ? (
        <div style={{ marginTop: "1rem" }}>
          <ProofCard entry={result.entry} attestation={result.attestation} />
        </div>
      ) : null}
    </>
  );
}
