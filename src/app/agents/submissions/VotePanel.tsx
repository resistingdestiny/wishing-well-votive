"use client";

/**
 * Cast a vote — approve, or object with a reason.
 *
 * A vote is a human's wallet signature, never an agent key: the panel signs a
 * `vote` challenge the server minted, and the server resolves the human behind the
 * signer on chain and weights the vote by their standing. So this component holds
 * no secret and needs none — a connected, human-backed wallet is the whole of what
 * it takes to be heard.
 *
 * **An objection must say why.** The reject button is disabled until a reason is
 * written, mirroring the server's own rule: an objection nobody has to justify is
 * one nobody can answer. Approval needs no words.
 *
 * The panel only appears while the window accepts votes; once it has closed the
 * page shows the result instead, so there is no button here that would fail.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { Field } from "@/app/ui/Field";
import { walletError } from "@/lib/walletError";
import { acceptsVotes } from "@/core/submissions/status";
import type { PublicSubmission } from "@/core/submissions/view";
import { useSignChallenge } from "./useSignChallenge";

export function VotePanel({ submission }: { submission: PublicSubmission }) {
  const router = useRouter();
  const { isConnected } = useAccount();
  const signChallenge = useSignChallenge();

  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  if (!acceptsVotes(submission.status)) return null;

  async function vote(choice: "approve" | "reject") {
    setError("");
    setNote("");
    setBusy(choice);
    try {
      const { nonce, signature } = await signChallenge("vote", { subject: submission.id });
      const res = await fetch(`/api/submissions/${submission.id}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nonce,
          signature,
          choice,
          ...(choice === "reject" ? { reason: reason.trim() } : {}),
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "the vote was not recorded");
      setNote(choice === "approve" ? "Your approval is recorded." : "Your objection is recorded.");
      setReason("");
      router.refresh();
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="panel stack" data-testid="vote-panel">
      <div>
        <h3 style={{ margin: 0 }}>Have your say</h3>
        <p className="muted" style={{ margin: "0.3rem 0 0", maxWidth: "62ch" }}>
          Voting is a free signature from a human-backed wallet — no transaction, no
          agent key. Your weight is your standing at the block you sign, read on
          chain and recorded beside your vote. One verified human, one vote.
        </p>
      </div>

      {!isConnected ? (
        <p className="muted" style={{ margin: 0 }} data-testid="vote-connect-prompt">
          Connect a human-backed wallet to vote. Use <strong>Connect</strong> at the
          top of the page.
        </p>
      ) : (
        <>
          <Field
            label="Reason"
            hint="Required to object; an objection nobody has to justify is one nobody can answer."
          >
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="What is wrong with this claim?"
              data-testid="vote-reason"
            />
          </Field>

          {error ? (
            <p className="error" style={{ margin: 0 }} data-testid="vote-error">
              {error}
            </p>
          ) : null}
          {note ? (
            <p className="success" style={{ margin: 0 }} data-testid="vote-note">
              {note}
            </p>
          ) : null}

          <div className="row" style={{ gap: "0.6rem", flexWrap: "wrap" }}>
            <button
              onClick={() => void vote("approve")}
              disabled={busy !== ""}
              data-testid="vote-approve"
            >
              {busy === "approve" ? "Waiting for your signature…" : "Approve"}
            </button>
            <button
              className="secondary"
              onClick={() => void vote("reject")}
              disabled={busy !== "" || reason.trim().length < 4}
              data-testid="vote-reject"
            >
              {busy === "reject" ? "Waiting for your signature…" : "Object"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
