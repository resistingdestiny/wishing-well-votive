"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { formatUnits, isAddress, parseUnits } from "viem";
import { appChain, RESOURCE_POOL_ADDRESS } from "@/lib/wagmi";
import { erc20Abi, erc4626Abi } from "@/lib/chain";
import { Field } from "@/app/ui/Field";

export function PoolPanel() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [deployed, setDeployed] = useState<boolean | null>(null);
  const [asset, setAsset] = useState<{ address: `0x${string}`; symbol: string; decimals: number } | null>(null);
  const [tvl, setTvl] = useState<bigint>(0n);
  const [yours, setYours] = useState<bigint>(0n);
  const [depositAmt, setDepositAmt] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  async function refresh(pool: `0x${string}`, user?: `0x${string}`) {
    if (!client) return;
    const [total, assetAddr] = await Promise.all([
      client.readContract({ address: pool, abi: erc4626Abi, functionName: "totalAssets" }),
      client.readContract({ address: pool, abi: erc4626Abi, functionName: "asset" }),
    ]);
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: assetAddr, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: assetAddr, abi: erc20Abi, functionName: "decimals" }),
    ]);
    setTvl(total);
    setAsset({ address: assetAddr, symbol, decimals });
    if (user) {
      const shares = await client.readContract({ address: pool, abi: erc4626Abi, functionName: "balanceOf", args: [user] });
      const assets = shares > 0n
        ? await client.readContract({ address: pool, abi: erc4626Abi, functionName: "convertToAssets", args: [shares] })
        : 0n;
      setYours(assets);
    } else {
      setYours(0n);
    }
  }

  useEffect(() => {
    let live = true;
    (async () => {
      if (!client || !RESOURCE_POOL_ADDRESS || !isAddress(RESOURCE_POOL_ADDRESS)) {
        setDeployed(false);
        return;
      }
      try {
        const code = await client.getCode({ address: RESOURCE_POOL_ADDRESS });
        if (!live) return;
        if (!code || code === "0x") {
          setDeployed(false);
          return;
        }
        setDeployed(true);
        await refresh(RESOURCE_POOL_ADDRESS, address);
      } catch {
        if (live) setDeployed(false);
      }
    })();

  }, [client, address]);

  async function run(fn: () => Promise<void>) {
    setError("");
    setNote("");
    setBusy(true);
    try {
      await fn();
      if (RESOURCE_POOL_ADDRESS) await refresh(RESOURCE_POOL_ADDRESS, address);
    } catch (e) {
      setError((e as Error).message.slice(0, 300));
    } finally {
      setBusy(false);
    }
  }

  const deposit = () =>
    run(async () => {
      if (!asset || !RESOURCE_POOL_ADDRESS || !address || !client) return;
      const amt = parseUnits(depositAmt || "0", asset.decimals);
      if (amt <= 0n) throw new Error("Enter an amount to deposit.");
      const approveHash = await writeContractAsync({
        address: asset.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [RESOURCE_POOL_ADDRESS, amt],
        chainId: appChain.id,
      });
      await client.waitForTransactionReceipt({ hash: approveHash });
      const hash = await writeContractAsync({
        address: RESOURCE_POOL_ADDRESS,
        abi: erc4626Abi,
        functionName: "deposit",
        args: [amt, address],
        chainId: appChain.id,
      });
      await client.waitForTransactionReceipt({ hash });
      setNote(`Deposited ${depositAmt} ${asset.symbol}. Your shares earn every carve pro-rata.`);
      setDepositAmt("");
    });

  const withdraw = () =>
    run(async () => {
      if (!asset || !RESOURCE_POOL_ADDRESS || !address || !client) return;
      const shares = await client.readContract({
        address: RESOURCE_POOL_ADDRESS,
        abi: erc4626Abi,
        functionName: "balanceOf",
        args: [address],
      });
      const amt = withdrawAmt.trim() === "" ? shares : parseUnits(withdrawAmt, asset.decimals);
      if (amt <= 0n) throw new Error("Nothing to withdraw.");
      const hash = await writeContractAsync({
        address: RESOURCE_POOL_ADDRESS,
        abi: erc4626Abi,
        functionName: "redeem",
        args: [amt, address, address],
        chainId: appChain.id,
      });
      await client.waitForTransactionReceipt({ hash });
      setNote("Withdrew: principal plus any carve yield, instantly (v1).");
      setWithdrawAmt("");
    });

  if (deployed !== true) {
    return (
      <div className="panel hoverable" data-testid="pool-panel">
        <h3 style={{ marginTop: 0 }}>The resource pool</h3>
        <p className="muted" style={{ margin: 0 }}>
          Not deployed on this network yet. Monetary commitments open with the
          redeploy. When it lands: deposit the settlement asset (USDC), and every
          wish&rsquo;s resource carve flows to depositors pro-rata, on chain.
        </p>
      </div>
    );
  }

  const fmt = (v: bigint) => (asset ? Number(formatUnits(v, asset.decimals)).toLocaleString("en-GB", { maximumFractionDigits: 2 }) : "…");

  return (
    <div className="panel stack hoverable" data-testid="pool-panel">
      <div>
        <h3 style={{ margin: 0 }}>The resource pool</h3>
        <p className="muted" style={{ margin: "0.3rem 0 0" }}>
          Deposit {asset?.symbol ?? "the settlement asset"}. Cells carve 20% of the
          platform&rsquo;s post-solver performance share into the pool on every
          fulfil; your shares absorb it pro-rata. Instant withdrawals (v1).
        </p>
      </div>
      <div className="row" style={{ gap: "1.5rem" }}>
        <div>
          <div className="stat value" style={{ fontSize: "1.4rem" }} data-testid="pool-tvl">
            {fmt(tvl)} <span className="muted" style={{ fontSize: "0.8rem" }}>{asset?.symbol}</span>
          </div>
          <div className="label muted">pooled right now</div>
        </div>
        <div>
          <div className="stat value" style={{ fontSize: "1.4rem" }} data-testid="pool-yours">
            {fmt(yours)} <span className="muted" style={{ fontSize: "0.8rem" }}>{asset?.symbol}</span>
          </div>
          <div className="label muted">your share (with accrued carve)</div>
        </div>
      </div>
      {!isConnected ? (
        <p className="muted" style={{ margin: 0 }}>Connect a wallet to deposit or withdraw.</p>
      ) : (
        <div className="fieldRow">
          <Field label={`Deposit ${asset?.symbol ?? ""}`}>
            <input
              type="number"
              min="0"
              step="any"
              value={depositAmt}
              onChange={(e) => setDepositAmt(e.target.value)}
              placeholder="0.0"
              data-testid="pool-deposit-amount"
            />
          </Field>
          <Field label="Withdraw (blank = all)">
            <input
              type="number"
              min="0"
              step="any"
              value={withdrawAmt}
              onChange={(e) => setWithdrawAmt(e.target.value)}
              placeholder="0.0"
              data-testid="pool-withdraw-amount"
            />
          </Field>
          <div className="row" style={{ gap: "0.5rem" }}>
            <button onClick={deposit} disabled={busy || !asset} data-testid="pool-deposit-button">
              {busy ? "Working…" : "Deposit"}
            </button>
            <button className="secondary" onClick={withdraw} disabled={busy || !asset} data-testid="pool-withdraw-button">
              Withdraw
            </button>
          </div>
        </div>
      )}
      {error ? <p className="error" style={{ margin: 0 }} data-testid="pool-error">{error}</p> : null}
      {note ? <p className="success" style={{ margin: 0 }} data-testid="pool-done">{note}</p> : null}
    </div>
  );
}
