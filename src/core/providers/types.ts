export type UsdcAmount = bigint;

export const USDC_DECIMALS = 6;

export function formatUsdc(amount: UsdcAmount): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  const dollars = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${dollars}.${frac}`;
}

export function parseUsdc(input: string | number): UsdcAmount {
  const cleaned = String(input).replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) throw new Error(`invalid USD amount: ${input}`);

  const parts = cleaned.split(".");
  const whole = parts[0] ?? "0";
  const frac = parts[1] ?? "";
  const micros = (frac + "000000").slice(0, 6);
  const sign = whole.startsWith("-") ? -1n : 1n;
  return sign * (BigInt(whole.replace("-", "")) * 1_000_000n + BigInt(micros));
}

export interface ProviderErr {
  ok: false;

  needsHuman: boolean;

  code: string;
  message: string;
}

export type ProviderResult<T> = ({ ok: true } & T) | ProviderErr;

export function ok<T extends object>(value: T): { ok: true } & T {
  return { ok: true, ...value };
}

export function err(code: string, message: string, needsHuman = true): ProviderErr {
  return { ok: false, needsHuman, code, message };
}

export interface NamedProvider {

  readonly kind: string;

  readonly provider: string;
}

export interface Settlement {

  credit(to: `0x${string}`, amount: UsdcAmount): Promise<{ ref: string }>;

  debit(from: `0x${string}`, amount: UsdcAmount): Promise<{ ref: string }>;
}

export interface Swap {

  ethToUsdc(args: { amountWei: bigint; to: `0x${string}`; minOut?: UsdcAmount }): Promise<{
    usdcOut: UsdcAmount;
    ref: string;
  }>;
}

export class LedgerSwap implements Swap {
  private seq = 0;

  constructor(private readonly rateUsdcPerEth: UsdcAmount = 2_000_000_000n) {}
  async ethToUsdc(args: { amountWei: bigint; to: `0x${string}`; minOut?: UsdcAmount }): Promise<{
    usdcOut: UsdcAmount;
    ref: string;
  }> {
    const usdcOut = (args.amountWei * this.rateUsdcPerEth) / 10n ** 18n;
    if (args.minOut !== undefined && usdcOut < args.minOut) {
      throw new Error(`swap slippage: ${usdcOut} < minOut ${args.minOut}`);
    }
    return { usdcOut, ref: `ledger-swap-${++this.seq}` };
  }
}

export class LedgerSettlement implements Settlement {
  readonly credits: { to: string; amount: UsdcAmount }[] = [];
  readonly debits: { from: string; amount: UsdcAmount }[] = [];
  private seq = 0;
  async credit(to: `0x${string}`, amount: UsdcAmount): Promise<{ ref: string }> {
    this.credits.push({ to, amount });
    return { ref: `ledger-credit-${++this.seq}` };
  }
  async debit(from: `0x${string}`, amount: UsdcAmount): Promise<{ ref: string }> {
    this.debits.push({ from, amount });
    return { ref: `ledger-debit-${++this.seq}` };
  }
  balanceOf(addr: string): UsdcAmount {
    const c = this.credits.filter((x) => x.to.toLowerCase() === addr.toLowerCase()).reduce((s, x) => s + x.amount, 0n);
    const d = this.debits.filter((x) => x.from.toLowerCase() === addr.toLowerCase()).reduce((s, x) => s + x.amount, 0n);
    return c - d;
  }
}
