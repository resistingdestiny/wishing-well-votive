"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { formatUnits, parseAbi, type Address } from "viem";
import { appChain } from "@/lib/wagmi";
import { noteTx } from "@/lib/noteTx";

const faucetAbi = parseAbi([
  "function faucet()",
  "function faucetAvailableAt(address account) view returns (uint64)",
  "function FAUCET_AMOUNT() view returns (uint256)",
  "function FAUCET_INTERVAL() view returns (uint64)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

/**
 * Read statically. Next inlines `NEXT_PUBLIC_*` by substituting the literal
 * text, so a computed `process.env[key]` is `undefined` in the browser while
 * working perfectly on the server.
 */
const asAddress = (v: string | undefined): Address | undefined =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;

const TOKENS: Address[] = [
  asAddress(process.env.NEXT_PUBLIC_VOTIVE_TOKEN),
  asAddress(process.env.NEXT_PUBLIC_AQUA_TOKEN_B),
].filter((a): a is Address => a !== undefined)
  // The funding token and tokenA are usually the same contract; drawing twice
  // from one faucet just fails the interval check and looks like a bug.
  .filter((a, i, all) => all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i);

interface TokenState {
  address: Address;
  symbol: string;
  decimals: number;
  amount: bigint;
  interval: bigint;
  supply: bigint;
  balance: bigint;
  availableAt: bigint;
}

function waitLabel(availableAt: bigint, now: number): string | null {
  const secs = Number(availableAt) - now;
  if (secs <= 0) return null;
  if (secs < 90) return `${secs}s`;
  return `${Math.ceil(secs / 60)} min`;
}

/**
 * The faucet: how somebody who turned up with an empty wallet gets the token
 * everything else on this deployment is denominated in.
 *
 * It matters more than it looks. Every other flow here — funding a wish, taking
 * the other side of its Aqua position, being paid for fulfilling it — moves
 * VOTIVE. Without a way to get some, a visitor can read the protocol but cannot
 * touch it, and the demo becomes a video.
 */
export function FaucetPanel() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [tokens, setTokens] = useState<TokenState[] | null>(null);
  const [failed, setFailed] = useState("");
  const [busy, setBusy] = useState<Address | "">("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const refresh = useCallback(async () => {
    if (!client || TOKENS.length === 0) return;
    try {
      const read = await Promise.all(
        TOKENS.map(async (t) => {
          const [symbol, decimals, amount, interval, supply] = await Promise.all([
            client.readContract({ address: t, abi: faucetAbi, functionName: "symbol" }),
            client.readContract({ address: t, abi: faucetAbi, functionName: "decimals" }),
            client.readContract({ address: t, abi: faucetAbi, functionName: "FAUCET_AMOUNT" }),
            client.readContract({ address: t, abi: faucetAbi, functionName: "FAUCET_INTERVAL" }),
            client.readContract({ address: t, abi: faucetAbi, functionName: "totalSupply" }),
          ]);
          const [balance, availableAt] = address
            ? await Promise.all([
                client.readContract({ address: t, abi: faucetAbi, functionName: "balanceOf", args: [address] }),
                client.readContract({ address: t, abi: faucetAbi, functionName: "faucetAvailableAt", args: [address] }),
              ])
            : [0n, 0n];
          return {
            address: t,
            symbol: symbol as string,
            decimals: Number(decimals),
            amount: amount as bigint,
            interval: interval as bigint,
            supply: supply as bigint,
            balance: balance as bigint,
            availableAt: availableAt as bigint,
          };
        }),
      );
      setTokens(read);
      setFailed("");
    } catch (e) {
      // Say so rather than rendering an empty faucet, which reads as "no tokens
      // here" when the truth is "the node did not answer".
      setFailed((e as Error).message.slice(0, 200));
    }
  }, [client, address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Only so the countdown ticks; nothing is re-read.
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  async function draw(t: TokenState) {
    setError("");
    setNote("");
    setBusy(t.address);
    try {
      const hash = await writeContractAsync({
        address: t.address,
        abi: faucetAbi,
        functionName: "faucet",
        args: [],
        chainId: appChain.id,
      });
      await client?.waitForTransactionReceipt({ hash });
      noteTx("faucet-drawn", hash, {
        detail: `${formatUnits(t.amount, t.decimals)} ${t.symbol}`,
        contract: t.address,
        subject: address,
      });
      setNote(
        `${formatUnits(t.amount, t.decimals)} ${t.symbol} is in your wallet. ` +
          `Fund a wish with it, or take the other side of one.`,
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message.slice(0, 300));
    } finally {
      setBusy("");
    }
  }

  if (TOKENS.length === 0) {
    return (
      <div className="panel" data-testid="faucet-unconfigured">
        <h3 style={{ marginTop: 0 }}>No faucet on this network</h3>
        <p className="muted" style={{ margin: 0 }}>
          This deployment has no Votive token configured, so there is nothing to
          hand out. On a network where one is deployed, this page draws it.
        </p>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="panel" data-testid="faucet-degraded">
        <h3 style={{ marginTop: 0 }}>The faucet could not be read</h3>
        <p className="muted" style={{ margin: 0 }}>
          The node did not answer, so the balances below would be guesses. Nothing
          is broken on chain — reload in a moment.
        </p>
        <p className="error" style={{ marginBottom: 0 }}>{failed}</p>
      </div>
    );
  }

  return (
    <div className="stack" data-testid="faucet-panel">
      {(tokens ?? []).map((t) => {
        const wait = address ? waitLabel(t.availableAt, now) : null;
        const hours = Number(t.interval) / 3600;
        return (
          <div className="panel stack hoverable" key={t.address} data-testid={`faucet-${t.symbol}`}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <h3 style={{ margin: 0 }}>{t.symbol}</h3>
              <span className="mono muted" style={{ fontSize: "0.78rem" }}>{t.address}</span>
            </div>

            <div className="row" style={{ gap: "1.5rem" }}>
              <div>
                <div className="stat value" style={{ fontSize: "1.4rem" }} data-testid={`faucet-balance-${t.symbol}`}>
                  {Number(formatUnits(t.balance, t.decimals)).toLocaleString("en-GB", { maximumFractionDigits: 2 })}
                </div>
                <div className="label muted">in your wallet</div>
              </div>
              <div>
                <div className="stat value" style={{ fontSize: "1.4rem" }}>
                  {Number(formatUnits(t.amount, t.decimals)).toLocaleString("en-GB", { maximumFractionDigits: 0 })}
                </div>
                <div className="label muted">per draw, every {hours === 1 ? "hour" : `${hours} hours`}</div>
              </div>
              <div>
                <div className="stat value" style={{ fontSize: "1.4rem" }}>
                  {Number(formatUnits(t.supply, t.decimals)).toLocaleString("en-GB", { maximumFractionDigits: 0 })}
                </div>
                <div className="label muted">minted so far</div>
              </div>
            </div>

            {!isConnected ? (
              <p className="muted" style={{ margin: 0 }}>Connect a wallet to draw.</p>
            ) : (
              <div className="row" style={{ gap: "0.6rem", alignItems: "center" }}>
                <button
                  onClick={() => draw(t)}
                  disabled={busy !== "" || wait !== null}
                  data-testid={`faucet-draw-${t.symbol}`}
                >
                  {busy === t.address ? "Drawing…" : `Draw ${t.symbol}`}
                </button>
                {wait ? (
                  <span className="muted" style={{ fontSize: "0.85rem" }}>
                    You drew recently. Again in {wait}.
                  </span>
                ) : null}
              </div>
            )}
          </div>
        );
      })}

      {tokens === null ? <p className="muted">Reading the faucet…</p> : null}
      {error ? <p className="error" data-testid="faucet-error">{error}</p> : null}
      {note ? <p className="success" data-testid="faucet-done">{note}</p> : null}
    </div>
  );
}
