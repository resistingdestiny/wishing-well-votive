"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  useReadContract,
  useWriteContract,
  useSignTypedData,
  useSwitchChain,
  usePublicClient,
} from "wagmi";
import { useRouter } from "next/navigation";
import { getAddress, isAddress, formatEther, parseEther, parseUnits, parseSignature } from "viem";
import { cellAbi, erc20Abi } from "@/lib/chain";
import { appChain } from "@/lib/wagmi";
import { shortAddr } from "@/lib/format";

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_ROOT = `0x${"0".repeat(64)}`;

interface SchemaData {
  kind: number;
  wisher: `0x${string}`;
  guardian: `0x${string}`;
  beneficiary: `0x${string}`;
  isSealed: boolean;
}

function eqAddr(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

export function OwnerActions({ address }: { address: `0x${string}` }) {
  const cell = address;
  const { address: connected, isConnected, chainId } = useAccount();
  const { connect, connectors } = useConnect();
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const client = usePublicClient();
  const router = useRouter();

  const stateRead = useReadContract({ address: cell, abi: cellAbi, functionName: "state" });
  const schemaRead = useReadContract({ address: cell, abi: cellAbi, functionName: "schema" });
  const timeoutsRead = useReadContract({ address: cell, abi: cellAbi, functionName: "timeouts" });
  const lastActivityRead = useReadContract({
    address: cell,
    abi: cellAbi,
    functionName: "lastWisherActivity",
  });
  const nonceRead = useReadContract({ address: cell, abi: cellAbi, functionName: "amendNonce" });
  const owedRead = useReadContract({
    address: cell,
    abi: cellAbi,
    functionName: "owed",
    args: connected ? [connected] : undefined,
    query: { enabled: !!connected },
  });

  const assetRead = useReadContract({ address: cell, abi: cellAbi, functionName: "asset" });
  const asset = assetRead.data as `0x${string}` | undefined;
  const isToken = !!asset && asset !== ZERO;
  const decimalsRead = useReadContract({
    address: asset,
    abi: erc20Abi,
    functionName: "decimals",
    query: { enabled: isToken },
  });
  const symbolRead = useReadContract({
    address: asset,
    abi: erc20Abi,
    functionName: "symbol",
    query: { enabled: isToken },
  });
  const tokenDecimals = Number(decimalsRead.data ?? 18);
  const tokenSymbol = (symbolRead.data as string | undefined) ?? "TOKEN";

  const distRootRead = useReadContract({
    address: cell,
    abi: cellAbi,
    functionName: "distributionRoot",
  });
  const distChalRead = useReadContract({
    address: cell,
    abi: cellAbi,
    functionName: "distributionChallengeDeadline",
  });
  const hasDistribution = !!distRootRead.data && distRootRead.data !== ZERO_ROOT;
  const [distLeaf, setDistLeaf] = useState<{
    index: number;
    account: `0x${string}`;
    weight: string;
    proof: `0x${string}`[];
  } | null>(null);
  useEffect(() => {
    if (!hasDistribution || !connected) {
      setDistLeaf(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/distribution/${cell}?account=${connected}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setDistLeaf(d && Array.isArray(d.proof) ? d : null);
      })
      .catch(() => {
        if (!cancelled) setDistLeaf(null);
      });
    return () => {
      cancelled = true;
    };
  }, [hasDistribution, connected, cell]);
  const claimedRead = useReadContract({
    address: cell,
    abi: cellAbi,
    functionName: "isClaimed",
    args: distLeaf ? [BigInt(distLeaf.index)] : undefined,
    query: { enabled: !!distLeaf },
  });

  const refetchAll = () => {
    void stateRead.refetch();
    void lastActivityRead.refetch();
    void nonceRead.refetch();
    void owedRead.refetch();
  };

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const [busy, setBusy] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string>("");
  const [actionError, setActionError] = useState<string>("");
  const [done, setDone] = useState<string>("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [redirectTo, setRedirectTo] = useState("");
  const [topUpAmount, setTopUpAmount] = useState("0.01");
  const [deadlineHrs, setDeadlineHrs] = useState("24");
  const [signed, setSigned] = useState<{
    payout: `0x${string}`;
    deadline: bigint;
    v: number;
    r: `0x${string}`;
    s: `0x${string}`;
    payload: string;

    nonce: bigint;
  } | null>(null);

  const state = stateRead.data === undefined ? -1 : Number(stateRead.data);
  const schema = schemaRead.data as SchemaData | undefined;
  const timeouts = timeoutsRead.data as readonly [bigint, bigint, bigint] | undefined;
  const lastActivity = lastActivityRead.data ? Number(lastActivityRead.data) : 0;
  const amendNonce = (nonceRead.data as bigint | undefined) ?? 0n;
  const owedAmount = (owedRead.data as bigint | undefined) ?? 0n;

  const amendAfter = timeouts ? Number(timeouts[0]) : 0;
  const escheatAfter = timeouts ? Number(timeouts[1]) : 0;

  const timingReady = timeouts !== undefined && lastActivityRead.data !== undefined;

  const CLOCK_BUFFER = 15;

  const validRedirect =
    isAddress(redirectTo) && !eqAddr(redirectTo, ZERO) && !eqAddr(redirectTo, cell);

  const isLive = state === 1 || state === 2;
  const isWisher = eqAddr(connected, schema?.wisher);
  const hasGuardian = !!schema && schema.guardian !== ZERO;
  const isGuardian = hasGuardian && eqAddr(connected, schema?.guardian);
  const guardianAmendAt = lastActivity + amendAfter;
  const escheatAt = lastActivity + escheatAfter;
  const guardianAmendReady = timingReady && now >= guardianAmendAt + CLOCK_BUFFER;
  const escheatReady = timingReady && state === 1 && now >= escheatAt + CLOCK_BUFFER;

  const amendLocked = schema?.kind === 2 && state === 2;

  const isSealed = !!schema?.isSealed;
  const wrongChain = isConnected && chainId !== undefined && chainId !== appChain.id;

  const signedVoid = signed !== null && signed.nonce !== amendNonce;

  const roleLabel = useMemo(() => {
    if (!isConnected) return "";
    if (isWisher) return "you are the depositor";
    if (isGuardian) return "you are the guardian";
    if (owedAmount > 0n) return "you are owed a fallback payout";
    return "you are viewing as an observer";
  }, [isConnected, isWisher, isGuardian, owedAmount]);

  async function doWrite(
    id: string,
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<boolean> {
    if (!client) return false;
    setActionError("");
    setDone("");
    setTxHash("");
    setBusy(id);
    setConfirm(null);
    try {
      const hash = await writeContractAsync({
        address: cell,
        abi: cellAbi,
        functionName: functionName as "ping",
        args: args as [],
      });
      setTxHash(hash);
      await client.waitForTransactionReceipt({ hash });
      setDone(id);
      refetchAll();

      router.refresh();
      return true;
    } catch (e) {
      setActionError((e as Error).message.split("\n")[0]);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function doTopUp() {
    if (!client) return;
    let value: bigint;
    try {
      value = parseEther(topUpAmount);
    } catch {
      setActionError("Enter a valid ETH amount.");
      return;
    }
    if (value <= 0n) {
      setActionError("Top-up must be greater than 0.");
      return;
    }
    setActionError("");
    setDone("");
    setTxHash("");
    setBusy("topup");
    try {
      const hash = await writeContractAsync({
        address: cell,
        abi: cellAbi,
        functionName: "topUp",
        value,
      });
      setTxHash(hash);
      await client.waitForTransactionReceipt({ hash });
      setDone("topup");
      refetchAll();
      router.refresh();
    } catch (e) {
      setActionError((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(null);
    }
  }

  async function doTopUpERC20() {
    if (!client || !asset) return;
    let amt: bigint;
    try {
      amt = parseUnits(topUpAmount, tokenDecimals);
    } catch {
      setActionError(`Enter a valid ${tokenSymbol} amount.`);
      return;
    }
    if (amt <= 0n) {
      setActionError("Top-up must be greater than 0.");
      return;
    }
    setActionError("");
    setDone("");
    setTxHash("");
    setBusy("topup");
    try {

      const approveHash = await writeContractAsync({
        address: asset,
        abi: erc20Abi,
        functionName: "approve",
        args: [cell, amt],
      });
      await client.waitForTransactionReceipt({ hash: approveHash });
      const hash = await writeContractAsync({
        address: cell,
        abi: cellAbi,
        functionName: "topUpERC20",
        args: [amt],
      });
      setTxHash(hash);
      await client.waitForTransactionReceipt({ hash });
      setDone("topup");
      refetchAll();
      router.refresh();
    } catch (e) {
      setActionError((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(null);
    }
  }

  async function signAmend(payout: `0x${string}`) {
    setActionError("");
    setDone("");
    setBusy("sign");
    try {
      const hrs = Math.max(1, Math.floor(Number(deadlineHrs)) || 24);
      const deadline = BigInt(now + hrs * 3600);
      const sig = await signTypedDataAsync({
        domain: {
          name: "WishCell",
          version: "1",
          chainId: appChain.id,
          verifyingContract: cell,
        },
        types: {
          Amend: [
            { name: "payout", type: "address" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Amend",
        message: { payout, nonce: amendNonce, deadline },
      });

      const parsed = parseSignature(sig);
      const r = parsed.r;
      const s = parsed.s;
      const v = parsed.v !== undefined ? Number(parsed.v) : parsed.yParity + 27;
      const payload = JSON.stringify(
        {
          cell,
          chainId: appChain.id,
          function: "amendWithSig",
          args: { payout, deadline: deadline.toString(), v, r, s },
          nonce: amendNonce.toString(),
        },
        null,
        2,
      );
      setSigned({ payout, deadline, v, r, s, payload, nonce: amendNonce });
      setDone("sign");
    } catch (e) {
      setActionError((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(null);
    }
  }

  const busyLabel = (id: string, idle: string) =>
    busy === id ? "Waiting for wallet…" : idle;

  const loading =
    stateRead.isLoading ||
    schemaRead.isLoading ||
    timeoutsRead.isLoading ||
    lastActivityRead.isLoading;

  return (
    <div className="panel stack" data-testid="owner-actions">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Manage this wish</strong>
        {isConnected ? (
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            acting as <span className="mono">{shortAddr(connected!)}</span> · {roleLabel}
          </span>
        ) : null}
      </div>

      {loading ? <p className="muted">Reading the cell…</p> : null}

      {!isConnected ? (
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>
            Connect the <strong>depositor</strong> or <strong>guardian</strong> wallet to
            amend, revoke, ping the liveness clock, or claim an owed payout. Everything
            here runs off the signed schema on chain. The contract rejects anyone else.
          </p>
          <div className="row">
            {connectors.map((c) => (
              <button
                key={c.uid}
                className="secondary"
                onClick={() => connect({ connector: c })}
              >
                Connect {c.name === "Injected" ? "browser wallet" : c.name}
              </button>
            ))}
          </div>
        </div>
      ) : wrongChain ? (
        <div className="row">
          <span className="muted">
            Your wallet is on the wrong network for this wish.
          </span>
          <button className="secondary" onClick={() => switchChain({ chainId: appChain.id })}>
            Switch to {appChain.name}
          </button>
        </div>
      ) : null}

      {}
      {isLive && !loading ? (
        <div className="stack" style={{ gap: "0.25rem" }}>
          <div className="muted" style={{ fontSize: "0.85rem" }}>
            Depositor last active {formatDuration(now - lastActivity)} ago.
            {amendLocked ? (
              <> Amendment is locked during this off-chain action attempt.</>
            ) : hasGuardian ? (
              <>
                {" "}
                Guardian may redirect{" "}
                {guardianAmendReady ? (
                  <strong>now</strong>
                ) : (
                  <>in {formatDuration(guardianAmendAt + CLOCK_BUFFER - now)}</>
                )}
                .
              </>
            ) : (
              <> No guardian set.</>
            )}{" "}
            {state === 1 ? (
              <>
                Escheatable{" "}
                {escheatReady ? (
                  <strong>now</strong>
                ) : (
                  <>in {formatDuration(escheatAt + CLOCK_BUFFER - now)}</>
                )}
                .
              </>
            ) : (
              <>Not escheatable during an attempt.</>
            )}
          </div>
        </div>
      ) : null}

      {isConnected && !isLive && state >= 0 && owedAmount === 0n ? (
        <p className="muted" style={{ margin: 0 }}>
          This wish has resolved ({["Created", "Waiting", "Attempting", "Fulfilled", "Amended", "Escheated"][state] ?? "?"}). The live controls are closed.
        </p>
      ) : null}

      {}
      {isWisher && isLive && !wrongChain ? (
        <div className="row">
          <button onClick={() => doWrite("ping", "ping")} disabled={busy !== null}>
            {busyLabel("ping", "Ping: I'm still here")}
          </button>
          <span className="muted">Resets the guardian-amend and escheat clocks.</span>
        </div>
      ) : null}

      {}
      {isWisher && isLive && !wrongChain ? (
        <div className="row">
          <label>
            Top up principal with{" "}
            <input
              type="number"
              min="0.0001"
              step="0.001"
              value={topUpAmount}
              onChange={(e) => setTopUpAmount(e.target.value)}
              style={{ width: "7rem", display: "inline-block" }}
              data-testid="topup-input"
            />{" "}
            {isToken ? tokenSymbol : "ETH"}
          </label>
          <button
            onClick={isToken ? doTopUpERC20 : doTopUp}
            disabled={busy !== null}
            data-testid="topup-button"
          >
            {busyLabel("topup", isToken ? `Approve ${tokenSymbol} & top up` : "Top up")}
          </button>
          <span className="muted">Raises your principal, never performance-fee&rsquo;d.</span>
        </div>
      ) : null}

      {}
      {isSealed && isLive ? (
        <p className="muted" style={{ margin: 0 }} data-testid="sealed-note">
          🔒 This wish is <strong>sealed</strong>: irrevocable. It can never be
          amended, redirected, or revoked; only fulfilled, or escheated after long
          inactivity.
        </p>
      ) : null}

      {}
      {isWisher && isLive && !isSealed && !wrongChain ? (
        <div className="stack" style={{ gap: "0.5rem" }}>
          <div>
            <strong>Revoke or redirect</strong>{" "}
            <span className="muted">(terminal: settles fees, then pays out and closes the wish)</span>
          </div>
          {amendLocked ? (
            <p className="muted" style={{ margin: 0 }}>
              Amendment is locked while an off-chain action attempt is in flight; it
              reopens when the attempt expires.
            </p>
          ) : (
            <>
              <div className="row">
                {confirm === "revoke" ? (
                  <>
                    <span className="muted">Return all funds to you and close the wish?</span>
                    <button onClick={() => doWrite("revoke", "amend", [schema!.wisher])} disabled={busy !== null}>
                      {busyLabel("revoke", "Confirm revoke")}
                    </button>
                    <button className="secondary" onClick={() => setConfirm(null)}>Cancel</button>
                  </>
                ) : (
                  <button className="secondary" onClick={() => setConfirm("revoke")} disabled={busy !== null}>
                    Revoke: return funds to me
                  </button>
                )}
              </div>
              <div className="row">
                <input
                  type="text"
                  placeholder="0x… redirect payout"
                  value={redirectTo}
                  onChange={(e) => {
                    setRedirectTo(e.target.value);
                    setConfirm((c) => (c === "redirect" || c === "gredirect" ? null : c));
                  }}
                  style={{ maxWidth: "24rem" }}
                  data-testid="redirect-input"
                />
                {confirm === "redirect" ? (
                  <>
                    <button
                      onClick={() => doWrite("redirect", "amend", [getAddress(redirectTo)])}
                      disabled={busy !== null}
                    >
                      {busyLabel("redirect", "Confirm redirect")}
                    </button>
                    <button className="secondary" onClick={() => setConfirm(null)}>Cancel</button>
                  </>
                ) : (
                  <button
                    className="secondary"
                    onClick={() => setConfirm("redirect")}
                    disabled={busy !== null || !validRedirect}
                  >
                    Redirect funds here
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      ) : null}

      {}
      {isWisher && isLive && !amendLocked && !isSealed && !wrongChain ? (
        <div className="stack" style={{ gap: "0.4rem" }}>
          <div>
            <strong>Sign a gasless revoke/redirect:</strong>{" "}
            <span className="muted">
              produce an EIP-712 payload a relayer can submit (they pay gas). Valid for
            </span>{" "}
            <input
              type="number"
              min="1"
              value={deadlineHrs}
              onChange={(e) => setDeadlineHrs(e.target.value)}
              style={{ width: "4.5rem", display: "inline-block" }}
            />{" "}
            <span className="muted">hours, against nonce {amendNonce.toString()}.</span>
          </div>
          <div className="row">
            <button
              className="secondary"
              onClick={() => signAmend(schema!.wisher)}
              disabled={busy !== null}
            >
              {busy === "sign" ? "Check your wallet…" : "Sign revoke (to me)"}
            </button>
            <button
              className="secondary"
              onClick={() => validRedirect && signAmend(getAddress(redirectTo))}
              disabled={busy !== null || !validRedirect}
            >
              Sign redirect (to address above)
            </button>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
            The relay verifies an EOA signature (ecrecover). A smart-contract wallet
            depositor should use the direct buttons above instead.
          </p>
          {signed ? (
            <div className="stack" style={{ gap: "0.4rem" }}>
              <pre className="schema" data-testid="relay-payload">{signed.payload}</pre>
              {signedVoid ? (
                <p className="error" style={{ margin: 0 }}>
                  This signature is void. The nonce has moved on (you amended or
                  invalidated). Re-sign for a fresh payload.
                </p>
              ) : null}
              <div className="row">
                <button
                  onClick={() =>
                    doWrite("relay", "amendWithSig", [
                      signed.payout,
                      signed.deadline,
                      signed.v,
                      signed.r,
                      signed.s,
                    ]).then((ok) => ok && setSigned(null))
                  }
                  disabled={busy !== null || signedVoid}
                >
                  {busyLabel("relay", "Submit it now (any wallet pays gas)")}
                </button>
                <span className="muted">
                  or hand the payload above to a relayer. Cancel it any time with
                  “Invalidate signatures”.
                </span>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {}
      {isWisher && isLive && !isSealed && !wrongChain ? (
        <div className="row">
          <button
            className="secondary"
            onClick={() => doWrite("invalidate", "invalidateAmendSignatures")}
            disabled={busy !== null}
          >
            {busyLabel("invalidate", "Invalidate signatures")}
          </button>
          <span className="muted">Voids any revoke/redirect payloads you’ve signed (bumps the nonce).</span>
        </div>
      ) : null}

      {}
      {isGuardian && isLive && !amendLocked && !isSealed && !wrongChain ? (
        <div className="stack" style={{ gap: "0.4rem" }}>
          <div>
            <strong>Guardian redirect</strong>{" "}
            <span className="muted">
              {guardianAmendReady
                ? "(the depositor has been inactive past the amend window)"
                : `(available in ${formatDuration(guardianAmendAt + CLOCK_BUFFER - now)}; depositor still active)`}
            </span>
          </div>
          <div className="row">
            <input
              type="text"
              placeholder="0x… redirect payout"
              value={redirectTo}
              onChange={(e) => {
                setRedirectTo(e.target.value);
                setConfirm((c) => (c === "redirect" || c === "gredirect" ? null : c));
              }}
              style={{ maxWidth: "24rem" }}
            />
            {confirm === "gredirect" ? (
              <>
                <button
                  onClick={() => doWrite("gredirect", "amend", [getAddress(redirectTo)])}
                  disabled={busy !== null}
                >
                  {busyLabel("gredirect", "Confirm redirect")}
                </button>
                <button className="secondary" onClick={() => setConfirm(null)}>Cancel</button>
              </>
            ) : (
              <button
                onClick={() => setConfirm("gredirect")}
                disabled={busy !== null || !guardianAmendReady || !validRedirect}
              >
                Redirect as guardian
              </button>
            )}
          </div>
        </div>
      ) : null}

      {}
      {owedAmount > 0n && !wrongChain ? (
        <div className="row">
          <button onClick={() => doWrite("claim", "claimOwed")} disabled={busy !== null}>
            {busyLabel("claim", `Claim ${formatEther(owedAmount)} ETH owed to you`)}
          </button>
          <span className="muted">A payout whose push transfer failed at resolution.</span>
        </div>
      ) : null}

      {}
      {distLeaf && !claimedRead.data && !wrongChain ? (
        now > Number(distChalRead.data ?? 0n) ? (
          <div className="row" data-testid="claim-distribution">
            <button
              onClick={() =>
                doWrite("claimDist", "claimDistribution", [
                  BigInt(distLeaf.index),
                  getAddress(distLeaf.account),
                  BigInt(distLeaf.weight),
                  distLeaf.proof,
                ])
              }
              disabled={busy !== null}
            >
              {busyLabel("claimDist", "Claim your distribution share")}
            </button>
            <span className="muted">Your pro-rata slice of the fulfilled distribution.</span>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }} data-testid="claim-distribution-pending">
            Your distribution share opens for claiming after the challenge window closes.
          </p>
        )
      ) : null}

      {}
      {escheatReady && isConnected && !wrongChain ? (
        <div className="row">
          {confirm === "escheat" ? (
            <>
              <span className="muted">Sweep this abandoned wish to the platform?</span>
              <button onClick={() => doWrite("escheat", "escheat")} disabled={busy !== null}>
                {busyLabel("escheat", "Confirm escheat")}
              </button>
              <button className="secondary" onClick={() => setConfirm(null)}>Cancel</button>
            </>
          ) : (
            <>
              <button className="secondary" onClick={() => setConfirm("escheat")} disabled={busy !== null}>
                Escheat this dead wish
              </button>
              <span className="muted">
                Inactive past its escheat window. Anyone may now sweep it to the platform.
              </span>
            </>
          )}
        </div>
      ) : null}

      {txHash ? (
        <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
          tx <span className="mono">{shortAddr(txHash)}</span>
        </p>
      ) : null}
      {done && !actionError ? (
        <p className="success" style={{ margin: 0 }}>Done. The cell has been updated.</p>
      ) : null}
      {actionError ? <p className="error" style={{ margin: 0 }}>{actionError}</p> : null}
    </div>
  );
}
