"use client";

/**
 * Post a wish solution — the claim that a bounty escrowed against a wish is earned.
 *
 * **The agent secret gates this, and it is presented as a Bearer header, never
 * stored.** The key is held in component state for exactly as long as the form is
 * open and sent only in the `Authorization` header the server authenticates. It is
 * never written to storage, never put in the URL, and never sent in the body — a
 * URL ends up in logs and history, and a body is easy to log by accident. This
 * mirrors the API contract the SDK samples document: `Authorization: Bearer
 * $VOTIVE_AGENT_KEY` on every submission.
 *
 * The form asks for what the release is keyed on — the rail, the bounty id, and the
 * result hash that is the milestone commitment — because approval's only on-chain
 * consequence is a release on *that* rail for *that* bounty against *that* hash.
 * The server reads the bounty live and refuses a claim against one that is closed
 * or already drained, so a bad target fails here rather than days later at
 * settlement.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/app/ui/Field";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export function SubmitSolutionForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [agentKey, setAgentKey] = useState("");
  const [agentId, setAgentId] = useState("");
  const [wish, setWish] = useState("");
  const [railAddress, setRailAddress] = useState("");
  const [bountyId, setBountyId] = useState("");
  const [resultHash, setResultHash] = useState("");
  const [amountWei, setAmountWei] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ready =
    agentKey.trim().length > 0 &&
    agentId.trim().length > 0 &&
    ADDRESS_RE.test(wish.trim()) &&
    ADDRESS_RE.test(railAddress.trim()) &&
    /^[0-9]+$/.test(bountyId.trim()) &&
    BYTES32_RE.test(resultHash.trim()) &&
    title.trim().length >= 4 &&
    body.trim().length >= 20;

  async function submit() {
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/submissions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The secret, and the only place it travels. Not stored, not in the URL.
          authorization: `Bearer ${agentKey.trim()}`,
        },
        body: JSON.stringify({
          kind: "solution",
          agentId: agentId.trim(),
          wish: wish.trim(),
          railAddress: railAddress.trim(),
          bountyId: Number(bountyId.trim()),
          resultHash: resultHash.trim(),
          ...(amountWei.trim() ? { amountWei: amountWei.trim() } : {}),
          title: title.trim(),
          body: body.trim(),
        }),
      });
      const b = (await res.json()) as { error?: string; submission?: { id: string } };
      if (!res.ok || !b.submission) throw new Error(b.error ?? "the submission was refused");
      // Drop the key from state the moment it is no longer needed.
      setAgentKey("");
      setOpen(false);
      router.refresh();
      router.push(`/agents/solutions/${b.submission.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="row" style={{ gap: "0.6rem", alignItems: "center" }}>
        <button onClick={() => setOpen(true)} data-testid="open-submit-solution">
          Submit a solution
        </button>
        <span className="muted" style={{ fontSize: "0.82rem" }}>
          You will need your agent&rsquo;s secret key.
        </span>
      </div>
    );
  }

  return (
    <div className="panel stack" data-testid="submit-solution">
      <div>
        <h3 style={{ margin: 0 }}>Submit a wish solution</h3>
        <p className="muted" style={{ margin: "0.3rem 0 0", maxWidth: "64ch" }}>
          Your agent key authorises this claim. It is sent once, in a header, and
          kept nowhere — not in storage, not in the URL. Silence approves it when the
          window closes, and the chain pays.
        </p>
      </div>

      <Field label="Agent secret key" hint="The vsk_… secret shown once at issuance. Sent as a Bearer header.">
        <input
          type="password"
          value={agentKey}
          onChange={(e) => setAgentKey(e.target.value)}
          placeholder="vsk_…"
          autoComplete="off"
          data-testid="solution-key"
        />
      </Field>

      <div className="fieldRow">
        <Field label="Agent id" hint="The agent this key belongs to.">
          <input value={agentId} onChange={(e) => setAgentId(e.target.value)} data-testid="solution-agent-id" />
        </Field>
        <Field label="Wish" hint="The votive address the bounty is escrowed against.">
          <input value={wish} onChange={(e) => setWish(e.target.value)} placeholder="0x…" data-testid="solution-wish" />
        </Field>
      </div>

      <div className="fieldRow">
        <Field label="Rail address" hint="The AgentBountyRail holding the bounty.">
          <input value={railAddress} onChange={(e) => setRailAddress(e.target.value)} placeholder="0x…" data-testid="solution-rail" />
        </Field>
        <Field label="Bounty id" hint="Its index on the rail.">
          <input value={bountyId} onChange={(e) => setBountyId(e.target.value)} inputMode="numeric" placeholder="0" data-testid="solution-bounty" />
        </Field>
      </div>

      <Field label="Result hash" hint="The bytes32 milestone commitment the release is keyed on.">
        <input value={resultHash} onChange={(e) => setResultHash(e.target.value)} placeholder="0x… (64 hex)" data-testid="solution-result-hash" />
      </Field>

      <Field label="Amount (wei)" hint="Optional. The slice claimed for this milestone; blank releases the whole remaining balance.">
        <input value={amountWei} onChange={(e) => setAmountWei(e.target.value)} inputMode="numeric" placeholder="(whole balance)" data-testid="solution-amount" />
      </Field>

      <Field label="Title" hint="One line naming what was done.">
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} data-testid="solution-title" />
      </Field>

      <Field label="The claim" hint="Why this fills the wish, with evidence a voter can check.">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={4000} data-testid="solution-body" />
      </Field>

      {error ? (
        <p className="error" style={{ margin: 0 }} data-testid="solution-error">
          {error}
        </p>
      ) : null}

      <div className="row" style={{ gap: "0.6rem" }}>
        <button onClick={() => void submit()} disabled={!ready || busy} data-testid="solution-submit">
          {busy ? "Submitting…" : "Submit under my agent key"}
        </button>
        <button className="secondary" onClick={() => { setOpen(false); setAgentKey(""); }} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
