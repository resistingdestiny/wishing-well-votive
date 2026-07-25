"use client";

import { useEffect, useState } from "react";
import { verifyEntry, entryHash, type SignedRunLogEntry } from "@/core/runlog/verify";
import { recoverMessageAddress } from "viem";
import { shortHash } from "@/lib/format";

const EXPECTED_SIGNER = (process.env.NEXT_PUBLIC_WELL_ORACLE_SIGNER ?? "").toLowerCase();

export interface AttestationRef {
  txHash: string;
  blockNumber: string;
  kind: "capability" | "condition";
  onchainPass: boolean;
  explorerUrl: string;
}

interface Checks {
  hashOk: boolean;
  sigOk: boolean;
  recovered?: string;
}

export function ProofCard({
  entry,
  attestation,
}: {
  entry: SignedRunLogEntry;
  attestation: AttestationRef | null;
}) {
  const [checks, setChecks] = useState<Checks | null>(null);

  useEffect(() => {
    (async () => {
      const hashOk = entryHash(entry.entry) === entry.hash;
      const sigOk = await verifyEntry(entry);
      let recovered: string | undefined;
      try {
        recovered = await recoverMessageAddress({
          message: { raw: entry.hash },
          signature: entry.signature,
        });
      } catch {

      }
      setChecks({ hashOk, sigOk, recovered });
    })();
  }, [entry]);

  const signerMatch = !!EXPECTED_SIGNER && entry.signer.toLowerCase() === EXPECTED_SIGNER;
  const allOk = checks?.hashOk && checks?.sigOk && signerMatch;

  return (
    <div className="panel" data-testid="proof-card">
      <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
        <span
          className={`badge ${checks ? (allOk ? "pass" : "fail") : ""}`}
          data-testid="proof-verdict"
        >
          {checks ? (allOk ? "✓ verified" : "✗ failed") : "verifying…"}
        </span>
        <span className="mono muted">{shortHash(entry.hash)}</span>
      </div>

      <ul style={{ marginTop: "0.8rem", lineHeight: 1.8, listStyle: "none", padding: 0 }}>
        <li>
          {checks?.hashOk ? "✓" : "✗"} keccak256 of the canonical entry equals the stated hash
        </li>
        <li>
          {checks?.sigOk ? "✓" : "✗"} signature recovers to{" "}
          <span className="mono">{checks?.recovered ? shortHash(checks.recovered) : "-"}</span>
          {signerMatch ? (
            <> ✓ the configured oracle</>
          ) : EXPECTED_SIGNER ? (
            <span style={{ color: "var(--bad)" }}> ✗ NOT the configured oracle</span>
          ) : (
            <span style={{ color: "var(--bad)" }}> · oracle unconfigured, identity unproven</span>
          )}
        </li>
        <li>
          {attestation ? (
            <>
              ✓ committed on chain:{" "}
              <a href={attestation.explorerUrl} target="_blank" rel="noreferrer">
                {attestation.kind} attestation tx {shortHash(attestation.txHash)}
              </a>{" "}
              (block {attestation.blockNumber}, recorded{" "}
              {attestation.onchainPass ? "pass" : "fail"})
            </>
          ) : (
            <span className="muted">
              ○ on-chain attestation not located (best-effort lookup; the two checks above
              stand on their own)
            </span>
          )}
        </li>
      </ul>

      <div className="muted" style={{ fontSize: "0.78rem", marginTop: "0.4rem" }}>
        {entry.entry.kind} · model <span className="mono">{entry.entry.model}</span> · seq{" "}
        {entry.entry.seq} · {entry.entry.ts.replace("T", " ").slice(0, 19)}
      </div>
    </div>
  );
}
