/**
 * The catalogue as JSON, for an agent that wants to discover what it can do.
 *
 * Same source as the page, so the two cannot disagree. Two things are
 * deliberately different from the HTML:
 *
 *   - Contract addresses are resolved here rather than named by environment
 *     variable, because a machine cannot look them up and a variable name is not
 *     an answer. Unset means `null`, never an empty string that parses as an
 *     address.
 *   - `readiness` may be absent. If the probes throw, the response says so in
 *     `degraded` and omits the field rather than shipping an empty array, which a
 *     client would read as "this deployment has nothing".
 */
import { NextResponse } from "next/server";
import { SKILLS, TOOLBELT } from "@/core/skills/catalogue";
import { resourceIdOf } from "@/core/skills/resourceId";
import { skillState } from "@/core/skills/readiness";
import type { Probe } from "@/core/skills/readiness";
import { skillReadiness, toolbeltStatus } from "@/lib/skillReadiness";

export const dynamic = "force-dynamic";

const address = (env: string): string | null => {
  const v = process.env[env];
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null;
};

export async function GET() {
  let probes: Probe[] | null = null;
  let degraded: string | null = null;
  try {
    probes = await skillReadiness();
  } catch (e) {
    degraded = (e as Error).message;
  }

  let toolbelt: unknown[] | null = null;
  try {
    const rows = await toolbeltStatus();
    toolbelt = rows.map((row) => ({
      slug: row.item.slug,
      title: row.item.title,
      summary: row.item.summary,
      kind: row.item.kind,
      releases: row.item.releases,
      resourceId: row.resourceId,
      state: row.state,
      detail: row.detail,
      onchain: row.onchain ?? null,
    }));
  } catch (e) {
    degraded = degraded ?? (e as Error).message;
    // The catalogue half is still true even when the chain half is not, so the
    // slugs and their ids are served with the state left off rather than the
    // whole section vanishing.
    toolbelt = TOOLBELT.map((item) => ({
      slug: item.slug,
      title: item.title,
      summary: item.summary,
      kind: item.kind,
      releases: item.releases,
      resourceId: resourceIdOf(item.slug),
      state: "unknown",
      detail: "could not read the resource registry",
      onchain: null,
    }));
  }

  return NextResponse.json({
    skills: SKILLS.map((spec) => ({
      slug: spec.slug,
      title: spec.title,
      summary: spec.summary,
      category: spec.category,
      surface: spec.surface,
      exports: spec.exports,
      tools: spec.tools,
      install: spec.install,
      hosting: spec.hosting,
      caveats: spec.caveats,
      config: spec.config.map((c) => ({
        name: c.name,
        what: c.what,
        where: c.where,
        secret: c.secret,
        required: c.required,
      })),
      contracts: spec.contracts.map((c) => ({
        label: c.label,
        chain: c.chain,
        address: address(c.env),
      })),
      state: probes ? skillState(spec, probes) : "unknown",
    })),
    toolbelt,
    ...(probes ? { readiness: probes } : {}),
    ...(degraded ? { degraded } : {}),
  });
}
