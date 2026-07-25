"use client";

import { useState } from "react";
import Link from "next/link";
import { addMyCell } from "@/lib/myCells";

type Method = "bank" | "card" | "crypto";
type Phase = "compose" | "bank" | "card" | "processing" | "done" | "error";

interface StartBank {
  method: "bank";
  wallet: string;
  amountUsdc: string;
  amountLabel: string;
  account: { id: string; bankName: string; accountNumber: string; routingNumber: string; reference: string };
}
interface StartCard {
  method: "card";
  wallet: string;
  amountUsdc: string;
  amountLabel: string;
}

const GOOD_CARD = "4242424242424242";
const DECLINE_CARD = "4000000000000002";

export function FiatFundForm({
  prefillProse = "",
  showCryptoTab = true,
}: {
  prefillProse?: string;
  showCryptoTab?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("compose");
  const [method, setMethod] = useState<Method>("bank");
  const [email, setEmail] = useState("");
  const [prose, setProse] = useState(prefillProse);
  const [amountUsd, setAmountUsd] = useState("");
  const [card, setCard] = useState("");
  const [started, setStarted] = useState<StartBank | StartCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ cell: string; amountLabel: string; ownerWallet: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const methods: Method[] = showCryptoTab ? ["bank", "card", "crypto"] : ["bank", "card"];

  async function start() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/fund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start", email, prose, amountUsd, method }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? "could not start funding");
        return;
      }
      setStarted(data);
      setPhase(data.method === "bank" ? "bank" : "card");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function settle() {
    if (!started) return;
    setError(null);
    setBusy(true);
    setPhase("processing");
    try {
      const payload: Record<string, unknown> = {
        action: "settle",
        method: started.method,
        email,
        prose,
        amountUsd,
        wallet: started.wallet,
      };
      if (started.method === "bank") {
        payload.account = started.account;
      } else {
        payload.card = card;
      }
      const res = await fetch("/api/fund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.declined ? `Card declined: ${data.error}. Try the test card ${GOOD_CARD}.` : data.error ?? "settlement failed");
        setPhase(started.method === "bank" ? "bank" : "card");
        return;
      }
      setResult({ cell: data.cell, amountLabel: data.amountLabel, ownerWallet: data.ownerWallet });
      addMyCell({ cell: data.cell, label: prose.slice(0, 80), source: "fund" });
      setPhase("done");
    } catch (e) {
      setError((e as Error).message);
      setPhase(started.method === "bank" ? "bank" : "card");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setCopied(false);
    setPhase("compose");
    setStarted(null);
    setResult(null);
    setError(null);
  }

  if (phase === "done" && result) {
    return (
      <div className="panel stack hoverable animFadeUp" data-testid="fund-done">
        <div className="row" style={{ alignItems: "center", gap: "0.9rem" }}>
          <div className="orb orb-granted doneOrb" aria-hidden="true" />
          <span className="badge fulfilled">Funded</span>
        </div>
        <h2>Your wish is funded, no wallet required.</h2>
        <p className="lede">
          {result.amountLabel} landed as USDC in its own segregated cell. You paid with ordinary money; the
          platform held the wallet behind your email.
        </p>
        <div className="feeNote">
          Your account (embedded wallet): <span className="mono">{result.ownerWallet}</span>
          <br />
          It receives the funds when the wish is granted. You never signed a transaction.
        </div>
        <div className="feeNote">
          <strong>Save this link.</strong> With no wallet connected, this URL, plus this browser, is
          how you find your wish again.
          <br />
          <span className="mono" style={{ wordBreak: "break-all" }}>{`/wish/${result.cell}`}</span>
        </div>
        <div className="row">
          <Link href={`/wish/${result.cell}`} className="pill pillPrimary" data-testid="fund-view-wish">
            View your wish
          </Link>
          <button
            className="secondary"
            data-testid="fund-copy-link"
            onClick={() => {
              navigator.clipboard
                ?.writeText(`${window.location.origin}/wish/${result.cell}`)
                .then(() => setCopied(true))
                .catch(() => {});
            }}
          >
            {copied ? "Copied ✓" : "Copy link"}
          </button>
          <button className="secondary" onClick={reset} data-testid="fund-again">
            Fund another
          </button>
        </div>
        <p className="faint" style={{ margin: 0 }}>
          Also saved to this browser. See <Link href="/mine">Your wishes</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="panel stack">
      <div className="row" role="tablist" aria-label="Funding method">
        {methods.map((m) => (
          <button
            key={m}
            className={method === m ? "" : "secondary"}
            onClick={() => {
              setMethod(m);
              setPhase("compose");
              setStarted(null);
              setError(null);
            }}
            data-testid={`fund-method-${m}`}
          >
            {m === "bank" ? "Bank transfer" : m === "card" ? "Card" : "Crypto"}
          </button>
        ))}
      </div>

      {method === "crypto" ? (
        <div className="stack animFadeUp">
          <p className="lede">Already have a wallet and crypto? Fund directly in ETH or a stablecoin.</p>
          <Link href="/create" className="pill pillPrimary">
            Open the wallet-based create flow
          </Link>
        </div>
      ) : phase === "compose" ? (
        <div className="stack animFadeUp">
          <p className="lede">
            Fund a wish with ordinary money: {method === "bank" ? "a bank transfer" : "a card"}. It lands as
            USDC in its own cell; you never touch a wallet or a seed phrase.
          </p>
          <label>
            Your email
            <input
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              data-testid="fund-email"
            />
          </label>
          <label>
            Your wish
            <textarea
              value={prose}
              onChange={(e) => setProse(e.target.value)}
              rows={3}
              placeholder="Hold this until an AI can reliably do basic arithmetic, then return it."
              data-testid="fund-prose"
            />
          </label>
          <label>
            Amount (USD)
            <input
              type="number"
              value={amountUsd}
              onChange={(e) => setAmountUsd(e.target.value)}
              min="1"
              placeholder="6000"
              data-testid="fund-amount"
            />
          </label>
          {error && <p className="error" data-testid="fund-error">{error}</p>}
          <button onClick={start} disabled={busy} data-testid="fund-start">
            {busy ? "Setting up…" : method === "bank" ? "Get my transfer details" : "Continue to card"}
          </button>
        </div>
      ) : phase === "bank" && started?.method === "bank" ? (
        <div className="stack animFadeUp" data-testid="fund-bank-details">
          <p className="lede">
            Wire <strong>{started.amountLabel}</strong> to the account below. When we receive it, your wish is
            funded automatically. The crypto rail stays invisible.
          </p>
          <pre className="schema">
{`Bank        ${started.account.bankName}
Account no. ${started.account.accountNumber}
Routing     ${started.account.routingNumber}
Reference   ${started.account.reference}`}
          </pre>
          {error && <p className="error" data-testid="fund-error">{error}</p>}
          <button onClick={settle} disabled={busy} data-testid="fund-sent">
            {busy ? "Confirming…" : `I've sent the ${started.amountLabel} transfer`}
          </button>
          <p className="faint">Simulated bank rail (sandbox). No real money moves.</p>
        </div>
      ) : phase === "card" && started?.method === "card" ? (
        <div className="stack animFadeUp" data-testid="fund-card-details">
          <p className="lede">
            Pay <strong>{started.amountLabel}</strong> by card.
          </p>
          <label>
            Card number
            <input
              type="text"
              value={card}
              onChange={(e) => setCard(e.target.value)}
              placeholder={GOOD_CARD}
              data-testid="fund-card"
            />
          </label>
          {error && <p className="error" data-testid="fund-error">{error}</p>}
          <button onClick={settle} disabled={busy} data-testid="fund-pay">
            {busy ? "Charging…" : `Pay ${started.amountLabel}`}
          </button>
          <p className="faint">
            Simulated card rail (sandbox). Test card {GOOD_CARD} succeeds; {DECLINE_CARD} is declined.
            No real money moves.
          </p>
        </div>
      ) : (
        <p className="lede animFadeUp">Processing…</p>
      )}
    </div>
  );
}
