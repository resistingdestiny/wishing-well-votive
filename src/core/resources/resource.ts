import { z } from "zod";

export const ResourceKindSchema = z.enum(["tool", "mcp", "data", "credential", "budget"]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

export const ResourceStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type ResourceStatus = z.infer<typeof ResourceStatusSchema>;

export const ResourceSpecSchema = z.object({
  id: z.string().min(1),
  kind: ResourceKindSchema,
  name: z.string().min(1),
  description: z.string().default(""),
  scope: z.enum(["wish", "shared"]),

  ref: z.string().optional(),

  spendCapUsd: z.number().nonnegative().optional(),

  tokenGrant: z.number().int().nonnegative().optional(),

  allowedTools: z.array(z.string()).optional(),

  revoked: z.boolean().default(false),

  provider: z.string().optional(),

  payout: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),

  status: ResourceStatusSchema.optional(),
});
export type ResourceSpec = z.infer<typeof ResourceSpecSchema>;

export function isActive(r: ResourceSpec): boolean {
  return !r.revoked && (r.status === undefined || r.status === "approved");
}

export interface PublicResource {
  id: string;
  kind: ResourceKind;
  name: string;
  description: string;
  scope: "wish" | "shared";
  hasCredential: boolean;
  spendCapUsd?: number;
  tokenGrant?: number;
  allowedTools?: string[];
  revoked: boolean;
  provider?: string;
  payout?: string;
  status?: ResourceStatus;
}

export function toPublic(r: ResourceSpec): PublicResource {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    description: r.description,
    scope: r.scope,
    hasCredential: !!r.ref,
    spendCapUsd: r.spendCapUsd,
    tokenGrant: r.tokenGrant,
    allowedTools: r.allowedTools,
    revoked: r.revoked,
    provider: r.provider,
    payout: r.payout,
    status: r.status,
  };
}

export function grantedTokens(resources: ResourceSpec[]): number {
  return resources.filter(isActive).reduce((s, r) => s + (r.tokenGrant ?? 0), 0);
}

export function grantedUsd(resources: ResourceSpec[]): number {
  return resources.filter(isActive).reduce((s, r) => s + (r.spendCapUsd ?? 0), 0);
}
