import { formatUnits } from "viem";

export function amount(wei: bigint, decimals = 18, symbol = "ETH", dp = 4): string {
  const s = Number(formatUnits(wei, decimals));
  return `${s.toLocaleString("en-GB", { maximumFractionDigits: dp })} ${symbol}`;
}

export function eth(wei: bigint, dp = 4): string {
  return amount(wei, 18, "ETH", dp);
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function wishTag(n: number, address: string): string {
  return n > 0 ? `#${String(n).padStart(4, "0")}` : shortAddr(address);
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…`;
}

export function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function days(seconds: bigint): string {
  return `${Number(seconds) / 86400}d`;
}

export const USD_PER_ETH = 2000;

function usd(n: number): string {
  return `≈ $${n.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: n > 0 && n < 100 ? 2 : 0,
  })}`;
}

export function usdEquivalent(
  wei: bigint,
  decimals: number,
  symbol: string,
  isNative: boolean,
): string | null {
  const n = Number(formatUnits(wei, decimals));
  if (isNative) return usd(n * USD_PER_ETH);
  const s = symbol.toUpperCase();
  if (s.includes("USD")) return usd(n);
  return null;
}
