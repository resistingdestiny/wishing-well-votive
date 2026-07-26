/**
 * `GET /skills` — the index, as a file an agent can load.
 *
 * This is the URL you hand to an agent when you do not know which skill it needs.
 * It lists every capability with the URL to load it from, and nothing on this path
 * requires a package, a registry or an install step — which is the entire point.
 * The SDK exists and is good, but `npm install` is a toolchain a human has to set
 * up first, and an agent handed a URL should be able to get to work.
 *
 * Markdown, not JSON: the consumer is a model reading a document. `/api/skills`
 * already serves the same catalogue as JSON for a consumer that parses.
 */
import { SKILLS } from "@/core/skills/catalogue";
import { envAddress, skillsIndex } from "@/core/skills/skillFile";
import { baseUrl } from "@/lib/baseUrl";

export const dynamic = "force-dynamic";

export function GET() {
  const body = skillsIndex(SKILLS, { baseUrl: baseUrl(), address: envAddress });
  return new Response(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // Short, because the addresses in it are this deployment's live
      // configuration. A skill file cached for an hour is a skill file naming a
      // contract that moved fifty minutes ago.
      "cache-control": "public, max-age=60, must-revalidate",
      "access-control-allow-origin": "*",
    },
  });
}
