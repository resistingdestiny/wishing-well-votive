"use client";

import { useEffect, useState } from "react";
import {
  verifyChain,
  type SignedRunLogEntry,
  type ChainVerification,
} from "@/core/runlog/verify";
import { shortHash } from "@/lib/format";

const EXPECTED_SIGNER = (process.env.NEXT_PUBLIC_WELL_ORACLE_SIGNER ?? "").toLowerCase();

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "done"; v: ChainVerification; count: number; truncated: boolean };

export function RunLogVerifier() {
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/runlog", { cache: "no-store" });
        if (!res.ok) throw new Error(`runlog ${res.status}`);
        const data = (await res.json()) as {
          entries: SignedRunLogEntry[];
          count: number;
          truncated?: boolean;
        };
        const v = await verifyChain(data.entries, EXPECTED_SIGNER || undefined);
        if (live) setState({ phase: "done", v, count: data.count, truncated: !!data.truncated });
      } catch (e) {
        if (live) setState({ phase: "error", message: (e as Error).message });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (state.phase === "loading") {
    return (
      <div className="panel" data-testid="runlog-verifier">
        <span className="muted">Verifying the run log in your browser…</span>
        <div style={{ display: "grid", gap: "0.45rem", marginTop: "0.8rem" }} aria-hidden="true">
          <div className="skeleton" style={{ width: "56%" }} />
          <div className="skeleton" style={{ width: "38%" }} />
        </div>
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="panel" data-testid="runlog-verifier">
        <span className="muted">Verifier unavailable: {state.message}</span>
      </div>
    );
  }

  const { v, count } = state;
  const signer = v.signers[0];

  const fullyVerified = v.ok && v.oracleBound && (state.truncated || v.startsAtGenesis);
  const reason = !v.ok
    ? v.brokenAt !== undefined
      ? `chain broken at #${v.brokenAt}`
      : "inconsistent"
    : !v.oracleBound
      ? EXPECTED_SIGNER
        ? "not signed by the oracle"
        : "oracle not configured, cannot bind"
      : !state.truncated && !v.startsAtGenesis
        ? "history truncated (missing genesis)"
        : "";

  return (
    <div className="panel" data-testid="runlog-verifier">
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
        <span className={`badge ${fullyVerified ? "pass" : "fail"}`} data-testid="verifier-verdict">
          {fullyVerified ? "✓ verified" : `✗ ${reason || "unverified"}`}
        </span>
        <strong>
          {v.sigOk}/{v.total} signatures valid
        </strong>
        <span className="muted">·</span>
        <span>
          {v.chainIntact ? (
            <>hash chain intact{v.linksChecked > 0 ? ` (${v.linksChecked} links)` : ""}</>
          ) : (
            <span style={{ color: "var(--bad)" }}>chain broken at #{v.brokenAt}</span>
          )}
        </span>
      </div>
      <div className="muted" style={{ fontSize: "0.8rem", marginTop: "0.4rem" }}>
        Recomputed in your browser: {v.hashOk}/{v.total} content hashes match,{" "}
        {v.signers.length === 1 ? (
          <>
            all signed by <span className="mono">{signer ? shortHash(signer) : "-"}</span>
            {v.oracleBound ? (
              <> ✓ the configured oracle</>
            ) : EXPECTED_SIGNER ? (
              <span style={{ color: "var(--bad)" }}> ✗ NOT the configured oracle</span>
            ) : (
              <span style={{ color: "var(--bad)" }}> · oracle unconfigured, identity unproven</span>
            )}
          </>
        ) : (
          <span style={{ color: "var(--bad)" }}>
            {v.signers.length} different signers (expected one)
          </span>
        )}
        {!state.truncated && !v.startsAtGenesis ? (
          <span style={{ color: "var(--bad)" }}> · ⚠ missing genesis (history may be truncated)</span>
        ) : v.chainFromSeq !== undefined ? (
          <> · chained from #{v.chainFromSeq}</>
        ) : null}
        {state.truncated ? <> · last {count} entries</> : null}
        {" · "}
        <a href="/verify">verify a single attestation →</a>
      </div>
    </div>
  );
}
