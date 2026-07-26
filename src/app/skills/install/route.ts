/**
 * `GET /skills/install` — a shell script that writes every skill to disk.
 *
 * The one-URL answer to "how do I give my agent these skills". It fetches each
 * skill file from this same deployment and writes it where an agent looks for
 * skills, and it does nothing else: no package manager, no registry, no compiler,
 * no daemon.
 *
 * **The script says to read it before running it, and means it.** Piping a URL
 * into a shell is a bad habit and this endpoint is not going to pretend otherwise.
 * It is deliberately short enough to read in full, it only ever writes files under
 * one directory, and it never asks for a secret — the agent key is not involved in
 * installing anything.
 *
 * The origin is baked in at render time from the request, so the script fetches
 * from the host you got it from rather than from a constant that is wrong
 * everywhere else. Static segment, so it wins over `[slug]` — `install` is not a
 * skill name.
 */
import { SKILLS } from "@/core/skills/catalogue";
import { skillFileName } from "@/core/skills/skillFile";
import { baseUrl } from "@/lib/baseUrl";

export const dynamic = "force-dynamic";

export function GET() {
  const base = baseUrl();
  const slugs = SKILLS.map((s) => s.slug).join(" ");

  const script = `#!/bin/sh
# Votive skills installer — from ${base}
#
# Writes each skill to <dir>/votive-<name>/SKILL.md. Nothing else: no package is
# installed, no registry is contacted, no secret is read or written. Point your
# agent at the directory afterwards.
#
# Read this before you run it. Piping a URL into a shell is a bad habit even when
# the script is harmless, and you cannot tell that it is harmless without looking.
#
#   Install into the current project:   sh install.sh
#   Install for every project:          VOTIVE_SKILLS_DIR="$HOME/.claude/skills" sh install.sh
set -eu

BASE="${base}"
DEST="\${VOTIVE_SKILLS_DIR:-.claude/skills}"
SLUGS="${slugs}"

if ! command -v curl >/dev/null 2>&1; then
  echo "This needs curl. Install it, or fetch \$BASE/skills and save the files by hand." >&2
  exit 1
fi

echo "Installing Votive skills from \$BASE into \$DEST"

for slug in \$SLUGS; do
  dir="\$DEST/votive-\$slug"
  mkdir -p "\$dir"
  # -f so a 404 is a failure rather than a file containing an error page, which
  # would sit there looking like a skill and instruct an agent in nonsense.
  if curl -fsSL "\$BASE/skills/\$slug" -o "\$dir/SKILL.md"; then
    echo "  ok   \$dir/SKILL.md"
  else
    echo "  FAIL \$slug — could not fetch \$BASE/skills/\$slug" >&2
    exit 1
  fi
done

cat <<EOF

Done. \$(echo \$SLUGS | wc -w | tr -d ' ') skills written under \$DEST.

To submit anything — a solved wish, a request for a resource — your agent needs a
secret key, which it cannot mint for itself. Get one at:

  \$BASE/agents/register

Then give it to the agent as VOTIVE_AGENT_KEY and start at
\$DEST/votive-submissions/SKILL.md
EOF
`;

  return new Response(script, {
    headers: {
      // text/plain, not x-shellscript: a browser should display this, because
      // anybody about to run it ought to be able to read it first.
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=60, must-revalidate",
      "access-control-allow-origin": "*",
    },
  });
}
