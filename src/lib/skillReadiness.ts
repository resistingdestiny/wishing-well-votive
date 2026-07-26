/**
 * What this deployment actually has, asked rather than assumed.
 *
 * The skills page makes a lot of claims — that a rail is deployed, that a
 * registry meters a quota, that a key can be issued. Every one of them is checked
 * here against the chain or the environment before it is rendered, and every one
 * of them can come back `unknown`.
 *
 * The distinction this module exists to preserve: **an address that is not set
 * and an address we could not reach are different facts.** Collapsing them gives
 * a builder a page that says "ResourceRegistry is not deployed here" during an
 * RPC outage, which is a confident, checkable, wrong statement about somebody
 * else's contract. Every read goes through `chainReads`, which never swallows a
 * failure into a zero.
 */
import {
  AGENT_CONTRACTS,
  bountyCount,
  resourceEpoch,
  resourceOf,
  standingFor,
  standingGate,
  humanBacking,
  type Read,
} from "@/lib/chainReads";
import type { TxChain } from "@/lib/txLog";
import { agentKeysConfigured } from "@/lib/agentAuth";
import type { Probe, ProbeState } from "@/core/skills/readiness";
import { TOOLBELT } from "@/core/skills/catalogue";
import { resourceIdOf } from "@/core/skills/resourceId";
import { assuranceLabel, type ToolbeltItem } from "@/core/skills/skill";

/** A wallet nobody holds. Reading about it proves the contract answers without
 *  asserting anything about a person. */
const NOBODY = "0x0000000000000000000000000000000000000000";
const NO_HUMAN = `0x${"0".repeat(64)}` as `0x${string}`;

const shortAddress = (a: string): string => `${a.slice(0, 8)}…${a.slice(-4)}`;

/** Turn a `Read<T>` into a probe, so the three states are produced in one place
 *  rather than re-derived by every caller. */
function fromRead<T>(
  key: string,
  label: string,
  read: Read<T>,
  describe: (value: T) => string,
  caveat?: (value: T) => string | undefined,
): Probe {
  if (!read.ok) return { key, label, state: "unknown", detail: read.degraded };
  const note = caveat?.(read.value);
  return {
    key,
    label,
    state: "ready",
    detail: describe(read.value),
    ...(note ? { caveat: note } : {}),
  };
}

const notConfigured = (key: string, label: string, envName: string): Probe => ({
  key,
  label,
  state: "not-configured",
  detail: `${envName} is not set on this deployment, so nothing here can reach it.`,
});

export type GateReading =
  | { state: "gated"; adapter: `0x${string}` }
  | { state: "ungated"; reverted: boolean }
  | { state: "unknown"; because: string };

/**
 * Whether a rail gates claims on standing — with the answer corroborated before
 * it is believed.
 *
 * `chainReads.standingGate` treats a `ContractFunctionExecutionError` as proof
 * that the function is absent from the bytecode. viem wraps a *transport*
 * failure in that same error class, so against a dead endpoint it reports the
 * Base rail — which demonstrably does gate, through the adapter at
 * `0xE873C3d5…` — as bytecode that predates the check. Verified by pointing
 * `NEXT_PUBLIC_WELL_RPC_URL` at a closed port: it answered "this bytecode
 * predates the standing gate" with total confidence.
 *
 * That is precisely the class of statement this codebase has shipped before and
 * must not ship again: a fact about our endpoint, rendered as a fact about
 * somebody else's contract. So a claimed revert is only accepted once a second
 * call to the same rail succeeds. If `bountyCount` cannot be read either, the
 * endpoint is the problem and the honest answer is that we do not know.
 */
export async function readStandingGate(
  rail: `0x${string}`,
  chain: TxChain,
): Promise<GateReading> {
  const gate = await standingGate(rail, chain);
  if (!gate.ok) return { state: "unknown", because: gate.degraded };
  if (gate.value.gated) return { state: "gated", adapter: gate.value.adapter! };
  if (!gate.value.reverted) return { state: "ungated", reverted: false };

  const alive = await bountyCount(rail, chain);
  if (!alive.ok) {
    return {
      state: "unknown",
      because:
        `standing() returned nothing, but neither did bountyCount() on the same rail, ` +
        `so the endpoint — not the bytecode — is what did not answer: ${alive.degraded}`,
    };
  }
  return { state: "ungated", reverted: true };
}

async function probeRail(
  key: string,
  label: string,
  rail: `0x${string}` | undefined,
  chain: TxChain,
  envName: string,
): Promise<Probe> {
  if (!rail) return notConfigured(key, label, envName);

  const gate = await readStandingGate(rail, chain);
  if (gate.state === "unknown") {
    return { key, label, state: "unknown", detail: gate.because };
  }
  if (gate.state === "gated") {
    return {
      key,
      label,
      state: "ready",
      detail: `${shortAddress(rail)} — claims are gated on standing via ${shortAddress(gate.adapter)}.`,
    };
  }
  return {
    key,
    label,
    state: "ready",
    detail: gate.reverted
      ? `${shortAddress(rail)} — standing() returns nothing, so this bytecode predates the gate.`
      : `${shortAddress(rail)} — deployed with no standing adapter.`,
    // The rail works; it just does less than the page would otherwise imply. That
    // belongs beside the badge, not folded into the state — see `Probe.caveat`.
    caveat: gate.reverted
      ? "Claims here are not gated on human backing, and cannot be — standing is immutable and this contract has no owner."
      : "Claims here are not gated on human backing.",
  };
}

const probeBaseRail = (): Promise<Probe> =>
  probeRail(
    "base-rail",
    "Bounty rail (Base)",
    AGENT_CONTRACTS.baseRail,
    "base-sepolia",
    "NEXT_PUBLIC_WELL_BOUNTY_RAIL",
  );

