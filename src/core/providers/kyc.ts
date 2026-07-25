import { keccak256, toHex } from "viem";
import { type ProviderResult, type NamedProvider, ok, err } from "./types.js";
import { ProviderStore, type StoredKycSession } from "./store.js";

export type KycStatus = "pending" | "approved" | "rejected" | "manual-review";

export interface KycSession {
  id: string;
  subject: string;
  status: KycStatus;
  sanctioned: boolean;
  provider: string;
  url: string;

  descriptorHash?: string;
}

export interface KycProvider extends NamedProvider {
  createSession(args: { subject: string; descriptorHash?: string }): Promise<ProviderResult<{ session: KycSession }>>;

  resolveSession(id: string): Promise<ProviderResult<{ session: KycSession }>>;
  getSession(id: string): Promise<KycSession | undefined>;

  screenSanctions(subject: string): Promise<boolean>;
}

const SANCTIONS_LIST = ["dprk", "wagner", "ofac-test", "blocked-person"];

function nowIso(): string {
  return new Date().toISOString();
}
function toStored(s: KycSession): StoredKycSession {
  return {
    id: s.id,
    subject: s.subject,
    status: s.status,
    sanctioned: s.sanctioned,
    provider: s.provider,
    createdAt: nowIso(),
    descriptorHash: s.descriptorHash,
  };
}
function fromStored(s: StoredKycSession): KycSession {
  return {
    id: s.id,
    subject: s.subject,
    status: s.status,
    sanctioned: s.sanctioned,
    provider: s.provider,
    url: `mock://kyc/session/${s.id}`,
    descriptorHash: s.descriptorHash,
  };
}

export class MockKycProvider implements KycProvider {
  readonly kind = "kyc";
  readonly provider = "mock";
  constructor(private readonly store: ProviderStore) {}

  async screenSanctions(subject: string): Promise<boolean> {
    const s = subject.toLowerCase();
    return SANCTIONS_LIST.some((name) => s.includes(name)) || s.includes("sanctioned");
  }

  async createSession(args: {
    subject: string;
    descriptorHash?: string;
  }): Promise<ProviderResult<{ session: KycSession }>> {
    if (!args.subject.trim()) return err("bad_request", "subject is required");
    const id = `kyc_${keccak256(toHex(`${args.subject}:${args.descriptorHash ?? ""}:${nowIso()}`)).slice(2, 18)}`;
    const session: KycSession = {
      id,
      subject: args.subject,
      status: "pending",
      sanctioned: false,
      provider: this.provider,
      url: `mock://kyc/session/${id}`,
      descriptorHash: args.descriptorHash,
    };
    this.store.putKycSession(toStored(session));
    return ok({ session });
  }

  async resolveSession(id: string): Promise<ProviderResult<{ session: KycSession }>> {
    const stored = this.store.kycSession(id);
    if (!stored) return err("not_found", `no kyc session ${id}`, false);
    const session = fromStored(stored);
    if (session.status !== "pending") return ok({ session });

    const s = session.subject.toLowerCase();
    if (await this.screenSanctions(session.subject)) {
      session.status = "rejected";
      session.sanctioned = true;
    } else if (s.includes("fail")) {
      session.status = "rejected";
    } else if (s.includes("review")) {
      session.status = "manual-review";
    } else {
      session.status = "approved";
    }
    this.store.putKycSession(toStored(session));
    if (session.status === "rejected") {
      return err(session.sanctioned ? "sanctioned" : "kyc_failed", `KYC ${session.status} for ${session.subject}`);
    }
    return ok({ session });
  }

  async getSession(id: string): Promise<KycSession | undefined> {
    const s = this.store.kycSession(id);
    return s ? fromStored(s) : undefined;
  }
}
