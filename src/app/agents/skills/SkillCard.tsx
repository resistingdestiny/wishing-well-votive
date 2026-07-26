/**
 * One capability, as much of it as a builder needs to start.
 *
 * The order is the order the questions get asked: what is it, will it work here,
 * what do I install, what do I have to hold, what do I have to run, what does it
 * touch on chain, what does the code look like, and what is going to annoy me
 * later. The last one is why `caveats` is a required field rather than an
 * optional one — a limitation a builder finds at 2am is worth less than the same
 * limitation on the page.
 *
 * Contract addresses are resolved from the environment here, at render time.
 * Nothing in `catalogue.ts` writes an address down, because a file cannot know
 * which deployment it is being read on and an address in source reads as a
 * promise.
 */
import Link from "next/link";
import { explorerAddress } from "@/lib/txLog";
import { probeBadge, probeWord, skillState, skillStateReason, type Probe } from "@/core/skills/readiness";
import type { SkillSpec } from "@/core/skills/skill";
import { CopyBlock } from "./CopyBlock";

const SURFACE_WORD: Record<string, string> = {
  sdk: "npm package",
  http: "HTTP endpoint",
  chain: "on chain",
};

function ContractRow({ label, env, chain }: { label: string; env: string; chain: "base-sepolia" | "hedera-testnet" }) {
  const address = process.env[env];
  const deployed = typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address);

  return (
    <tr>
      <td style={{ whiteSpace: "nowrap" }}>{label}</td>
      <td className="muted" style={{ fontSize: "0.8rem", whiteSpace: "nowrap" }}>
        {chain === "hedera-testnet" ? "Hedera testnet" : "Base Sepolia"}
      </td>
      <td className="mono" style={{ fontSize: "0.78rem" }}>
        {deployed ? (
          <a href={explorerAddress(chain, address)} rel="noreferrer noopener" target="_blank">
            {address.slice(0, 10)}…{address.slice(-6)}
          </a>
        ) : (
          <span className="muted">
            not set here (<span className="mono">{env}</span>)
          </span>
        )}
      </td>
    </tr>
  );
}

export function SkillCard({ spec, probes }: { spec: SkillSpec; probes: Probe[] }) {
  const state = skillState(spec, probes);
  const reason = skillStateReason(spec, probes);
  const installLine =
    spec.install.length > 0 ? `npm install ${spec.install.join(" ")}` : null;

  return (
    <article className="panel" data-reveal data-testid={`skill-${spec.slug}`} data-state={state} id={spec.slug}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: "0.8rem" }}>
        <h3 style={{ margin: 0 }}>{spec.title}</h3>
        <span className={`badge ${probeBadge(state)}`}>{probeWord(state)}</span>
      </div>

      <p style={{ maxWidth: "72ch", marginTop: "0.4rem" }}>{spec.summary}</p>

      <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
        {spec.surface.map((s) => (
          <span key={s} className="badge">
            {SURFACE_WORD[s] ?? s}
          </span>
        ))}
        {spec.tools.map((tool) => (
          <span key={tool} className="badge mono" style={{ fontSize: "0.72rem" }}>
            {tool}
          </span>
        ))}
      </div>

      <p className="muted" style={{ fontSize: "0.82rem", maxWidth: "72ch" }}>
        {reason}
      </p>

      {installLine ? (
        <CopyBlock
          title="Install"
          language="bash"
          code={installLine}
          testId={`skill-install-${spec.slug}`}
        />
      ) : null}

      <h4 style={{ marginBottom: "0.35rem" }}>What you hold</h4>
      {spec.config.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          Nothing. This skill needs no configuration and no credential.
        </p>
      ) : (
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>What it is</th>
                <th>Where</th>
              </tr>
            </thead>
            <tbody>
              {spec.config.map((key) => (
                <tr key={key.name}>
                  <td className="mono" style={{ fontSize: "0.78rem", whiteSpace: "nowrap" }}>
                    {key.name}
                    {key.secret ? (
                      <span className="badge fail" style={{ marginLeft: "0.4rem" }}>
                        secret
                      </span>
                    ) : null}
                  </td>
                  <td className="muted" style={{ fontSize: "0.82rem" }}>
                    {key.what}
                    {key.required ? "" : " (optional)"}
                  </td>
                  <td className="muted" style={{ fontSize: "0.8rem", whiteSpace: "nowrap" }}>
                    {key.where === "votive-server"
                      ? "ours, not yours"
                      : key.where === "browser"
                        ? "browser"
                        : "your host"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4 style={{ marginBottom: "0.35rem" }}>What you host</h4>
      <p className="muted" style={{ margin: 0, maxWidth: "72ch", fontSize: "0.85rem" }}>
        {spec.hosting}
      </p>

      {spec.contracts.length > 0 ? (
        <>
          <h4 style={{ marginBottom: "0.35rem" }}>What it touches</h4>
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Chain</th>
                  <th>Address on this deployment</th>
                </tr>
              </thead>
              <tbody>
                {spec.contracts.map((c) => (
                  <ContractRow key={c.env} label={c.label} env={c.env} chain={c.chain} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {spec.samples.length > 0 ? (
        <>
          <h4 style={{ marginBottom: "0.35rem" }}>Wiring it in</h4>
          <div className="stack">
            {spec.samples.map((sample, i) => (
              <CopyBlock
                key={sample.title}
                title={sample.title}
                language={sample.language}
                code={sample.code}
                note={sample.note}
                testId={`skill-sample-${spec.slug}-${i}`}
              />
            ))}
          </div>
        </>
      ) : null}

      <h4 style={{ marginBottom: "0.35rem" }}>Worth knowing before you start</h4>
      <ul className="muted" style={{ margin: 0, fontSize: "0.85rem", maxWidth: "76ch" }}>
        {spec.caveats.map((caveat) => (
          <li key={caveat} style={{ marginBottom: "0.3rem" }}>
            {caveat}
          </li>
        ))}
      </ul>

      {spec.docs && spec.docs.length > 0 ? (
        <div className="row" style={{ marginTop: "0.9rem", flexWrap: "wrap" }}>
          {spec.docs.map((doc) => (
            <Link key={doc.href} href={doc.href} className="pill">
              {doc.label}
            </Link>
          ))}
        </div>
      ) : null}
    </article>
  );
}
