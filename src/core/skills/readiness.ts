/**
 * Three states, and the third is the one that matters.
 *
 * `ready` and `not-configured` are both answers. `unknown` is the absence of one,
 * and it exists because the alternative — folding a failed read into
 * "not configured" — is how a page comes to tell a builder that a contract is not
 * deployed when what actually happened is that an RPC endpoint timed out. This
 * repo has shipped that mistake before, in both directions.
 *
 * Pure on purpose: the probing lives in `src/lib/skillReadiness.ts`, which does
 * the I/O, and this module only decides what a set of probe results means. That
 * split is what lets the derivation be tested without a chain.
 */
import type { SkillSpec } from "./skill";

export type ProbeState = "ready" | "not-configured" | "unknown";

export interface Probe {
  key: string;
  label: string;
  state: ProbeState;
  /** One line. What is true, or what we failed to find out and why. */
  detail: string;
  /**
   * Present when the thing is there but does less than the page implies.
   *
   * Not a fourth state, because it is not one: the Hedera rail is deployed and
   * usable, and its missing standing gate does not make it unavailable. But a
   * green badge beside the sentence "claims are not checked" reads as an
   * endorsement of the sentence, and a page can be perfectly truthful in words
   * and still mislead in colour. So the caveat is carried separately and rendered
   * where the badge is, rather than being folded into either `state` or `detail`.
   */
  caveat?: string;
}

/** The badge class in `globals.css` that matches each state. */
export function probeBadge(state: ProbeState): string {
  if (state === "ready") return "pass";
  if (state === "unknown") return "fail";
  return "waiting";
}

export function probeWord(state: ProbeState): string {
  if (state === "ready") return "ready";
  if (state === "unknown") return "unknown";
  return "not configured";
}

export interface ReadinessSummary {
  ready: number;
  notConfigured: number;
  unknown: number;
  total: number;
}

export function summarise(probes: Probe[]): ReadinessSummary {
  return {
    ready: probes.filter((p) => p.state === "ready").length,
    notConfigured: probes.filter((p) => p.state === "not-configured").length,
    unknown: probes.filter((p) => p.state === "unknown").length,
    total: probes.length,
  };
}

/**
 * What this deployment can currently offer for one skill.
 *
 * A skill with no requirements is `ready` — `hedera_pay` needs nothing of ours,
 * and saying otherwise because our RPC is down would be a claim about Hedera we
 * have no business making.
 *
 * Otherwise `unknown` dominates `not-configured`, which dominates `ready`. A
 * skill that depends on two contracts, one missing and one unreadable, is
 * unknown: we cannot say it is unavailable when we do not know.
 */
export function skillState(spec: SkillSpec, probes: Probe[]): ProbeState {
  const byKey = new Map(probes.map((p) => [p.key, p]));
  const relevant = spec.requires.map((key) => byKey.get(key));

  // A requirement naming a probe that does not exist is a catalogue bug, and it
  // must not read as "ready" — that is the direction that lies.
  if (relevant.some((p) => p === undefined)) return "unknown";
  if (relevant.some((p) => p!.state === "unknown")) return "unknown";
  if (relevant.some((p) => p!.state === "not-configured")) return "not-configured";
  return "ready";
}

/** The sentence under a skill's heading, in the deployment's own terms. */
export function skillStateReason(spec: SkillSpec, probes: Probe[]): string {
  const byKey = new Map(probes.map((p) => [p.key, p]));
  const blocking = spec.requires
    .map((key) => byKey.get(key))
    .filter((p): p is Probe => p !== undefined && p.state !== "ready");

  if (spec.requires.length === 0) {
    return "Needs nothing from this deployment.";
  }
  if (blocking.length === 0) {
    return "Everything this skill needs is live on this deployment.";
  }
  return blocking.map((p) => `${p.label}: ${p.detail}`).join(" ");
}
