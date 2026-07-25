export type AccountsAction =
  | { tool: "transfer"; from: string; to: string; amount: number }
  | { tool: "done" };

export interface SandboxStep {
  ok: boolean;
  observation: string;
  error?: string;
}

export class AccountsSandbox {
  balances: Record<string, number>;
  private readonly initialTotal: number;

  constructor(initial: Record<string, number>) {
    this.balances = { ...initial };
    this.initialTotal = Object.values(initial).reduce((s, v) => s + v, 0);
  }

  state(): string {
    return Object.entries(this.balances)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
  }

  apply(a: AccountsAction): SandboxStep {
    if (a.tool === "done") return { ok: true, observation: "done" };
    const { from, to, amount } = a;
    if (!(from in this.balances)) return { ok: false, observation: this.state(), error: `unknown account ${from}` };
    if (!(to in this.balances)) return { ok: false, observation: this.state(), error: `unknown account ${to}` };
    if (from === to) return { ok: false, observation: this.state(), error: "from and to are the same" };
    if (!(amount > 0)) return { ok: false, observation: this.state(), error: "amount must be > 0" };
    if (!Number.isFinite(amount)) return { ok: false, observation: this.state(), error: "amount must be finite" };
    if (this.balances[from]! < amount) {
      return { ok: false, observation: this.state(), error: `insufficient funds in ${from} (has ${this.balances[from]})` };
    }
    this.balances[from]! -= amount;
    this.balances[to]! += amount;
    return { ok: true, observation: this.state() };
  }

  meets(target: Record<string, number>): boolean {
    return Object.entries(target).every(([k, v]) => this.balances[k] === v);
  }

  progress(target: Record<string, number>): number {
    const keys = Object.keys(target);
    if (keys.length === 0) return 1;
    return keys.filter((k) => this.balances[k] === target[k]).length / keys.length;
  }

  conserved(): boolean {
    return Object.values(this.balances).reduce((s, v) => s + v, 0) === this.initialTotal;
  }
}

export function parseAction(text: string): AccountsAction | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end < start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (o.tool === "done") return { tool: "done" };
    if (
      o.tool === "transfer" &&
      typeof o.from === "string" &&
      typeof o.to === "string" &&
      typeof o.amount === "number"
    ) {
      return { tool: "transfer", from: o.from, to: o.to, amount: o.amount };
    }
    return null;
  } catch {
    return null;
  }
}
