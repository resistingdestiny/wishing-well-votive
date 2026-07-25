import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const AddressZ = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((v) => v as `0x${string}`);
const MicroUsdZ = z.string().regex(/^\d+$/);

export const EmbeddedWalletZ = z.object({
  id: z.string(),
  owner: z.string(),
  address: AddressZ,
  via: z.enum(["email", "passkey"]),
  provider: z.string(),
  createdAt: z.string(),
});
export type StoredWallet = z.infer<typeof EmbeddedWalletZ>;

export const OnrampSessionZ = z.object({
  id: z.string(),
  owner: z.string(),
  amountUsdc: MicroUsdZ,
  destination: AddressZ,
  status: z.enum(["created", "completed", "declined"]),
  provider: z.string(),
  createdAt: z.string(),
  settledRef: z.string().optional(),
  declineReason: z.string().optional(),
});
export type StoredOnrampSession = z.infer<typeof OnrampSessionZ>;

export const VirtualAccountZ = z.object({
  id: z.string(),
  owner: z.string(),
  currency: z.string(),
  bankName: z.string(),
  accountNumber: z.string(),
  routingNumber: z.string(),
  reference: z.string(),
  destination: AddressZ,
  provider: z.string(),
  createdAt: z.string(),
});
export type StoredVirtualAccount = z.infer<typeof VirtualAccountZ>;

export const BankTransferZ = z.object({
  id: z.string(),
  virtualAccountId: z.string(),
  amountUsdc: MicroUsdZ,
  status: z.enum(["pending", "settled"]),
  provider: z.string(),
  receivedAt: z.string(),
  settledRef: z.string().optional(),
});
export type StoredBankTransfer = z.infer<typeof BankTransferZ>;

export const KycSessionZ = z.object({
  id: z.string(),
  subject: z.string(),
  status: z.enum(["pending", "approved", "rejected", "manual-review"]),
  sanctioned: z.boolean().default(false),
  provider: z.string(),
  createdAt: z.string(),

  descriptorHash: z.string().optional(),
});
export type StoredKycSession = z.infer<typeof KycSessionZ>;

export const PayoutZ = z.object({
  id: z.string(),
  subject: z.string(),
  amountUsdc: MicroUsdZ,
  custody: AddressZ,
  bankHolder: z.string(),
  bankAccount: z.string(),
  status: z.enum(["pending", "paid", "failed"]),
  provider: z.string(),
  createdAt: z.string(),
  settledRef: z.string().optional(),
});
export type StoredPayout = z.infer<typeof PayoutZ>;

const FileSchema = z.object({
  wallets: z.array(EmbeddedWalletZ).default([]),
  onrampSessions: z.array(OnrampSessionZ).default([]),
  virtualAccounts: z.array(VirtualAccountZ).default([]),
  bankTransfers: z.array(BankTransferZ).default([]),
  kycSessions: z.array(KycSessionZ).default([]),
  payouts: z.array(PayoutZ).default([]),
});
type FileShape = z.infer<typeof FileSchema>;

const EMPTY: FileShape = {
  wallets: [],
  onrampSessions: [],
  virtualAccounts: [],
  bankTransfers: [],
  kycSessions: [],
  payouts: [],
};

export class ProviderStore {
  private readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "provider-state.json");
  }

  private read(): FileShape {
    if (!fs.existsSync(this.file)) return structuredClone(EMPTY);
    return FileSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
  }

  private write(data: FileShape): void {
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2) + "\n");
  }

  private mutate(fn: (d: FileShape) => void): FileShape {
    const d = this.read();
    fn(d);
    this.write(d);
    return d;
  }

  upsertWallet(w: StoredWallet): StoredWallet {
    this.mutate((d) => {
      const i = d.wallets.findIndex((x) => x.owner === w.owner);
      if (i >= 0) d.wallets[i] = w;
      else d.wallets.push(w);
    });
    return w;
  }
  walletFor(owner: string): StoredWallet | undefined {
    return this.read().wallets.find((w) => w.owner === owner);
  }

  putOnrampSession(s: StoredOnrampSession): StoredOnrampSession {
    this.mutate((d) => {
      const i = d.onrampSessions.findIndex((x) => x.id === s.id);
      if (i >= 0) d.onrampSessions[i] = s;
      else d.onrampSessions.push(s);
    });
    return s;
  }
  onrampSession(id: string): StoredOnrampSession | undefined {
    return this.read().onrampSessions.find((s) => s.id === id);
  }

  putVirtualAccount(v: StoredVirtualAccount): StoredVirtualAccount {
    this.mutate((d) => {
      const i = d.virtualAccounts.findIndex((x) => x.id === v.id);
      if (i >= 0) d.virtualAccounts[i] = v;
      else d.virtualAccounts.push(v);
    });
    return v;
  }
  virtualAccount(id: string): StoredVirtualAccount | undefined {
    return this.read().virtualAccounts.find((v) => v.id === id);
  }
  virtualAccountFor(owner: string): StoredVirtualAccount | undefined {
    return this.read().virtualAccounts.find((v) => v.owner === owner);
  }

  putBankTransfer(t: StoredBankTransfer): StoredBankTransfer {
    this.mutate((d) => {
      const i = d.bankTransfers.findIndex((x) => x.id === t.id);
      if (i >= 0) d.bankTransfers[i] = t;
      else d.bankTransfers.push(t);
    });
    return t;
  }
  bankTransfer(id: string): StoredBankTransfer | undefined {
    return this.read().bankTransfers.find((t) => t.id === id);
  }

  putKycSession(k: StoredKycSession): StoredKycSession {
    this.mutate((d) => {
      const i = d.kycSessions.findIndex((x) => x.id === k.id);
      if (i >= 0) d.kycSessions[i] = k;
      else d.kycSessions.push(k);
    });
    return k;
  }
  kycSession(id: string): StoredKycSession | undefined {
    return this.read().kycSessions.find((k) => k.id === id);
  }

  putPayout(p: StoredPayout): StoredPayout {
    this.mutate((d) => {
      const i = d.payouts.findIndex((x) => x.id === p.id);
      if (i >= 0) d.payouts[i] = p;
      else d.payouts.push(p);
    });
    return p;
  }
  payout(id: string): StoredPayout | undefined {
    return this.read().payouts.find((p) => p.id === id);
  }

  all(): FileShape {
    return this.read();
  }
}
