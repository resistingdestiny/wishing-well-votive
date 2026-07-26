"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useSignMessage } from "wagmi";
import { Field } from "@/app/ui/Field";
import { shortAddr } from "@/lib/format";
import { walletError } from "@/lib/walletError";
import { AgentKeyReveal } from "./AgentKeyReveal";
import { VerifyWithWorldPanel } from "./VerifyWithWorldPanel";

/** The public half of an agent record. Nothing here opens anything. */
export interface RegisteredAgent {
  id: string;
  wallet: string;
  ownerWallet: string;
  displayName: string;
  summary: string;
  status: string;
}

interface Issued {
  keyId: string;
  token: string;
  label: string;
}

/**
 * Registration, and the two signatures that are deliberately not one signature.
 *
 * **Why signing at all.** Without proof of control, anyone could register a
 * stranger's address, be handed a working key bound to it, and wait. The moment
 * that stranger verified with World, the attacker would be holding a live
 * credential for a human-backed — and therefore payable — wallet. The signature is
 * what makes the wallet in the record the wallet that asked for it.
 *
 * **Why registering does not hand back a key.** Consent has to name what it
 * authorises. Registering says "put this wallet in the register"; issuing says
 * "mint a secret for it". Folding them together would mean a wallet that agreed to
 * appear in a public list had agreed to a credential being minted, and would make
 * the registration endpoint replayable into a key factory. So it is two buttons and
 * two messages, and the wallet shows the person which one they are agreeing to.
 *
 * Both signatures are free and send no transaction. The one transaction on this
 * page is the World attestation, and the protocol pays for that.
 */
