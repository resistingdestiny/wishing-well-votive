/**
 * The skills catalogue: everything Votive offers somebody building an agent.
 *
 * Written to be usable rather than admired. A builder should be able to read one
 * card, copy two blocks, and have the thing running — which is why every sample
 * is checked against the built SDK by `npm run check:skills`, and why the strip
 * at the top reads this deployment's real state instead of describing an ideal
 * one.
 *
 * The honest part is the toolbelt section. Three of these resources have a
 * derived, stable `bytes32` id; only the ones the registry actually knows about
 * are shown as registered, and a read that fails says so rather than rendering an
 * empty row that reads like an answer.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";
import { ReadFailure } from "@/app/ui/ReadFailure";
import { StandingGateNotice } from "@/app/ui/StandingGateNotice";
import { SKILLS } from "@/core/skills/catalogue";
import { assuranceLabel } from "@/core/skills/skill";
import { AGENT_CONTRACTS } from "@/lib/chainReads";
import { skillReadiness, toolbeltStatus, type ToolbeltStatus } from "@/lib/skillReadiness";
import { probeBadge, probeWord, type Probe } from "@/core/skills/readiness";
import { CopyBlock } from "./CopyBlock";
import { ReadinessStrip } from "./ReadinessStrip";
import { SkillCard } from "./SkillCard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Skills for agent builders · Votive",
  description:
    "Every capability Votive offers an agent: payments on Hedera, escrowed bounties, the human-backed standing that gates them, and a shared toolbelt of keys, data and databases released only when the community agrees.",
};

const INSTALL = `# @votive/agent-skills is not on npm yet — the registry answers 404.
# Pack it from a checkout; \`prepare\` builds dist/ during install.
git clone <this repo> && cd wishing-well-votive/sdk
npm install && npm pack          # -> votive-agent-skills-0.1.0.tgz

cd ~/my-agent
npm install /path/to/votive-agent-skills-0.1.0.tgz

# Optional peers, both imported lazily:
npm install @hashgraph/sdk @worldcoin/agentkit-core`;

const FIRST_AGENT = `import {createHederaRail, createVotiveAgent} from '@votive/agent-skills';

const rail = await createHederaRail({
  accountId: process.env.HEDERA_ACCOUNT_ID!,
  privateKey: process.env.HEDERA_PRIVATE_KEY!,
  network: 'testnet',
});

const agent = createVotiveAgent({rail});

// Plain JSON Schema. Hand it to any tool-calling API unchanged.
const tools = agent.tools();

// A tool the agent cannot perform is not offered, rather than offered and
// guaranteed to fail. Give it a \`standing\` and \`resources\` and four more appear.
console.log(tools.map((t) => t.name));`;

function ToolbeltCard({ status }: { status: ToolbeltStatus }) {
  const { item } = status;
  return (
    <article
      className="panel"
      data-reveal
      data-testid={`toolbelt-item-${item.slug}`}
      data-state={status.state}
    >
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: "0.8rem" }}>
        <h3 style={{ margin: 0 }}>{item.title}</h3>
        <span className={`badge ${probeBadge(status.state)}`}>
          {status.state === "ready"
            ? "registered"
            : status.state === "not-configured"
              ? "not registered"
              : probeWord(status.state)}
        </span>
      </div>

      <p style={{ maxWidth: "70ch", marginTop: "0.4rem" }}>{item.summary}</p>

      <dl className="stack" style={{ gap: "0.5rem", margin: "0.6rem 0" }}>
        <div>
          <dt className="muted" style={{ fontSize: "0.75rem" }}>
            What the provider hands over
          </dt>
          <dd style={{ margin: 0, fontSize: "0.88rem" }}>{item.releases}</dd>
        </div>
        <div>
          <dt className="muted" style={{ fontSize: "0.75rem" }}>
            What a request has to argue
          </dt>
          <dd style={{ margin: 0, fontSize: "0.88rem" }}>{item.why}</dd>
        </div>
      </dl>

      <div className="tableWrap">
        <table>
          <tbody>
            <tr>
              <td style={{ whiteSpace: "nowrap" }}>Resource id</td>
              <td className="mono" style={{ fontSize: "0.72rem", wordBreak: "break-all" }}>
                {status.resourceId}
              </td>
            </tr>
            <tr>
              <td style={{ whiteSpace: "nowrap" }}>Derived from</td>
              <td className="mono" style={{ fontSize: "0.75rem" }}>
                keccak256(&quot;resource:{item.slug}&quot;)
              </td>
            </tr>
            <tr>
              <td style={{ whiteSpace: "nowrap" }}>On chain</td>
              <td className="muted" style={{ fontSize: "0.82rem" }}>
                {status.detail}
              </td>
            </tr>
            {status.onchain ? null : (
              <tr>
                <td style={{ whiteSpace: "nowrap" }}>Intended terms</td>
                <td className="muted" style={{ fontSize: "0.82rem" }}>
                  {item.intendedBaseLimit} uses per epoch at parity standing, minimum
                  assurance {assuranceLabel(item.intendedMinAssurance)} &mdash; an
                  intent, not a reading.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </article>
  );
}

export default async function SkillsPage() {
  let probes: Probe[] = [];
  let probeError = "";
  try {
    probes = await skillReadiness();
  } catch (e) {
    probeError = (e as Error).message;
  }

  let toolbelt: ToolbeltStatus[] = [];
  let toolbeltError = "";
  try {
    toolbelt = await toolbeltStatus();
  } catch (e) {
    toolbeltError = (e as Error).message;
  }

  const groups = [
    { key: "payment", label: "Payments" },
    { key: "protocol", label: "Doing the work" },
    { key: "identity", label: "Who you are" },
    { key: "toolbelt", label: "The shared toolbelt" },
  ] as const;

  return (
    <main>
      <SectionNav section="build" />
      <PageHead
        title="Skills for agent builders"
        description="Everything an agent can do here, with the code to wire it in. Payments that need no server, escrowed bounties that pay on attestation, the human-backed standing that gates both, and a toolbelt of keys, data and databases that opens only when the community lets it."
      />

      <p className="muted" style={{ maxWidth: "76ch" }}>
        Each skill below is an import or an endpoint, not a diagram.{" "}
        <span className="mono">npm run check:skills</span> resolves every symbol on
        this page against the built SDK and every tool name against what{" "}
        <span className="mono">createVotiveAgent</span> actually offers, so a sample
        here cannot outrun the code. What it cannot check is whether{" "}
        <em>this</em> deployment has the contracts &mdash; that is what the strip
        below reads live.
      </p>

      {probeError ? (
        <ReadFailure
          what="this deployment's capabilities"
          because={probeError}
          testId="readiness-failure"
        />
      ) : (
        <ReadinessStrip probes={probes} />
      )}

      <h2>Start here</h2>
      <div className="stack">
        <CopyBlock title="Install" language="bash" code={INSTALL} testId="install-block" />
        <CopyBlock
          title="Your first agent"
          language="ts"
          code={FIRST_AGENT}
          note="Two of the eight tools need only a rail. The other six appear as you give the agent a bounty client, a standing view, and a resource commons — each of which is one constructor, all of them exported from the package root."
          testId="first-agent-block"
        />
      </div>

      <h2 id="claiming">Claiming work, and what the chain checks</h2>
      <div className="panel" data-reveal>
        <p style={{ marginTop: 0, maxWidth: "74ch" }}>
          A bounty is escrowed by a funder, claimed exclusively by one agent, and
          released against an attestation. The claim is the part that matters for
          identity: on a rail deployed with a standing adapter it reverts unless a
          verified human backs the wallet. Not every deployed rail was, so the page
          asks each one rather than telling you.
        </p>
        <div className="stack" style={{ gap: "0.5rem" }}>
          <div>
            <strong style={{ fontSize: "0.85rem" }}>Base Sepolia</strong>
            <StandingGateNotice
              rail={AGENT_CONTRACTS.baseRail ?? ""}
              chain="base-sepolia"
              testId="standing-gate-base"
            />
          </div>
          <div>
            <strong style={{ fontSize: "0.85rem" }}>Hedera testnet</strong>
            <StandingGateNotice
              rail={AGENT_CONTRACTS.hederaRail ?? ""}
              chain="hedera-testnet"
              testId="standing-gate-hedera"
            />
          </div>
        </div>
      </div>

      {groups.map((group) => {
        const specs = SKILLS.filter((s) => s.category === group.key);
        if (specs.length === 0) return null;
        return (
          <section key={group.key}>
            <h2 id={`group-${group.key}`}>{group.label}</h2>
            <div className="stack">
              {specs.map((spec) => (
                <SkillCard key={spec.slug} spec={spec} probes={probes} />
              ))}
            </div>
          </section>
        );
      })}

      <h2 id="toolbelt">The toolbelt, and who opens it</h2>
      <div className="panel" data-reveal>
        <p style={{ marginTop: 0, maxWidth: "76ch" }}>
          <strong>Two gates, and they are not the same one.</strong>{" "}
          <span className="mono">ResourceRegistry</span> decides entitlement on
          chain: human-backed, not barred, assurance tier high enough, quota left
          this epoch. We cannot widen a quota, lower a minimum tier, beat a bar or
          extend a grant&rsquo;s one-hour life &mdash; the registry re-derives all
          of it from the same contracts that hold the bar.
        </p>
        <p className="muted" style={{ maxWidth: "76ch" }}>
          A <Link href="/agents/resource-requests">resource request</Link> is the
          second gate. An agent argues why it can solve a wish and why it needs a
          particular key, dataset or database; anyone human-backed can object; and
          an item nobody rejects is approved when the window runs out. That approval
          is a condition the <em>provider</em> applies before releasing a
          credential. It is never a substitute for the registry&rsquo;s answer, and
          on its own it moves nothing.
        </p>
        <p className="muted" style={{ maxWidth: "76ch", marginBottom: 0 }}>
          The credential never touches the chain. What is public is the entitlement
          and an auditable record of every grant; what stays private is the secret,
          released off chain by the provider after it has re-checked the grant.
        </p>
      </div>

      {toolbeltError ? (
        <ReadFailure
          what="the toolbelt's on-chain state"
          because={toolbeltError}
          testId="toolbelt-failure"
        />
      ) : (
        <div className="stack" data-testid="toolbelt-catalogue">
          {toolbelt.map((status) => (
            <ToolbeltCard key={status.item.slug} status={status} />
          ))}
        </div>
      )}

      <p className="muted" style={{ marginTop: "1.5rem", maxWidth: "76ch" }}>
        Resource ids are derived, not allocated:{" "}
        <span className="mono">keccak256(&quot;resource:&quot; + slug)</span>, the
        same derivation the registration script uses, so an id printed here is the
        id the registry will key on whether or not it has been registered yet. The
        older curator-reviewed catalogue still lives at{" "}
        <Link href="/toolbelt">the toolbelt</Link>; it has no identity, no quota and
        no chain behind it, and nothing above reads from it.
      </p>
    </main>
  );
}
