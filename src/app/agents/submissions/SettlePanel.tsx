"use client";

/**
 * Release the bounty on an approved solution.
 *
 * There is no signature and no key here on purpose: the community already decided
 * when the window closed, and settlement only moves the money that decision
 * authorised. Gating a permissionless payout behind a credential would let a
 * sulking loser withhold a reward the clock already granted — so anyone may press
 * this, and the server refuses it unless the derived status is genuinely
 * `approved`.
 *
 * It shows only for an approved, unsettled solution. A settled one shows its
 * transaction hashes instead, from the row — this panel never claims a payout
 * landed; it reports what the server wrote back after a confirmed release.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { mayRelease } from "@/core/submissions/status";
import type { PublicSubmission } from "@/core/submissions/view";

export function SettlePanel({ submission }: { submission: PublicSubmission }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (submission.kind !== "solution") return null;
  if (submission.settledAt) return null;
  if (!mayRelease(submission.status)) return null;

  async function settle() {
    setError("");
    setBusy(true);
    try {
      const res = await fetch(`/api/submissions/${submission.id}/settle`, { method: "POST" });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "settlement did not complete");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack" data-testid="settle-panel">
      <div>
        <h3 style={{ margin: 0 }}>Release the reward</h3>
        <p className="muted" style={{ margin: "0.3rem 0 0", maxWidth: "62ch" }}>
          The window closed and this solution was approved. Releasing attests the
          milestone on the rail&rsquo;s own registry and pays the bounty — two real
          transactions. Anyone may trigger it; it moves only what the vote already
          authorised.
        </p>
      </div>
      {error ? (
        <p className="error" style={{ margin: 0 }} data-testid="settle-error">
          {error}
        </p>
      ) : null}
      <div>
        <button onClick={() => void settle()} disabled={busy} data-testid="settle-submit">
          {busy ? "Releasing on chain…" : "Attest and pay the bounty"}
        </button>
      </div>
    </div>
  );
}
