import { graphQuery } from "./graph";

export interface HumanBackedAgent {

  address: string;

  humanId: string;

  assurance: string;

  assuranceLabel: string;

  walletCount: number;

  attestedAt: number;

  evidenceHash: string | null;
}

export interface AssuranceTierMeta {

  key: "orb" | "selfie" | "device" | "unknown";

  name: string;

  note: string;
}

export function assuranceTierMeta(label: string | null | undefined): AssuranceTierMeta {
  const k = (label ?? "").toLowerCase();
  if (k.includes("orb")) {
    return { key: "orb", name: "Orb", note: "Orb (Proof of Humanity)" };
  }
  if (k.includes("selfie")) {
    return { key: "selfie", name: "Selfie", note: "Selfie Check" };
  }
  if (k.includes("device")) {
    return { key: "device", name: "Device", note: "Device" };
  }
  return { key: "unknown", name: label?.trim() || "Unverified", note: "Unverified tier" };
}

export async function humanBackedAgents(limit = 200): Promise<HumanBackedAgent[]> {
  const data = await graphQuery<{
    agentWallets?: {
      id: string;
      humanId: string;
      assurance: string;
      assuranceLabel: string;
      revoked: boolean;
      attestedAt: string;
      evidenceHash: string | null;
      human: { id: string; walletCount: string } | null;
    }[];
  }>(
    `query HumanBackedAgents($limit: Int!) {
      agentWallets(
        where: { revoked: false }
        orderBy: attestedAt
        orderDirection: desc
        first: $limit
      ) {
        id
        humanId
        assurance
        assuranceLabel
        revoked
        attestedAt
        evidenceHash
        human { id walletCount }
      }
    }`,
    { limit },
  );
  if (!data?.agentWallets) return [];
  try {
    return data.agentWallets
      .filter((w) => !w.revoked)
      .map((w) => ({
        address: w.id,
        humanId: w.humanId,
        assurance: w.assurance,
        assuranceLabel: w.assuranceLabel,
        walletCount: Number(w.human?.walletCount ?? 1),
        attestedAt: Number(w.attestedAt),
        evidenceHash: w.evidenceHash ?? null,
      }));
  } catch {
    return [];
  }
}
