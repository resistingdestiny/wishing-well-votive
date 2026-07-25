import fs from "node:fs";
import path from "node:path";
import { keccak256, toHex } from "viem";

export interface AgentProposal {
  id: string;
  displayName: string;

  model: string;

  providerAddress?: string;

  payout: `0x${string}`;
  proposedBy: string;
  proposedAt: string;
  status: "proposed" | "approved" | "rejected";
}

interface ModelsFile {
  comment?: string;
  models: Record<string, unknown>[];
}

function dataDir(): string {
  const dir = process.env.WELL_DATA_DIR;
  if (!dir) throw new Error("WELL_DATA_DIR not configured");
  return dir;
}

function proposalsFile(): string {
  return path.join(dataDir(), "solver-proposals.json");
}

function modelsFile(): string {
  const file = process.env.WELL_MODELS_FILE;
  if (!file) throw new Error("WELL_MODELS_FILE not configured");
  return file;
}

export function readProposals(): AgentProposal[] {
  try {
    return JSON.parse(fs.readFileSync(proposalsFile(), "utf8")) as AgentProposal[];
  } catch {
    return [];
  }
}

function writeProposals(all: AgentProposal[]): void {
  fs.writeFileSync(proposalsFile(), JSON.stringify(all, null, 2));
}

export function addProposal(
  p: Omit<AgentProposal, "id" | "proposedAt" | "status">,
): AgentProposal {
  const all = readProposals();
  const id = keccak256(toHex(`${p.model}|${p.payout}|${Date.now()}`)).slice(0, 18);
  const proposal: AgentProposal = {
    ...p,
    id,
    proposedAt: new Date().toISOString(),
    status: "proposed",
  };
  all.push(proposal);
  writeProposals(all);
  return proposal;
}

export function registryModelId(model: string): string {
  return model.startsWith("openai/") ? model : `openai/${model}`;
}

export function onchainModelId(model: string): `0x${string}` {
  return keccak256(toHex(registryModelId(model)));
}

export function approveProposal(id: string): AgentProposal {
  const all = readProposals();
  const proposal = all.find((p) => p.id === id);
  if (!proposal) throw new Error(`no proposal ${id}`);
  if (proposal.status === "approved") return proposal;

  const file = modelsFile();
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ModelsFile;
  const modelId = registryModelId(proposal.model);
  const existing = parsed.models.find((m) => m.id === modelId);
  const entry = {
    id: modelId,
    provider: "openai",
    displayName: proposal.displayName,
    released: new Date().toISOString().slice(0, 10),
    tier: "mid",
    active: true,
    ...(proposal.providerAddress ? { providerAddress: proposal.providerAddress } : {}),
    solverPayout: proposal.payout,
    proposedBy: proposal.proposedBy,
  };
  if (existing) Object.assign(existing, entry);
  else parsed.models.push(entry);
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2));

  proposal.status = "approved";
  writeProposals(all);
  return proposal;
}

export interface SolverAgentView {
  id: string;
  displayName: string;
  model: string;
  payout?: string;
  proposedBy?: string;
  status: "proposed" | "active";
}

export function listSolverAgents(): SolverAgentView[] {
  const out: SolverAgentView[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsFile(), "utf8")) as ModelsFile;
    for (const m of parsed.models) {
      if (m.provider !== "openai" || m.active !== true) continue;
      out.push({
        id: String(m.id),
        displayName: String(m.displayName ?? m.id),
        model: String(m.id),
        payout: m.solverPayout ? String(m.solverPayout) : undefined,
        proposedBy: m.proposedBy ? String(m.proposedBy) : undefined,
        status: "active",
      });
    }
  } catch {

  }
  for (const p of readProposals()) {
    if (p.status !== "proposed") continue;
    out.push({
      id: p.id,
      displayName: p.displayName,
      model: registryModelId(p.model),
      payout: p.payout,
      proposedBy: p.proposedBy,
      status: "proposed",
    });
  }
  return out;
}

export async function routerServesModel(model: string): Promise<boolean | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: string }[] };
    const name = model.replace(/^openai\//, "");
    return (body.data ?? []).some((m) => m.id === name);
  } catch {
    return null;
  }
}
