"use client";

/**
 * Escalate a rejected submission to a conduct report against the human behind it.
 *
 * This is the heaviest thing a person can do on the platform — a report can bar a
 * human across every wallet they will ever hold — so the panel promises nothing it
 * cannot deliver. It signs a `report` challenge and posts it, but the server files
 * nothing unless the ledger itself says the signer is a reviewer; a wallet that is
 * not sees the same form and a 403 when it tries. The category names the wrong; the
 * *contract* owns the penalty, raising a too-low severity to its own floor, so the
 * copy here is careful to say "propose", not "set".
 *
 * It shows only for a rejected, unreported submission. Once a report is filed its
 * transaction hash appears in the on-chain record instead, and this disappears.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { Field } from "@/app/ui/Field";
import { walletError } from "@/lib/walletError";
import type { PublicSubmission } from "@/core/submissions/view";
import { useSignChallenge } from "./useSignChallenge";

// StandingLedger.Category — 0 (Unspecified) is not a reportable value, so it is
// omitted. Violence, Exploitation and WeaponsOrMassHarm carry a permanent bar the
// contract enforces regardless of the severity proposed; the labels say so.
const CATEGORIES: { value: number; label: string }[] = [
  { value: 5, label: "Fraud" },
  { value: 6, label: "Spam" },
  { value: 4, label: "Targeted harassment" },
  { value: 2, label: "Exploitation (permanent bar)" },
  { value: 1, label: "Violence against people (permanent bar)" },
  { value: 3, label: "Weapons or mass harm (permanent bar)" },
];

// StandingLedger.Severity — None (0) is not proposable; the contract floors a
// too-low grade to the category's own minimum anyway.
const SEVERITIES: { value: number; label: string }[] = [
  { value: 1, label: "Minor" },
  { value: 2, label: "Serious" },
  { value: 3, label: "Critical" },
];

export function ReportPanel({ submission }: { submission: PublicSubmission }) {
  const router = useRouter();
  const { isConnected } = useAccount();
  const signChallenge = useSignChallenge();

  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState(CATEGORIES[0].value);
  const [severity, setSeverity] = useState(SEVERITIES[0].value);
  const [reason, setReason] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (submission.status !== "rejected") return null;
  if (submission.reportTxHash) return null;

  const ready = reason.trim().length >= 10;

  async function file() {
    setError("");
    setBusy(true);
    try {
      const { nonce, signature } = await signChallenge("report", { subject: submission.id });
      const res = await fetch(`/api/submissions/${submission.id}/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce, signature, category, severity, reason: reason.trim() }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "the report was not filed");
      setReason("");
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack" data-testid="report-panel">
      <div>
        <h3 style={{ margin: 0 }}>Report the conduct</h3>
        <p className="muted" style={{ margin: "0.3rem 0 0", maxWidth: "64ch" }}>
          A rejection says this claim was wrong. A report says it was reportable — bad
          faith worth recording against the human behind the agent, on chain, across
          every wallet they hold. Only a reviewer registered on the StandingLedger can
          file one; you propose the category and a severity, and the contract raises a
          too-low grade to its own floor.
        </p>
      </div>

      {!open ? (
        <div>
          <button className="secondary" onClick={() => setOpen(true)} data-testid="report-open">
            File a conduct report
          </button>
        </div>
      ) : !isConnected ? (
        <p className="muted" style={{ margin: 0 }} data-testid="report-connect-prompt">
          Connect your reviewer wallet to file. Use <strong>Connect</strong> at the top
          of the page.
        </p>
      ) : (
        <>
          <div className="fieldRow">
            <Field label="Category" hint="What the conduct was. Some categories carry a permanent bar.">
              <select
                value={category}
                onChange={(e) => setCategory(Number(e.target.value))}
                data-testid="report-category"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Severity" hint="Your proposal; the contract floors it to the category minimum.">
              <select
                value={severity}
                onChange={(e) => setSeverity(Number(e.target.value))}
                data-testid="report-severity"
              >
                {SEVERITIES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="What happened" hint="The evidence, in full. It is hashed on chain and published beside the report.">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              maxLength={2000}
              placeholder="Why this rejected claim was bad faith, not merely mistaken."
              data-testid="report-reason"
            />
          </Field>

          {error ? (
            <p className="error" style={{ margin: 0 }} data-testid="report-error">
              {error}
            </p>
          ) : null}

          <div className="row" style={{ gap: "0.6rem" }}>
            <button onClick={() => void file()} disabled={!ready || busy} data-testid="report-submit">
              {busy ? "Filing on chain…" : "Sign and file the report"}
            </button>
            <button className="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
