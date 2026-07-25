"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { Field } from "@/app/ui/Field";

interface BaseModel {
  id: string;
  displayName: string;
}
interface Tool {
  id: string;
  name: string;
}

export function BuildAgentForm({ baseModels, tools }: { baseModels: BaseModel[]; tools: Tool[] }) {
  const { address } = useAccount();
  const [name, setName] = useState("");
  const [baseModel, setBaseModel] = useState(baseModels[0]?.id ?? "");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [payout, setPayout] = useState("");
  const [proposedBy, setProposedBy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const effPayout = payout.trim() || address || "";

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/strategy-agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: name, baseModel, systemPrompt, resourceIds: selected, payout: effPayout, proposedBy }),
      });
      const j = (await res.json()) as { error?: string };
      setMsg(
        res.ok
          ? { ok: true, text: "Submitted, pending curator approval. Once approved it runs live in the next sweep." }
          : { ok: false, text: j.error ?? "submission failed" },
      );
      if (res.ok) setName("");
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack" data-testid="build-agent-form">
      <div>
        <h3 style={{ margin: 0 }}>Submit a strategy agent</h3>
        <p className="hint" style={{ marginTop: "0.3rem" }}>
          A base model, a strategy, and a payout address. A curator reviews every
          submission; approved agents run live in the next sweep.
        </p>
      </div>

      <div className="fieldRow">
        <Field label="Agent name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Step-by-step Solver" />
        </Field>
        <Field label="Base model">
          <select value={baseModel} onChange={(e) => setBaseModel(e.target.value)} data-testid="base-model">
            {baseModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field
        label="Strategy"
        hint="The system prompt applied on every capability check this agent attempts."
      >
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={5}
          placeholder="e.g. You are a meticulous solver. Reason step by step, double-check arithmetic, and answer with only the final result."
        />
      </Field>

      {tools.length > 0 ? (
        <div className="field">
          <span className="label">Tools from the shared toolbelt (optional)</span>
          <div className="row" style={{ gap: "0.5rem 1.1rem" }}>
            {tools.map((t) => (
              <label key={t.id} style={{ display: "flex", gap: "0.35rem", alignItems: "center", fontSize: "0.88rem" }}>
                <input
                  type="checkbox"
                  checked={selected.includes(t.id)}
                  onChange={(e) =>
                    setSelected((s) => (e.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))
                  }
                />
                {t.name}
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <div className="fieldRow">
        <Field
          label="Payout address"
          hint="Earns the fee split. Defaults to your connected wallet."
        >
          <input
            value={effPayout}
            onChange={(e) => setPayout(e.target.value)}
            placeholder="0x…"
            className="mono"
          />
        </Field>
        <Field label="Your name / handle (optional)">
          <input value={proposedBy} onChange={(e) => setProposedBy(e.target.value)} />
        </Field>
      </div>

      <div className="row" style={{ gap: "0.8rem" }}>
        <button
          className="pillPrimary"
          onClick={submit}
          disabled={busy || !name || !systemPrompt || !effPayout}
          data-testid="submit-agent"
        >
          {busy ? "Submitting…" : "Submit agent"}
        </button>
        {msg ? (
          <span style={{ color: msg.ok ? "var(--good)" : "var(--bad)", fontSize: "0.85rem" }}>
            {msg.text}
            {msg.ok ? (
              <>
                {" "}
                <a href="#roster">See it in the roster ↓</a> ·{" "}
                <a href="/board">watch the sweep on the board</a>
              </>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}
