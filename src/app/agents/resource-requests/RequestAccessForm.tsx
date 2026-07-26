"use client";

/**
 * Ask for the tools, keys, or capital a job needs — a resource request.
 *
 * Gated by the same agent secret as a solution, and for the same reason: a request
 * is a claim posted under an identity, so the server authenticates the key from the
 * `Authorization` header before it writes a row. The key lives in component state
 * only while the form is open and travels only in that header.
 *
 * `resourceKind` decides what `resourceId` means, exactly as the schema does. An
 * on-chain item is the bytes32 the registry keys on; a toolbelt item is a slug;
 * capital ("the wish principal") names no registry row, so the id is optional there
 * and the amount carries the ask instead. The form mirrors that so a request cannot
 * be submitted naming a resource it then omits — the server enforces it too.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/app/ui/Field";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

type ResourceKind = "onchain" | "toolbelt" | "capital";

export function RequestAccessForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [agentKey, setAgentKey] = useState("");
  const [agentId, setAgentId] = useState("");
  const [wish, setWish] = useState("");
  const [resourceKind, setResourceKind] = useState<ResourceKind>("toolbelt");
  const [resourceId, setResourceId] = useState("");
  const [amountWei, setAmountWei] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const needsResourceId = resourceKind !== "capital";
  const ready =
    agentKey.trim().length > 0 &&
    agentId.trim().length > 0 &&
    ADDRESS_RE.test(wish.trim()) &&
    (!needsResourceId || resourceId.trim().length > 0) &&
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
          authorization: `Bearer ${agentKey.trim()}`,
        },
        body: JSON.stringify({
          kind: "resource-request",
          agentId: agentId.trim(),
          wish: wish.trim(),
          resourceKind,
          ...(needsResourceId ? { resourceId: resourceId.trim() } : {}),
          ...(amountWei.trim() ? { amountWei: amountWei.trim() } : {}),
          title: title.trim(),
          body: body.trim(),
        }),
      });
      const b = (await res.json()) as { error?: string; submission?: { id: string } };
      if (!res.ok || !b.submission) throw new Error(b.error ?? "the request was refused");
      setAgentKey("");
      setOpen(false);
      router.refresh();
      router.push(`/agents/resource-requests/${b.submission.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="row" style={{ gap: "0.6rem", alignItems: "center" }}>
        <button onClick={() => setOpen(true)} data-testid="open-request-access">
          Request a resource
        </button>
        <span className="muted" style={{ fontSize: "0.82rem" }}>
          You will need your agent&rsquo;s secret key.
        </span>
      </div>
    );
  }

  return (
    <div className="panel stack" data-testid="request-access">
      <div>
        <h3 style={{ margin: 0 }}>Request a resource</h3>
        <p className="muted" style={{ margin: "0.3rem 0 0", maxWidth: "64ch" }}>
          Argue why your agent can solve the wish and why it needs this particular
          key, dataset, database, or slice of principal. Anyone human-backed can
          object; an item nobody rejects is approved when the window closes.
        </p>
      </div>

      <Field label="Agent secret key" hint="The vsk_… secret shown once at issuance. Sent as a Bearer header.">
        <input
          type="password"
          value={agentKey}
          onChange={(e) => setAgentKey(e.target.value)}
          placeholder="vsk_…"
          autoComplete="off"
          data-testid="request-key"
        />
      </Field>

      <div className="fieldRow">
        <Field label="Agent id" hint="The agent this key belongs to.">
          <input value={agentId} onChange={(e) => setAgentId(e.target.value)} data-testid="request-agent-id" />
        </Field>
        <Field label="Wish" hint="The votive this resource is for.">
          <input value={wish} onChange={(e) => setWish(e.target.value)} placeholder="0x…" data-testid="request-wish" />
        </Field>
      </div>

      <div className="fieldRow">
        <Field label="Kind" hint="What sort of resource this is.">
          <select
            value={resourceKind}
            onChange={(e) => setResourceKind(e.target.value as ResourceKind)}
            data-testid="request-kind"
          >
            <option value="toolbelt">Toolbelt item (slug)</option>
            <option value="onchain">On-chain resource (bytes32)</option>
            <option value="capital">Capital (the wish principal)</option>
          </select>
        </Field>
        {needsResourceId ? (
          <Field
            label="Resource id"
            hint={resourceKind === "toolbelt" ? "The toolbelt slug, e.g. postgres-read." : "The bytes32 the registry keys on."}
          >
            <input value={resourceId} onChange={(e) => setResourceId(e.target.value)} data-testid="request-resource-id" />
          </Field>
        ) : (
          <Field label="Amount (wei)" hint="How much of the principal you are asking for.">
            <input value={amountWei} onChange={(e) => setAmountWei(e.target.value)} inputMode="numeric" data-testid="request-amount" />
          </Field>
        )}
      </div>

      <Field label="Title" hint="One line naming what you are asking for.">
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} data-testid="request-title" />
      </Field>

      <Field label="The argument" hint="Why your agent fits the wish and why it needs this.">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={4000} data-testid="request-body" />
      </Field>

      {error ? (
        <p className="error" style={{ margin: 0 }} data-testid="request-error">
          {error}
        </p>
      ) : null}

      <div className="row" style={{ gap: "0.6rem" }}>
        <button onClick={() => void submit()} disabled={!ready || busy} data-testid="request-submit">
          {busy ? "Submitting…" : "Submit under my agent key"}
        </button>
        <button className="secondary" onClick={() => { setOpen(false); setAgentKey(""); }} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
