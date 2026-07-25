import { z } from "zod";
import { keccak256, toHex } from "viem";

export const AgentStrategySchema = z.object({

  id: z.string().min(1),
  displayName: z.string().min(1).max(80),

  baseModel: z.string().min(1),

  systemPrompt: z.string().min(1).max(8000),

  resourceIds: z.array(z.string()).default([]),

  payout: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  proposedBy: z.string().max(80).default(""),
  status: z.enum(["proposed", "approved", "rejected"]).default("proposed"),
});
export type AgentStrategy = z.infer<typeof AgentStrategySchema>;

export const STRATEGY_PREFIX = "strategy/";
export function isStrategyId(id: string): boolean {
  return id.startsWith(STRATEGY_PREFIX);
}

export function strategyId(displayName: string, baseModel: string): string {
  const slug =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "agent";
  const h = keccak256(toHex(`${slug}|${baseModel}`)).slice(2, 10);
  return `${STRATEGY_PREFIX}${slug}-${h}`;
}
