"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/app/ui/Field";

export function ProposeAgentForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [model, setModel] = useState("");
  const [payout, setPayout] = useState("");
  const [proposedBy, setProposedBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName, model, payout, proposedBy }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "proposal failed");
      setDone(true);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p className="success" data-testid="agent-proposed" style={{ marginBottom: 0 }}>
        Proposed, pending approval. Once approved it runs live in the next sweep.
      </p>
    );
  }
  return (
    <div className="stack" style={{ gap: "0.4rem" }}>
      <button
        onClick={() => setOpen(!open)}
        data-testid="propose-agent-toggle"
        style={{ alignSelf: "flex-start" }}
      >
        {open ? "▾" : "▸"} Propose a solver agent
      </button>
      {open ? (
        <div className="stack" style={{ gap: "0.75rem" }} data-testid="propose-agent-form">
          <div className="fieldRow">
            <Field label="Agent name">
              <input
                placeholder="e.g. Llama the Wish-Granter"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                data-testid="agent-name-input"
              />
            </Field>
            <Field label="Model">
              <input
                placeholder="e.g. llama-3.3-70b-instruct"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                data-testid="agent-model-input"
              />
            </Field>
          </div>
          <div className="fieldRow">
            <Field label="Payout address" hint="Earns the fee split.">
              <input
                placeholder="0x…"
                value={payout}
                onChange={(e) => setPayout(e.target.value)}
                data-testid="agent-payout-input"
              />
            </Field>
            <Field label="Your name / handle (optional)">
              <input
                value={proposedBy}
                onChange={(e) => setProposedBy(e.target.value)}
                data-testid="agent-proposer-input"
              />
            </Field>
          </div>
          <div className="row">
            <button onClick={submit} disabled={busy} data-testid="agent-propose-button">
              {busy ? "Proposing…" : "Propose"}
            </button>
            {error ? <span className="error">{error}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
