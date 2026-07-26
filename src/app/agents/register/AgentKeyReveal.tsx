"use client";

import { useState } from "react";

/**
 * The one and only time the secret exists anywhere we control.
 *
 * The server stored `HMAC-SHA-256(pepper, salt ‖ secret)` and threw the secret
 * away. There is no query that returns it, no support path that recovers it, and
 * no second render of this panel. That is not a limitation to apologise for — it
 * is the property that makes a database dump useless — but it does mean the copy
 * on screen has to be unambiguous *while the token is visible*, not in a toast
 * afterwards.
 *
 * The token lives in a React state variable in this component's parent and
 * nowhere else. Deliberately absent, and each for a reason:
 *
 *   `localStorage` / `sessionStorage` — readable by any script that ever runs on
 *   this origin, and it outlives the moment the person needed it.
 *
 *   The URL — query strings end up in browser history, server access logs, and
 *   `Referer` headers sent to third parties.
 *
 *   An `<input value={token}>` — password managers and form-fill offer to save
 *   what looks like a credential in a field, and browsers cache field values
 *   across a back-navigation. A `<pre>` cannot be autofilled or restored.
 *
 * The clipboard is the one exposure that remains, and it is unavoidable: a 60
 * character secret has to reach a config file somehow, and retyping it is worse.
 * The panel says so rather than pretending copying is free.
 */
export function AgentKeyReveal({
  keyId,
  token,
  label,
  onDismiss,
}: {
  keyId: string;
  token: string;
  label: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState<"" | "key" | "curl">("");
  const [revoking, setRevoking] = useState(false);
  const [note, setNote] = useState("");

  // Read at render rather than baked in at build: this page is served from
  // 127.0.0.1 in development and from a real origin in production, and a curl
  // line that names the wrong host is a line that quietly does not work.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const curl = `curl -H "Authorization: Bearer ${token}" \\\n  ${origin}/api/agents/me`;

  async function copy(what: "key" | "curl", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 2500);
    } catch {
      // Clipboard access is refused in some contexts and over plain HTTP. Saying
      // so beats a button that looks like it worked.
      setNote("Your browser refused clipboard access — select the text and copy it by hand.");
    }
  }

  async function revokeNow() {
    setRevoking(true);
    setNote("");
    try {
      const res = await fetch("/api/agents/keys/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json()) as { error?: string; revoked?: boolean };
      if (!res.ok) throw new Error(body.error ?? "could not revoke that key");
      setNote(
        body.revoked
          ? "Revoked. That token will not authenticate again — issue a new one when you need it."
          : "Nothing live matched that token.",
      );
      onDismiss();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="panel stack" data-reveal data-testid="agent-key-reveal">
      <div>
        <h3 style={{ margin: 0 }}>Your agent key — shown once</h3>
        <p className="muted" style={{ margin: "0.3rem 0 0", maxWidth: "62ch" }}>
          Copy it now. We stored a salted, peppered digest of it and discarded the
          key itself, so <strong>this panel is the only place it will ever
          appear</strong>. Nobody here can look it up for you, including us. If you
          lose it, revoke it and issue another — that costs one signature and no
          money.
        </p>
      </div>

      <div className="codeCard">
        <button
          className="secondary copyBtn"
          onClick={() => void copy("key", token)}
          data-testid="agent-key-copy"
        >
          {copied === "key" ? "Copied" : "Copy key"}
        </button>
        <pre data-testid="agent-key-token">{token}</pre>
      </div>

      <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
        <span className="chip mono" data-testid="agent-key-id">
          key id {keyId}
        </span>
        <span className="chip">{label}</span>
      </div>

      <div>
        <p className="muted" style={{ margin: "0 0 0.4rem" }}>
          Send it as a bearer token. It goes in a header and nowhere else — never in
          a query string, which would put it in access logs and browser history.
        </p>
        <div className="codeCard">
          <button
            className="secondary copyBtn"
            onClick={() => void copy("curl", curl)}
            data-testid="agent-key-copy-curl"
          >
            {copied === "curl" ? "Copied" : "Copy curl"}
          </button>
          <pre>{curl}</pre>
        </div>
      </div>

      <p className="muted" style={{ margin: 0, fontSize: "0.82rem", maxWidth: "62ch" }}>
        Copying puts the key on your system clipboard, where other applications can
        read it. That is the one unavoidable exposure in handing you a secret
        through a browser; paste it straight into your secret store and clear the
        clipboard afterwards.
      </p>

      {note ? (
        <p className="muted" style={{ margin: 0 }} data-testid="agent-key-note">
          {note}
        </p>
      ) : null}

      <div className="row" style={{ gap: "0.6rem", flexWrap: "wrap" }}>
        <button onClick={onDismiss} data-testid="agent-key-stored">
          I&rsquo;ve stored it — hide the key
        </button>
        <button
          className="secondary"
          onClick={() => void revokeNow()}
          disabled={revoking}
          data-testid="agent-key-revoke"
        >
          {revoking ? "Revoking…" : "Revoke it instead"}
        </button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: "0.82rem", maxWidth: "62ch" }}>
        <strong>Revoke it instead</strong> uses the key to destroy itself, which
        needs no wallet — the same path to use from any machine if one ever leaks. A
        key can always revoke itself and can never mint a replacement, so whoever
        steals one can throw it away but can never lock you out of your own agent.
      </p>
    </div>
  );
}
