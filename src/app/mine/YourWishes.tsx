"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount, useConnect } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, getAddress } from "viem";
import { shortAddr, timeAgo } from "@/lib/format";
import { readMyCells, type MyCell } from "@/lib/myCells";
import { EmptyState } from "@/app/ui/EmptyState";

export interface SerializedCell {
  address: string;
  state: number;
  stateName: string;
  kindName: string;
  wisher: string;
  guardian: string;
  beneficiary: string;
  capabilityId: string;
  principalWei: string;
  balanceWei: string;
  parkedWei: string;
  feesWei: string;
  assetIsNative: boolean;
  assetDecimals: number;
  assetSymbol: string;
  positioned: boolean;
  payee: string;
  lastWisherActivity: number;
  amendAfter: number;
  escheatAfter: number;
  summary: string;
}

const ZERO = "0x0000000000000000000000000000000000000000";

function eq(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

function eth(wei: string, dp = 4): string {
  return amt(wei, 18, "ETH", dp);
}

function amt(wei: string, decimals: number, symbol: string, dp = 4): string {
  const n = Number(formatUnits(BigInt(wei), decimals));
  return `${n.toLocaleString("en-GB", { maximumFractionDigits: dp })} ${symbol}`;
}

function dur(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

interface Notif {
  id: string;
  kind: string;
  title: string;
  body: string;
  cell: string | null;
  read: boolean;
}

export function YourWishes({ cells }: { cells: SerializedCell[] }) {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const me = address?.toLowerCase();

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);

  const { data: inbox } = useQuery({
    queryKey: ["inbox", me],
    queryFn: async () => {
      const res = await fetch(`/api/notifications?subscriber=${me}`);
      if (!res.ok) throw new Error(`inbox ${res.status}`);
      return res.json() as Promise<{ notifications: Notif[] }>;
    },
    enabled: !!me,
  });

  const [local, setLocal] = useState<MyCell[]>([]);
  useEffect(() => setLocal(readMyCells()), []);

  const localSection = (exclude?: Set<string>) => {
    const items = exclude
      ? local.filter((l) => !exclude.has(l.cell.toLowerCase()))
      : local;
    if (items.length === 0) return null;
    return (
      <div className="panel" data-testid="my-cells">
        <strong>From this browser</strong>
        <ul style={{ margin: "0.5rem 0 0.4rem", paddingLeft: "1.1rem" }}>
          {items.map((l) => (
            <li key={l.cell} style={{ padding: "0.15rem 0" }}>
              <Link href={`/wish/${l.cell}`} className="mono">
                {shortAddr(l.cell)}
              </Link>{" "}
              {l.label ? <span>· {l.label} </span> : null}
              <span className={`badge ${l.source === "fund" ? "claimable" : "waiting"}`}>
                {l.source === "fund" ? "funded with money" : "opened here"}
              </span>{" "}
              <span className="faint">{timeAgo(new Date(l.ts))}</span>
            </li>
          ))}
        </ul>
        <p className="faint" style={{ margin: 0 }}>
          Saved on this device only. It works without a wallet, and clears with your
          browser data. Keep each wish&rsquo;s link somewhere safe too.
        </p>
      </div>
    );
  };

  if (!isConnected) {
    return (
      <div className="stack" data-testid="your-wishes">
        {localSection()}
        <div className="panel stack emptyState">
          <div className="orb" style={{ width: 44, height: 44 }} aria-hidden="true" />
          <p className="muted" style={{ margin: 0 }}>
            Connect your wallet to see the wishes you own, guard, or benefit from.
          </p>
          <div className="row">
            {connectors.map((c) => (
              <button key={c.uid} className="secondary" onClick={() => connect({ connector: c })}>
                Connect {c.name === "Injected" ? "browser wallet" : c.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const mine = cells
    .map((c) => {
      const roles: string[] = [];
      if (eq(me, c.wisher)) roles.push("wisher");
      if (c.guardian !== ZERO && eq(me, c.guardian)) roles.push("guardian");

      const effectiveBeneficiary = c.positioned ? c.payee : c.beneficiary;
      if (effectiveBeneficiary !== ZERO && eq(me, effectiveBeneficiary)) roles.push("beneficiary");
      return { c, roles };
    })
    .filter((x) => x.roles.length > 0);

  const live = mine.filter((x) => x.c.state === 1 || x.c.state === 2);

  const funded = live.filter((x) => x.roles.includes("wisher"));

  const fundedEth = funded.filter((x) => x.c.assetIsNative);
  const parkedTotal = fundedEth.reduce((sum, x) => sum + BigInt(x.c.balanceWei), 0n);
  const feesTotal = fundedEth.reduce((sum, x) => sum + BigInt(x.c.feesWei), 0n);
  const grantable = (inbox?.notifications ?? []).filter(
    (n) => n.kind === "wish-grantable" && !n.read,
  );

  if (mine.length === 0) {
    return (
      <div className="stack" data-testid="your-wishes">
        {localSection()}
        <EmptyState
          title={
            <>
              No wishes for <span className="mono">{shortAddr(address!)}</span> yet
            </>
          }
          body="Make a wish and it appears here with its clocks, fees, and unlocks."
          action={
            <>
              <Link href="/create" className="pill pillPrimary">
                Make a wish
              </Link>
              <Link href="/fund" className="pill">
                Fund with money
              </Link>
              <Link href="/board" className="pill">
                Watch the board
              </Link>
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className="stack" data-testid="your-wishes">
      <div className="kpiRow">
        <div className="panel stat">
          <div className="value">{mine.length}</div>
          <div className="label">wishes you&rsquo;re part of</div>
        </div>
        <div className="panel stat">
          <div className="value">{eth(parkedTotal.toString(), 3)}</div>
          <div className="label">your parked funds</div>
        </div>
        <div className="panel stat">
          <div className="value">{eth(feesTotal.toString(), 5)}</div>
          <div className="label">fees accruing on them</div>
        </div>
      </div>

      {grantable.length > 0 ? (
        <div className="panel" style={{ borderLeft: "3px solid var(--blue)" }}>
          <strong>Just unlocked for you</strong>
          <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
            {grantable.map((n) => (
              <li key={n.id}>
                {n.cell ? (
                  <Link href={`/wish/${n.cell}`}>{n.body}</Link>
                ) : (
                  n.body
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="panel tableWrap" data-reveal>
        <table data-testid="your-wishes-table">
          <thead>
            <tr>
              <th>Wish</th>
              <th>Your role</th>
              <th>State</th>
              <th>Parked</th>
              <th>Fees</th>
              <th>Clock</th>
            </tr>
          </thead>
          <tbody>
            {mine.map(({ c, roles }) => {
              const isLive = c.state === 1 || c.state === 2;
              const escheatAt = c.lastWisherActivity + c.escheatAfter;
              const amendAt = c.lastWisherActivity + c.amendAfter;
              return (
                <tr key={c.address}>
                  <td>
                    <Link href={`/wish/${c.address}`} className="mono">
                      {shortAddr(c.address)}
                    </Link>
                    {c.summary ? (
                      <div className="muted" style={{ maxWidth: "26ch" }}>
                        {c.summary}
                      </div>
                    ) : null}
                  </td>
                  <td>{roles.join(" + ")}</td>
                  <td>
                    <span className={`badge ${c.stateName.toLowerCase()}`}>{c.stateName}</span>
                  </td>
                  <td>{amt(c.balanceWei, c.assetDecimals, c.assetSymbol)}</td>
                  <td>{amt(c.feesWei, c.assetDecimals, c.assetSymbol, 6)}</td>
                  <td className="muted" style={{ fontSize: "0.8rem" }}>
                    {!isLive ? (
                      "-"
                    ) : roles.includes("guardian") ? (
                      <>redirect in {dur(amendAt - now)}</>
                    ) : (
                      <>escheat in {dur(escheatAt - now)}</>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {localSection(new Set(mine.map(({ c }) => c.address.toLowerCase())))}
    </div>
  );
}