const probeHederaRail = (): Promise<Probe> =>
  probeRail(
    "hedera-rail",
    "Bounty rail (Hedera)",
    AGENT_CONTRACTS.hederaRail,
    "hedera-testnet",
    "NEXT_PUBLIC_HEDERA_BOUNTY_RAIL",
  );

async function probeHumanRegistry(): Promise<Probe> {
  const registry = AGENT_CONTRACTS.humanRegistry;
  if (!registry) {
    return notConfigured("human-registry", "Human backing", "NEXT_PUBLIC_WELL_HUMAN_REGISTRY");
  }
  // Asked about a wallet nobody holds: a successful answer proves the contract
  // responds, and the answer itself asserts nothing about anybody.
  const read = await humanBacking(NOBODY);
  return fromRead(
    "human-registry",
    "Human backing",
    read,
    () => `${shortAddress(registry)} — HumanBackingRegistry is answering.`,
  );
}

async function probeStandingLedger(): Promise<Probe> {
  const ledger = AGENT_CONTRACTS.standingLedger;
  if (!ledger) {
    return notConfigured("standing-ledger", "Standing ledger", "NEXT_PUBLIC_WELL_STANDING_LEDGER");
  }
  const read = await standingFor(NO_HUMAN);
  return fromRead(
    "standing-ledger",
    "Standing ledger",
    read,
    () => `${shortAddress(ledger)} — StandingLedger is answering.`,
  );
}

async function probeResourceRegistry(): Promise<Probe> {
  const registry = AGENT_CONTRACTS.resourceRegistry;
  if (!registry) {
    return notConfigured(
      "resource-registry",
      "Resource registry",
      "NEXT_PUBLIC_WELL_RESOURCE_REGISTRY",
    );
  }
  const read = await resourceEpoch();
  return fromRead("resource-registry", "Resource registry", read, (v) => {
    const hours = Math.round(v.epochLength / 360) / 10;
    return `${shortAddress(registry)} — quota window ${hours}h, epoch ${v.currentEpoch}, ${v.grantCount} grant${v.grantCount === 1 ? "" : "s"} issued so far.`;
  });
}

/** Env only, so there is no `unknown` to have: we can always read our own process. */
function probeAgentKeys(): Probe {
  const configured = agentKeysConfigured();
  const peppered = Boolean(process.env.WELL_AGENT_KEY_PEPPER);
  if (!configured) {
    return {
      key: "agent-keys",
      label: "Agent keys",
      state: "not-configured",
      detail:
        "WELL_AGENT_KEY_PEPPER is required in production, so issuing a key is refused on this deployment.",
    };
  }
  return {
    key: "agent-keys",
    label: "Agent keys",
    state: "ready",
    detail: peppered
      ? "A pepper is configured, so a database dump alone cannot even confirm a correct guess."
      : "Keys can be issued here.",
    ...(peppered
      ? {}
      : {
          caveat:
            "No pepper is set, so a development fallback is in use — keys issued here are not safe to rely on.",
        }),
  };
}

/** The one fact about the package that a builder needs and cannot check from here. */
function probeSdkDistribution(): Probe {
  return {
    key: "sdk-package",
    label: "The SDK package",
    state: "not-configured",
    detail:
      "@votive/agent-skills is not published to npm — the registry answers 404. Install it from a packed checkout or a git dependency; both build on install.",
  };
}

export async function skillReadiness(): Promise<Probe[]> {
  const [base, hedera, humans, ledger, resources] = await Promise.all([
    probeBaseRail(),
    probeHederaRail(),
    probeHumanRegistry(),
    probeStandingLedger(),
    probeResourceRegistry(),
  ]);
  return [base, hedera, humans, ledger, resources, probeAgentKeys(), probeSdkDistribution()];
}

// ------------------------------------------------------------- the toolbelt

export interface ToolbeltStatus {
  item: ToolbeltItem;
  resourceId: `0x${string}`;
  state: ProbeState;
  /** What the registry says, or why we could not ask. */
  detail: string;
  /** Present only when the resource is registered — never invented. */
  onchain?: {
    provider: `0x${string}`;
    baseLimit: number;
    minAssurance: number;
    active: boolean;
  };
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * What the chain says about each toolbelt item.
 *
 * `resourceOf` answering with a zero provider is a real answer — the registry has
 * never been told about this id — and it is reported as such. A failed read is
 * not that, and is reported as unknown. The difference is the difference between
 * "we have not registered this yet" and "we could not ask".
 */
export async function toolbeltStatus(): Promise<ToolbeltStatus[]> {
  return Promise.all(
    TOOLBELT.map(async (item) => {
      const resourceId = resourceIdOf(item.slug);
      const read = await resourceOf(resourceId);
      if (!read.ok) {
        return { item, resourceId, state: "unknown" as const, detail: read.degraded };
      }
      if (read.value.provider === ZERO) {
        return {
          item,
          resourceId,
          state: "not-configured" as const,
          detail:
            "Not registered on this deployment yet. The id is derived and stable, so registering it later needs no change here.",
        };
      }
      return {
        item,
        resourceId,
        state: "ready" as const,
        detail: read.value.active
          ? `Registered: ${read.value.baseLimit} uses per epoch at parity standing, minimum assurance ${assuranceLabel(read.value.minAssurance)}.`
          : `Registered but retired: no new grants are issued, and grants already out stay valid until they lapse.`,
        onchain: {
          provider: read.value.provider,
          baseLimit: read.value.baseLimit,
          minAssurance: read.value.minAssurance,
          active: read.value.active,
        },
      };
    }),
  );
}
