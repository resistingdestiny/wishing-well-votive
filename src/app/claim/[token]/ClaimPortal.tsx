"use client";

import { useState } from "react";
import Link from "next/link";

export interface Invitation {
  token: string;
  cell: string;
  wishNumber: number;
  fullName: string;
  relationship: string;
  assetSymbol: string;
  assetIsNative: boolean;
  sliceNativeLabel: string;
  sliceUsdLabel: string;
  claimDeadline: string;
  alreadyClaimed: boolean;
}

type Rail = "bank" | "wallet";
type Phase = "form" | "processing" | "done" | "guardian" | "error";

interface ClaimResult {
  matched: boolean;
  needsGuardian?: boolean;
  txRef?: string;
  payoutRef?: string;
  usdcOutLabel?: string;
  payoutRail?: string;
}

export default function ClaimPortal({ invitation }: { invitation: Invitation }) {
  const [phase, setPhase] = useState<Phase>("form");
  const [fullName, setFullName] = useState(invitation.fullName);
  const [dob, setDob] = useState("");
  const [subject, setSubject] = useState("");
  const [rail, setRail] = useState<Rail>("bank");
  const [walletAddr, setWalletAddr] = useState("");
  const [holderName, setHolderName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [country, setCountry] = useState("GB");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ClaimResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [guardianToken, setGuardianToken] = useState("");

  async function submit(guardianOverride = false) {
    setError(null);
    setBusy(true);
    if (!guardianOverride) setPhase("processing");
    try {
      const payout =
        rail === "wallet"
          ? { rail: "wallet", walletAddr }
          : { rail: "bank", bank: { holderName: holderName || fullName, accountNumber, country } };
      const res = await fetch("/api/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(guardianOverride ? { "x-curator-token": guardianToken } : {}),
        },
        body: JSON.stringify({
          action: guardianOverride ? "guardian-approve" : "claim",
          token: invitation.token,
          claimant: { fullName, dateOfBirth: dob },
          subject: subject || fullName,
          payout,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? "claim failed");
        setPhase(guardianOverride ? "guardian" : "error");
        return;
      }
      if (data.needsGuardian) {
        setResult(data);
        setPhase("guardian");
        return;
      }
      setResult(data);
      setPhase("done");
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    } finally {
      setBusy(false);
    }
  }

  if (invitation.alreadyClaimed) {
    return (
      <div className="panel stack" data-testid="claim-already">
        <span className="badge fulfilled">Claimed</span>
        <p className="lede">This share has already been claimed.</p>
        <Link href={`/wish/${invitation.cell}`} className="pill pillPrimary">
          View the wish
        </Link>
      </div>
    );
  }

  if (phase === "done" && result) {
    return (
      <div className="panel stack hoverable animFadeUp" data-testid="claim-done">
        <div className="row" style={{ alignItems: "center", gap: "0.9rem" }}>
          <div className="orb orb-granted doneOrb" aria-hidden="true" />
          <span className="badge fulfilled">Claim recorded</span>
        </div>
        <h2>Your share is on its way, {fullName.split(" ")[0]}.</h2>
        {result.payoutRail === "bank" ? (
          <p className="lede">
            {result.usdcOutLabel} is being wired to your bank account. You proved who you are and chose a bank
            payout: no wallet, no crypto{invitation.assetIsNative ? "; your ETH share was converted to USDC first" : ""}.
          </p>
        ) : (
          <p className="lede">{invitation.sliceNativeLabel} was sent to your wallet.</p>
        )}
        <div className="feeNote">
          On-chain claim: <span className="mono">{result.txRef}</span>
          {result.payoutRef && (
            <>
              <br />
              Payout ref: <span className="mono">{result.payoutRef}</span>
            </>
          )}
        </div>
        <Link href={`/wish/${invitation.cell}`} className="pill pillPrimary">
          View the wish
        </Link>
      </div>
    );
  }

  if (phase === "guardian") {
    return (
      <div className="panel stack animFadeUp" data-testid="claim-guardian">
        <span className="badge amended">Guardian review</span>
        <p className="lede">
          {result?.needsGuardian
            ? "Your details are close but not an exact match to what the wisher signed. A guardian must review before your share is released."
            : error}
        </p>
        <details>
          <summary>Guardian: review &amp; approve this claim</summary>
          <div className="stack" style={{ marginTop: "0.75rem" }}>
            <p className="faint">
              A guardian who has verified this person out of band can approve the claim (skips the automated match;
              KYC still applied). Requires the guardian authorisation token.
            </p>
            <label>
              Guardian token
              <input
                type="password"
                value={guardianToken}
                onChange={(e) => setGuardianToken(e.target.value)}
                data-testid="claim-guardian-token"
              />
            </label>
            {error && <p className="error">{error}</p>}
            <button onClick={() => submit(true)} disabled={busy || !guardianToken} data-testid="claim-guardian-approve">
              {busy ? "Approving…" : "Approve claim"}
            </button>
          </div>
        </details>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="panel stack">
        <div>
          <span className="badge claimable">Claimable</span>
          <h2>
            Claim your share of wish #{String(invitation.wishNumber).padStart(4, "0")}
          </h2>
          <p className="lede">
            You were named as <strong>{invitation.relationship}</strong>. Your share is{" "}
            <strong>{invitation.sliceNativeLabel}</strong> (≈ {invitation.sliceUsdLabel}). Confirm who you are to
            claim it. No wallet needed.
          </p>
        </div>

        <div className="stack">
          <h3>1 · Confirm your identity (KYC)</h3>
          <label>
            Full name
            <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} data-testid="claim-name" />
          </label>
          <label>
            Date of birth
            <input type="text" value={dob} onChange={(e) => setDob(e.target.value)} placeholder="YYYY-MM-DD" data-testid="claim-dob" />
          </label>
          <label>
            Your email
            <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="you@example.com" data-testid="claim-subject" />
          </label>
        </div>

        <div className="stack">
          <h3>2 · Where should the money go?</h3>
          <div className="row" role="tablist">
            <button className={rail === "bank" ? "" : "secondary"} onClick={() => setRail("bank")} data-testid="claim-rail-bank">
              My bank account
            </button>
            <button className={rail === "wallet" ? "" : "secondary"} onClick={() => setRail("wallet")} data-testid="claim-rail-wallet">
              A crypto wallet
            </button>
          </div>
          {rail === "bank" ? (
            <div className="stack">
              <label>
                Account holder
                <input type="text" value={holderName} onChange={(e) => setHolderName(e.target.value)} placeholder={fullName} data-testid="claim-holder" />
              </label>
              <label>
                Account number / IBAN
                <input type="text" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} data-testid="claim-account" />
              </label>
              <label>
                Country
                <input type="text" value={country} onChange={(e) => setCountry(e.target.value)} data-testid="claim-country" />
              </label>
              {invitation.assetIsNative && (
                <p className="faint">This is an ETH wish, so your share is converted to USDC before the bank wire.</p>
              )}
            </div>
          ) : (
            <label>
              Wallet address
              <input type="text" value={walletAddr} onChange={(e) => setWalletAddr(e.target.value)} placeholder="0x…" data-testid="claim-wallet" />
            </label>
          )}
        </div>

        {error && <p className="error" data-testid="claim-error">{error}</p>}
        <button onClick={() => submit(false)} disabled={busy} data-testid="claim-submit">
          {busy ? "Verifying…" : "Claim my share"}
        </button>
        <p className="faint">
          Blocked jurisdictions + sanctions are screened here. Your personal details are never written on chain.
          Only the hash the wisher signed is.
        </p>
      </div>
    </div>
  );
}
