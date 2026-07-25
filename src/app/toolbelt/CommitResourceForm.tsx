"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/app/ui/Field";

const KINDS = [
  { value: "tool", label: "Tool" },
  { value: "mcp", label: "MCP server" },
  { value: "data", label: "Data source" },
  { value: "credential", label: "Scoped credential (vault reference)" },
] as const;

export function CommitResourceForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string>("tool");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState("");
  const [payout, setPayout] = useState("");
  const [ref, setRef] = useState("");
  const [allowedTools, setAllowedTools] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/resources/propose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          name,
          description,
          provider,
          payout: payout || undefined,
          ref: ref || undefined,
          allowedTools:
            allowedTools.trim() === ""
              ? undefined
              : allowedTools.split(",").map((t) => t.trim()).filter(Boolean),
        }),
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
      <div className="panel stack" data-testid="commit-done">
        <p className="success" style={{ margin: 0 }}>
          Proposed, <strong>pending curator review</strong>. It grants nothing and
          powers no agent until approved; your card shows in the pending group below.
        </p>
        <div className="row">
          <button
            className="secondary"
            onClick={() => {
              setDone(false);
              setOpen(false);
              setName("");
              setDescription("");
              setRef("");
              setAllowedTools("");
            }}
          >
            Commit another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel" data-testid="commit-resource">
      <button
        onClick={() => setOpen(!open)}
        data-testid="commit-resource-toggle"
        style={{ marginBottom: open ? "0.6rem" : 0 }}
      >
        {open ? "▾" : "▸"} Commit a resource
      </button>
      {open ? (
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>
            Share a tool, MCP server, data source or scoped credential with every
            wish&rsquo;s agent, and you&rsquo;re credited as its provider. A curator
            reviews every proposal before anything can draw on it.
            <strong> Never paste a secret</strong>: credentials are vault
            references only. To commit capital, deposit into the resource pool
            (on-chain) instead.
          </p>
          <div className="fieldRow">
            <Field label="Kind">
              <select value={kind} onChange={(e) => setKind(e.target.value)} data-testid="commit-kind">
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Arweave pinning endpoint"
                data-testid="commit-name"
              />
            </Field>
          </div>
          <Field label="Description (optional)">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What it does, and what an agent may use it for."
              data-testid="commit-description"
            />
          </Field>
          <div className="fieldRow">
            <Field label="Your name / handle" hint="Shown as the provider on the card.">
              <input
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                placeholder="you"
                data-testid="commit-provider"
              />
            </Field>
            <Field
              label="Payout address (optional)"
              hint="Earns on-chain revenue attribution when that ships."
            >
              <input
                value={payout}
                onChange={(e) => setPayout(e.target.value)}
                placeholder="0x…"
                className="mono"
                data-testid="commit-payout"
              />
            </Field>
          </div>
          {kind === "credential" || kind === "mcp" ? (
            <Field
              label="Vault reference (optional)"
              hint="A reference to the secret in your vault, never the secret itself."
            >
              <input
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="vault://…"
                className="mono"
                data-testid="commit-ref"
              />
            </Field>
          ) : null}
          {kind === "tool" || kind === "mcp" ? (
            <Field label="Allowed tools (optional, comma-separated)">
              <input
                value={allowedTools}
                onChange={(e) => setAllowedTools(e.target.value)}
                placeholder="e.g. search, fetch, pin"
                data-testid="commit-tools"
              />
            </Field>
          ) : null}
          {error ? <p className="error" style={{ margin: 0 }} data-testid="commit-error">{error}</p> : null}
          <div className="row">
            <button
              onClick={submit}
              disabled={busy || name.trim().length < 3 || provider.trim() === ""}
              data-testid="commit-submit"
            >
              {busy ? "Submitting…" : "Submit for review"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