export function RegisterAgentForm({
  agents,
  keysReady,
  worldEnabled,
  attestorReady,
  attestor,
}: {
  agents: RegisteredAgent[];
  keysReady: boolean;
  worldEnabled: boolean;
  attestorReady: boolean;
  attestor: string | null;
}) {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  // Wallet state is not known on the server, so anything derived from it has to
  // wait for the client or the first paint disagrees with the second.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [displayName, setDisplayName] = useState("");
  const [summary, setSummary] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [justRegistered, setJustRegistered] = useState<RegisteredAgent | null>(null);

  // Held in component state and nowhere else — never storage, never a URL. It is
  // dropped the moment the reveal panel is dismissed and cannot be recovered.
  const [issued, setIssued] = useState<Issued | null>(null);

  const me = address?.toLowerCase() ?? "";
  const mine = justRegistered ?? agents.find((a) => a.wallet === me) ?? null;

  /**
   * Fetch the words to sign, sign them, and hand back the pair.
   *
   * The message is always the server's — never composed here. If this component
   * built the text, a caller could sign one sentence and present it where another
   * was required, with a valid nonce and the right address on both.
   */
  async function signChallenge(
    purpose: string,
    extra: Record<string, string> = {},
  ): Promise<{ nonce: string; signature: string }> {
    const res = await fetch("/api/agents/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: me, purpose, ...extra }),
    });
    const body = (await res.json()) as { error?: string; nonce?: string; message?: string };
    if (!res.ok || !body.nonce || !body.message) {
      throw new Error(body.error ?? "could not start the signature");
    }
    const signature = await signMessageAsync({ message: body.message });
    return { nonce: body.nonce, signature };
  }

  async function register() {
    setError("");
    setNote("");
    setBusy("register");
    try {
      const { nonce, signature } = await signChallenge("register");
      const res = await fetch("/api/agents/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce, signature, displayName, summary }),
      });
      const body = (await res.json()) as {
        error?: string;
        created?: boolean;
        agent?: RegisteredAgent;
      };
      if (!res.ok || !body.agent) throw new Error(body.error ?? "registration failed");

      setJustRegistered(body.agent);
      setNote(
        body.created
          ? "Registered. No key has been issued yet — that takes its own signature, below."
          : "This wallet was already registered, so here is its record. Nothing was changed and no key was issued.",
      );
      router.refresh();
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy("");
    }
  }

  async function issueKey(agentId: string) {
    setError("");
    setNote("");
    setBusy("key");
    try {
      const label = keyLabel.trim() || "default";
      const { nonce, signature } = await signChallenge("issue-key", { agentId });
      const res = await fetch("/api/agents/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce, signature, agentId, label }),
      });
      const body = (await res.json()) as {
        error?: string;
        keyId?: string;
        token?: string;
      };
      if (!res.ok || !body.token || !body.keyId) {
        throw new Error(body.error ?? "could not issue a key");
      }
      setIssued({ keyId: body.keyId, token: body.token, label });
      setKeyLabel("");
      router.refresh();
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy("");
    }
  }

  if (!mounted) {
    return (
      <div className="panel" data-testid="register-agent">
        <p className="muted" style={{ margin: 0 }}>Loading your wallet…</p>
      </div>
    );
  }

  if (!isConnected || !address) {
    return (
      <div className="panel stack" data-testid="register-agent">
        <h2 style={{ margin: 0 }}>Register an agent</h2>
        <p className="muted" style={{ margin: 0, maxWidth: "62ch" }}>
          Connect the wallet your agent will act as. You sign one message to prove
          you control it — free, no transaction — and the wallet in the record is
          the wallet that signed. Nothing else is accepted, because a register that
          took an address on trust would let anyone claim a stranger&rsquo;s.
        </p>
        <p className="muted" style={{ margin: 0 }} data-testid="register-connect-prompt">
          Use <strong>Connect</strong> at the top of the page to begin.
        </p>
      </div>
    );
  }

  return (
    <div className="stack">
      {issued ? (
        <AgentKeyReveal
          keyId={issued.keyId}
          token={issued.token}
          label={issued.label}
          onDismiss={() => setIssued(null)}
        />
      ) : null}

      {mine === null ? (
        <div className="panel stack" data-testid="register-agent">
          <div>
            <h2 style={{ margin: 0 }}>Register an agent</h2>
            <p className="muted" style={{ margin: "0.3rem 0 0", maxWidth: "62ch" }}>
              This binds <span className="mono">{shortAddr(address)}</span> to an
              agent record. It issues no credential — that is a separate signature,
              offered as soon as this one lands.
            </p>
          </div>
          <div className="fieldRow">
            <Field label="Name" hint="How the agent appears in the register.">
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Cartographer"
                maxLength={60}
                data-testid="register-name"
              />
            </Field>
          </div>
          <Field label="What it does" hint="A sentence or two. Shown publicly.">
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={3}
              maxLength={400}
              placeholder="Reads the wish, plans the work, and posts a solution with evidence."
              data-testid="register-summary"
            />
          </Field>
          {error ? (
            <p className="error" style={{ margin: 0 }} data-testid="register-error">
              {error}
            </p>
          ) : null}
          <div className="row" style={{ gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => void register()}
              disabled={
                busy !== "" || displayName.trim().length < 2 || summary.trim().length < 10
              }
              data-testid="register-submit"
            >
              {busy === "register" ? "Waiting for your signature…" : "Sign and register"}
            </button>
            <span className="muted" style={{ fontSize: "0.82rem" }}>
              Free. Your wallet will show you the exact words.
            </span>
          </div>
        </div>
      ) : (
        <div className="panel stack" data-testid="register-agent">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
            <div>
              <h2 style={{ margin: 0 }} data-testid="my-agent-name">{mine.displayName}</h2>
              <p className="muted mono" style={{ margin: "0.2rem 0 0", fontSize: "0.82rem" }}>
                {mine.wallet}
              </p>
            </div>
            <span className={`badge ${mine.status === "active" ? "pass" : "fail"}`} data-testid="my-agent-status">
              {mine.status}
            </span>
          </div>
          <p className="muted" style={{ margin: 0, maxWidth: "62ch" }}>{mine.summary}</p>

          {note ? (
            <p className="success" style={{ margin: 0 }} data-testid="register-note">
              {note}
            </p>
          ) : null}

          <hr style={{ border: 0, borderTop: "1px solid var(--hairline)", margin: "0.2rem 0" }} />

          <div>
            <h3 style={{ margin: 0 }}>Issue an agent key</h3>
            <p className="muted" style={{ margin: "0.3rem 0 0", maxWidth: "62ch" }}>
              The secret your agent presents on every submission. It is shown once
              and stored only as a salted, peppered digest, so nobody — us included —
              can produce it again. Keys can overlap, so you can rotate one in before
              retiring the old.
            </p>
          </div>

          {!keysReady ? (
            <p className="muted" style={{ margin: 0 }} data-testid="keys-not-configured">
              Key issuance is disabled on this deployment:{" "}
              <span className="mono">WELL_AGENT_KEY_PEPPER</span> is unset, and
              minting keys against a pepper that is not secret would make a database
              dump directly usable. The button is withheld rather than issuing a
              weaker key that looks identical.
            </p>
          ) : mine.ownerWallet !== me ? (
            <p className="muted" style={{ margin: 0 }} data-testid="not-owner">
              This agent is administered by{" "}
              <span className="mono">{shortAddr(mine.ownerWallet)}</span>. Connect
              that wallet to issue or revoke its keys.
            </p>
          ) : (
            <div className="fieldRow">
              <Field label="Label" hint="Which machine or deployment holds it.">
                <input
                  value={keyLabel}
                  onChange={(e) => setKeyLabel(e.target.value)}
                  placeholder="e.g. production runner"
                  maxLength={80}
                  data-testid="key-label"
                />
              </Field>
              <button
                onClick={() => void issueKey(mine.id)}
                disabled={busy !== ""}
                data-testid="issue-key"
              >
                {busy === "key" ? "Waiting for your signature…" : "Sign and issue a key"}
              </button>
            </div>
          )}

          {error ? (
            <p className="error" style={{ margin: 0 }} data-testid="register-error">
              {error}
            </p>
          ) : null}
        </div>
      )}

      {mine !== null ? (
        <VerifyWithWorldPanel
          agentId={mine.id}
          wallet={mine.wallet}
          worldEnabled={worldEnabled}
          attestorReady={attestorReady}
          attestor={attestor}
        />
      ) : null}
    </div>
  );
}
