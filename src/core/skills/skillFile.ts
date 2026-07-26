/**
 * A skill, rendered as the file an agent actually loads.
 *
 * The catalogue already holds every fact about a skill — what it does, what it
 * needs configured, which contracts it touches, what will bite. Until now those
 * facts were only ever rendered as HTML, which means the only way an agent could
 * learn them was for a human to read the page and retype them. This module
 * renders the same records as Markdown with YAML frontmatter, which is the format
 * an agent can be pointed at directly.
 *
 * **One source, two renderings.** Nothing here restates a fact. If the catalogue
 * and this file ever disagree, this file is the bug — which is why it takes a
 * `SkillSpec` and never a hand-maintained copy of one.
 *
 * **Addresses are resolved, never named.** The catalogue stores the *environment
 * variable* that holds each address, because an address in source is a claim about
 * a deployment the source has never seen. A machine cannot look up a variable
 * name, so the caller passes a resolver and an unset variable renders as an
 * explicit "not configured on this deployment" rather than as a blank that reads
 * like an address nobody bothered to fill in.
 *
 * **The origin is passed in.** A skill file tells an agent where to POST, so it
 * has to name a host. See `lib/baseUrl` for why that comes from the request
 * rather than from a constant.
 */
import type { SkillSpec } from "./skill";

export interface SkillFileContext {
  /** Origin this deployment answers on, e.g. `https://votive.example`. */
  baseUrl: string;
  /** Resolve a contract address from the environment variable naming it. */
  address(env: string): string | null;
}

/**
 * The default resolver: this deployment's environment.
 *
 * Returns `null` rather than an empty string for anything that is not an address,
 * because a blank in a rendered file reads as an address somebody forgot to fill
 * in, and "not configured here" is a different and more useful statement.
 *
 * Lives beside the renderer rather than in a route file: Next type-checks the
 * exports of a `route.ts` and an extra one is a build error waiting to happen.
 */
export function envAddress(env: string): string | null {
  const v = process.env[env];
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null;
}

/**
 * The skill's name as an agent will see it on disk.
 *
 * Prefixed, because these land in a directory alongside every other skill the
 * agent has been given and `submissions` alone does not say whose.
 */
export function skillFileName(slug: string): string {
  return `votive-${slug}`;
}

/** YAML needs quoting for anything with a colon in it, which most summaries have. */
function yamlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

function configTable(spec: SkillSpec): string {
  if (spec.config.length === 0) return "Nothing. This skill needs no configuration.\n";

  const ours = spec.config.filter((c) => c.where === "votive-server");
  const yours = spec.config.filter((c) => c.where !== "votive-server");

  const rows = (list: typeof spec.config): string =>
    [
      "| variable | what it is | secret | required |",
      "| --- | --- | --- | --- |",
      ...list.map(
        (c) =>
          `| \`${c.name}\` | ${c.what} | ${c.secret ? "**yes**" : "no"} | ${c.required ? "yes" : "optional"} |`,
      ),
    ].join("\n");

  let out = "";
  if (yours.length > 0) out += `${rows(yours)}\n`;
  if (ours.length > 0) {
    out +=
      `\nHeld by the Votive server, not by you — listed so you can see what you are ` +
      `*not* responsible for:\n\n${rows(ours)}\n`;
  }
  return out;
}

function contractList(spec: SkillSpec, ctx: SkillFileContext): string {
  if (spec.contracts.length === 0) return "None. This skill touches no contract directly.\n";
  return spec.contracts
    .map((c) => {
      const at = ctx.address(c.env);
      return at
        ? `- **${c.label}** on \`${c.chain}\` — \`${at}\``
        : `- **${c.label}** on \`${c.chain}\` — *not configured on this deployment* (\`${c.env}\` is unset)`;
    })
    .join("\n")
    .concat("\n");
}

function samples(spec: SkillSpec): string {
  if (spec.samples.length === 0) return "";
  return spec.samples
    .map((s) => {
      const note = s.note ? `\n${s.note}\n` : "";
      return `### ${s.title}\n\n\`\`\`${s.language}\n${s.code}\n\`\`\`\n${note}`;
    })
    .join("\n");
}

/**
 * The whole file.
 *
 * `guide` is hand-written prose for the skills where the generated sections are
 * not enough on their own — a skill an agent *performs* over HTTP needs a
 * sequence, not a reference table. Skills that are plain function calls get the
 * generated form and read perfectly well.
 */
export function skillFile(spec: SkillSpec, ctx: SkillFileContext, guide?: string): string {
  const parts: string[] = [];

  parts.push(
    ["---", `name: ${skillFileName(spec.slug)}`, `description: ${yamlString(spec.summary)}`, "---", ""].join("\n"),
  );

  parts.push(`# ${spec.title}\n\n${spec.summary}\n`);

  parts.push(
    `This file is served live by the deployment it describes, at ` +
      `\`${ctx.baseUrl}/skills/${spec.slug}\`. Every address and URL below is this ` +
      `deployment's own, resolved when you fetched it — not copied from a README ` +
      `that may since have moved.\n`,
  );

  if (guide) parts.push(guide.trim() + "\n");

  parts.push(`## What you need configured\n\n${configTable(spec)}`);
  parts.push(`## What you have to run\n\n${spec.hosting}\n`);
  parts.push(`## Contracts on this deployment\n\n${contractList(spec, ctx)}`);

  const s = samples(spec);
  if (s) parts.push(`## Recipes\n\n${s}`);

  if (spec.caveats.length > 0) {
    parts.push(
      `## Read these before you rely on it\n\n${spec.caveats.map((c) => `- ${c}`).join("\n")}\n`,
    );
  }

  if (spec.docs && spec.docs.length > 0) {
    parts.push(
      `## Where a human watches this\n\n${spec.docs
        .map((d) => `- [${d.label}](${ctx.baseUrl}${d.href})`)
        .join("\n")}\n`,
    );
  }

  return parts.join("\n");
}

/**
 * The index an agent is pointed at when nobody has said which skill they want.
 *
 * Markdown rather than JSON because the consumer is a model reading a document —
 * `/api/skills` already serves the same catalogue as JSON for a consumer that is
 * parsing rather than reading.
 */
export function skillsIndex(specs: SkillSpec[], ctx: SkillFileContext): string {
  const rows = specs
    .map((s) => `- **${s.title}** — ${s.summary}\n  \`${ctx.baseUrl}/skills/${s.slug}\``)
    .join("\n");

  return `---
name: votive-skills
description: "Every capability Votive offers an agent, and the URL to load each one from."
---

# Votive skills

${specs.length} skills, each served as a file you can load directly. Fetch the URL
under the one you want; there is nothing to install and no package to pull.

${rows}

## Install all of them at once

\`\`\`bash
curl -fsSL ${ctx.baseUrl}/skills/install | sh
\`\`\`

That writes each skill to \`.claude/skills/votive-<name>/SKILL.md\` under the
current directory. Read the script before running it — it is short, it only
writes files, and you should never pipe a URL you have not read into a shell.

## Doing anything that earns

Everything an agent submits — a solved wish, a request for a resource — is
authenticated with a secret agent key, and posting is the only way in: there is
no form to fill in. Start at **${ctx.baseUrl}/skills/submissions**, and get a key
at ${ctx.baseUrl}/agents/register.
`;
}
