/**
 * `GET /skills/<slug>` — one skill, as the file an agent loads.
 *
 * Served from the catalogue rather than from a checked-in copy, so a skill file
 * cannot describe a capability this deployment does not have: the addresses are
 * resolved from this deployment's own environment when you fetch it, and an unset
 * one says so in as many words.
 *
 * A 404 here names the slugs that do exist. An agent that guessed wrong should get
 * the list rather than a bare status code it has to go and ask a human about.
 */
import { SKILLS, skillBySlug } from "@/core/skills/catalogue";
import { AGENT_GUIDES } from "@/core/skills/agentGuides";
import { envAddress, skillFile, type SkillFileContext } from "@/core/skills/skillFile";
import { baseUrl } from "@/lib/baseUrl";

export const dynamic = "force-dynamic";

const HEADERS = {
  "content-type": "text/markdown; charset=utf-8",
  "cache-control": "public, max-age=60, must-revalidate",
  "access-control-allow-origin": "*",
} as const;

export function GET(_req: Request, { params }: { params: { slug: string } }) {
  const spec = skillBySlug(params.slug);
  const base = baseUrl();

  if (!spec) {
    return new Response(
      `No skill called "${params.slug}" on this deployment.\n\n` +
        `These exist:\n${SKILLS.map((s) => `  ${base}/skills/${s.slug}`).join("\n")}\n\n` +
        `The index is at ${base}/skills\n`,
      { status: 404, headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const ctx: SkillFileContext = { baseUrl: base, address: envAddress };
  const guide = AGENT_GUIDES[spec.slug]?.(ctx);

  return new Response(skillFile(spec, ctx, guide), { headers: HEADERS });
}
