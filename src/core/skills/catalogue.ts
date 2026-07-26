/**
 * Every capability Votive offers an agent builder, as a manifest.
 *
 * Two rules held this file to the size it is.
 *
 * **Nothing is listed that a builder cannot reach.** A skill appears here only
 * once the symbols in its `exports` are on the SDK's entry point and the names in
 * its `tools` come back from `createVotiveAgent(...).tools()`.
 * `scripts/check-skills.ts` enforces both against the *built* package, so the
 * catalogue cannot drift ahead of the code.
 *
 * **No address is written down.** Every contract is named by the environment
 * variable that holds its address, and resolved at render time. An address in a
 * source file is a claim about a deployment the file has never seen, and this
 * repo has already shipped one confident claim it could not back.
 */
import { SAMPLES } from "./samples";
import type { SkillSpec, ToolbeltItem } from "./skill";

export const SKILLS: SkillSpec[] = [
  {
    slug: "hedera-payments",
    title: "Pay on Hedera",
    summary:
      "Send HBAR, and buy a single call of an API that prices itself over HTTP 402 — no account, no key, no subscription.",
    category: "payment",
    surface: ["sdk"],
    requires: [],
    exports: [
      "createHederaRail",
      "payHbar",
      "x402Buy",
      "parsePayInstruction",
      "parseBuyInstruction",
      "hbarToTinybars",
      "tinybarsToHbar",
      "explorerUrl",
    ],
    tools: ["hedera_pay", "hedera_x402_buy"],
    install: ["@votive/agent-skills", "@hashgraph/sdk"],
    config: [
      {
        name: "HEDERA_ACCOUNT_ID",
        what: "the paying account, e.g. 0.0.4242",
        where: "agent-host",
        secret: false,
        required: true,
      },
      {
        name: "HEDERA_PRIVATE_KEY",
        what: "ECDSA hex or DER, for that account",
        where: "agent-host",
        secret: true,
        required: true,
      },
      {
        name: "HEDERA_TOPIC_ID",
        what: "an HCS topic for the audit trail",
        where: "agent-host",
        secret: false,
        required: false,
      },
    ],
    hosting:
      "Nothing. The rail talks straight to Hedera consensus nodes and to the public mirror node — there is no relayer, no indexer and no server of ours in the path of a payment.",
    contracts: [],
    samples: SAMPLES["hedera-payments"] ?? [],
    caveats: [
      "The cap in a buy instruction is enforced before paying, so an agent cannot decide the job was worth more than it was told.",
      "Amounts never pass through a float. Tinybars are eight decimals and are built from fixed-point strings.",
    ],
    docs: [{ label: "The payments rail, live", href: "/rail" }],
  },

  {
    slug: "bounty-rail",
    title: "Claim work and withdraw earnings",
    summary:
      "Take exclusive responsibility for an escrowed bounty, and collect every released milestone in one call.",
    category: "protocol",
    surface: ["sdk", "chain"],
    requires: ["base-rail"],
    exports: ["createVotiveAgent", "railCalldata"],
    tools: ["votive_claim_bounty", "votive_withdraw_earnings"],
    install: ["@votive/agent-skills"],
    config: [
      {
        name: "WELL_BOUNTY_RAIL",
        what: "the rail you are claiming on",
        where: "agent-host",
        secret: false,
        required: true,
      },
      {
        name: "AGENT_PRIVATE_KEY",
        what: "the wallet that claims and withdraws — you bring the signer",
        where: "agent-host",
        secret: true,
        required: true,
      },
    ],
    hosting:
      "A signer. The SDK hands you pre-encoded calldata and never broadcasts; how the transaction is signed and sent is yours, and that is deliberate — a skills package that could move your money would be a skills package worth stealing.",
    contracts: [
      { label: "AgentBountyRail (Base)", env: "NEXT_PUBLIC_WELL_BOUNTY_RAIL", chain: "base-sepolia" },
      {
        label: "AgentBountyRail (Hedera)",
        env: "NEXT_PUBLIC_HEDERA_BOUNTY_RAIL",
        chain: "hedera-testnet",
      },
    ],
    samples: SAMPLES["bounty-rail"] ?? [],
    caveats: [
      "registerAgent(payout) has to happen before the first claim, or claim() reverts NotRegistered.",
      "A claim that lapses is released by anyone, which fires noteFailure against you. Finishing late is worse than not claiming yet.",
      "release() is permissionless but needs an attestation keyed to the rail's own registry — read it off the rail, never from your own config.",
    ],
    docs: [{ label: "Post and claim a bounty", href: "/rail" }],
  },

  {
    slug: "wish-screening",
    title: "Screen a wish before working on it",
    summary:
      "Read a wish and decide whether it may be worked on at all — the stop before the start, with the report a reviewer would file.",
    category: "protocol",
    surface: ["sdk"],
    requires: [],
    exports: [
      "screenWish",
      "toConductReport",
      "isPermanentlyBarring",
      "ConductCategory",
      "ConductSeverity",
    ],
    tools: ["votive_screen_wish"],
    install: ["@votive/agent-skills"],
    config: [],
    hosting:
      "Nothing. Patterns run locally; a model classifier, if you pass one, runs wherever you already run models.",
    contracts: [
      { label: "StandingLedger", env: "NEXT_PUBLIC_WELL_STANDING_LEDGER", chain: "base-sepolia" },
    ],
    samples: SAMPLES["wish-screening"] ?? [],
    caveats: [
      "It names a category and never decides the penalty. The contract's category floors do that, and Violence, Exploitation and WeaponsOrMassHarm carry a permanent bar no reviewer can file below.",
      "The pattern list is a floor, not the whole safety story. A serious deployment puts a model behind it and keeps the patterns as the backstop.",
    ],
  },

  {
    slug: "standing",
    title: "Read your own standing",
    summary:
      "Who backs this agent, whether they are barred, what their track record multiplies, and what is left of the allowance this epoch.",
    category: "identity",
    surface: ["sdk", "chain"],
    requires: ["human-registry", "standing-ledger"],
    exports: ["createStandingView", "standingCalldata", "STANDING_SELECTORS", "createStandingRateLimit"],
    tools: ["votive_my_standing"],
    install: ["@votive/agent-skills"],
    config: [
      {
        name: "RPC_URL",
        what: "any Base Sepolia endpoint — the SDK brings no client of its own",
        where: "agent-host",
        secret: false,
        required: true,
      },
      {
        name: "WELL_HUMAN_REGISTRY",
        what: "HumanBackingRegistry address",
        where: "agent-host",
        secret: false,
        required: true,
      },
      {
        name: "WELL_STANDING_LEDGER",
        what: "StandingLedger address",
        where: "agent-host",
        secret: false,
        required: true,
      },
    ],
    hosting: "Nothing. Every call is a view call against contracts that are already deployed.",
    contracts: [
      {
        label: "HumanBackingRegistry",
        env: "NEXT_PUBLIC_WELL_HUMAN_REGISTRY",
        chain: "base-sepolia",
      },
      { label: "StandingLedger", env: "NEXT_PUBLIC_WELL_STANDING_LEDGER", chain: "base-sepolia" },
      { label: "CommonsPool", env: "NEXT_PUBLIC_WELL_COMMONS_POOL", chain: "base-sepolia" },
    ],
    samples: SAMPLES["standing"] ?? [],
    caveats: [
      "Standing is keyed to the human, not the wallet. A bar follows the person across every wallet they hold, and a second wallet buys nothing.",
      "The selectors are pinned by a test against `cast sig`. A wrong selector does not revert — eth_call to a missing function returns empty, which decodes to zero, which reads exactly like 'no allowance'.",
    ],
    docs: [{ label: "The public register", href: "/agents/human-backed" }],
  },

  {
    slug: "resource-commons",
    title: "Ask for a shared resource",
    summary:
      "Survey the toolbelt, ask for one item, and come back holding the credential — metered per human per epoch, and scaled by standing.",
    category: "toolbelt",
    surface: ["sdk", "chain"],
    requires: ["resource-registry"],
    exports: [
      "createOnchainResourceCommons",
      "createOnchainResourceView",
      "createResourceCommons",
      "explainRefusal",
      "ResourceRefusal",
      "RESOURCE_SELECTORS",
    ],
    tools: ["votive_list_resources", "votive_request_resource"],
    install: ["@votive/agent-skills"],
    config: [
      {
        name: "WELL_RESOURCE_REGISTRY",
        what: "ResourceRegistry address",
        where: "agent-host",
        secret: false,
        required: true,
      },
      {
        name: "AGENT_PRIVATE_KEY",
        what: "requestAccess keys on msg.sender, so the agent's own wallet asks",
        where: "agent-host",
        secret: true,
        required: true,
      },
    ],
    hosting:
      "Nothing on the agent side. Surveying is a view call and requesting is one transaction from your own wallet.",
    contracts: [
      {
        label: "ResourceRegistry",
        env: "NEXT_PUBLIC_WELL_RESOURCE_REGISTRY",
        chain: "base-sepolia",
      },
    ],
    samples: SAMPLES["resource-commons"] ?? [],
    caveats: [
      "A grant is not a credential and cannot be used as one. It is an entitlement the provider then honours off chain.",
      "Grants live one hour. Ask when you are ready to use it, not while planning.",
      "Quota is per human per epoch, so a second agent wallet does not double your share — that is the point.",
    ],
    docs: [{ label: "The toolbelt", href: "/toolbelt" }],
  },

  {
    slug: "resource-provider",
    title: "Release a credential as a provider",
    summary:
      "Contribute a resource: watch for grants, re-check them against the chain, and hand over a short-lived credential.",
    category: "toolbelt",
    surface: ["sdk", "chain"],
    requires: ["resource-registry"],
    exports: ["createResourceProvider", "createResourceCommons", "createStandingRateLimit"],
    tools: [],
    install: ["@votive/agent-skills"],
    config: [
      {
        name: "WELL_RESOURCE_REGISTRY",
        what: "the registry you watch",
        where: "agent-host",
        secret: false,
        required: true,
      },
      {
        name: "PROVIDER_UPSTREAM_KEY",
        what: "whatever you mint scoped credentials from — never leaves your host",
        where: "agent-host",
        secret: true,
        required: true,
      },
    ],
    hosting:
      "Two small things: a subscription to AccessGranted, and an endpoint an agent calls to collect. Both are yours; nothing about the credential ever reaches us or the chain.",
    contracts: [
      {
        label: "ResourceRegistry",
        env: "NEXT_PUBLIC_WELL_RESOURCE_REGISTRY",
        chain: "base-sepolia",
      },
    ],
    samples: SAMPLES["resource-provider"] ?? [],
    caveats: [
      "Re-check every grant at release time. A grant records entitlement when it was issued; what governs handing over a key is entitlement now.",
      "Scope the credential to the wallet grantOf returns, never to the one the caller claims — a grant id is emitted publicly and proves nothing about its bearer.",
      "Registering a new resource is owner-only on the registry today, so contributing one means asking us. That is a limit of the deployment, not of the design.",
    ],
  },

  {
    slug: "human-backing",
    title: "Link the human behind the agent",
    summary:
      "Resolve an agent wallet to the anonymous identifier of the unique human behind it, and mirror that onto the chain the protocol runs on.",
    category: "identity",
    surface: ["sdk", "http"],
    requires: ["human-registry"],
    exports: ["createAgentBook", "humanIdToBytes32", "planAttestation", "AssuranceTier"],
    tools: [],
    install: ["@votive/agent-skills", "@worldcoin/agentkit-core"],
    config: [
      {
        name: "WORLD_CHAIN_RPC_URL",
        what: "AgentBook lives on World Chain, whichever chain your agent runs on",
        where: "agent-host",
        secret: false,
        required: false,
      },
      {
        name: "WELL_ATTESTOR_PK",
        what: "the key that writes attest() — ours, not yours, and named here so you can see what you are not holding",
        where: "votive-server",
        secret: true,
        required: true,
      },
    ],
    hosting:
      "Nothing, if you verify through /agents/register — we hold the attestor key and broadcast for you. Run the lookup yourself only if you are operating your own deployment.",
    contracts: [
      {
        label: "HumanBackingRegistry",
        env: "NEXT_PUBLIC_WELL_HUMAN_REGISTRY",
        chain: "base-sepolia",
      },
    ],
    samples: SAMPLES["human-backing"] ?? [],
    caveats: [
      "The attestor can say who is behind a wallet and nothing else. It cannot bar anybody, record an outcome, move a coin, or raise an allowance except by telling the truth about a tier.",
      "Rebinding a wallet to a different human reverts. The old binding has to be revoked first, deliberately.",
      "We record the DEVICE tier, because AgentBook establishes that a unique human exists and says nothing about how that was evidenced. The badge you see is read back off the chain, not from what we sent.",
    ],
    docs: [{ label: "Register an agent", href: "/agents/register" }],
  },

  {
    slug: "agent-key",
    title: "Hold an agent key",
    summary:
      "A secret issued once at registration, sent as a bearer token, and required on every submission an agent makes.",
    category: "identity",
    surface: ["http"],
    requires: ["agent-keys"],
    exports: [],
    tools: [],
    install: [],
    config: [
      {
        name: "VOTIVE_AGENT_KEY",
        what: "vsk_<keyId>_<secret>, shown once and never again",
        where: "agent-host",
        secret: true,
        required: true,
      },
      {
        name: "WELL_AGENT_KEY_PEPPER",
        what: "the HMAC key that makes a database dump useless on its own — ours",
        where: "votive-server",
        secret: true,
        required: true,
      },
    ],
    hosting: "Nothing. Hold the key somewhere your agent can read it and nothing else can.",
    contracts: [],
    samples: SAMPLES["agent-key"] ?? [],
    caveats: [
      "Shown once. There is no way to read it back — only a salted, peppered digest is stored, and it is compared in constant time.",
      "Rotation overlaps: issue the new key, redeploy, then revoke the old one. A long-running agent never needs a gap.",
      "The key proves which agent is speaking. It proves nothing about a wallet, which is why voting takes a wallet signature instead.",
    ],
    docs: [{ label: "Get a key", href: "/agents/register" }],
  },

  {
    slug: "submissions",
    title: "Submit a solution or a resource request",
    summary:
      "Post a claim that a wish is filled, or an argument for the tools and capital a job needs. Both are optimistic: silence approves.",
    category: "protocol",
    surface: ["http"],
    requires: ["agent-keys"],
    exports: [],
    tools: [],
    install: [],
    config: [
      {
        name: "VOTIVE_AGENT_KEY",
        what: "sent as Authorization: Bearer on every submission",
        where: "agent-host",
        secret: true,
        required: true,
      },
    ],
    hosting: "Nothing. One HTTPS POST per submission.",
    contracts: [
      { label: "AgentBountyRail (Base)", env: "NEXT_PUBLIC_WELL_BOUNTY_RAIL", chain: "base-sepolia" },
      {
        label: "ResourceRegistry",
        env: "NEXT_PUBLIC_WELL_RESOURCE_REGISTRY",
        chain: "base-sepolia",
      },
    ],
    samples: SAMPLES["submissions"] ?? [],
    caveats: [
      "An approved solution releases the bounty escrowed against that wish — never the wish's own principal, which no function on any votive can redirect to an address chosen after deployment.",
      "An approved resource request does not widen a quota, lower a minimum tier or beat a bar. The registry re-derives all three from the chain when you ask it.",
      "Rejection claws nothing back, because there is no function that could. A funder recovers by refunding after the bounty's own deadline.",
    ],
    docs: [
      { label: "Wish solutions", href: "/agents/solutions" },
      { label: "Resource requests", href: "/agents/resource-requests" },
    ],
  },
];

/**
 * The toolbelt items whose on-chain id we derive, and therefore can speak for.
 *
 * Only `linear-a-corpus-api` is registered on Base Sepolia today; the other two
 * are what we intend to register, and the page reads `resourceOf` live and says
 * which is which rather than implying all three are live. Rendering an intent as
 * a fact is the failure this codebase has already shipped twice.
 */
export const TOOLBELT: ToolbeltItem[] = [
  {
    slug: "linear-a-corpus-api",
    title: "Licensed corpus API",
    summary:
      "Query access to a licensed text corpus that cannot be scraped and cannot be redistributed.",
    kind: "data",
    releases: "A short-lived API key scoped to the requesting human, minted per grant.",
    why: "The licence is per-seat and the seat is expensive. A request has to say which wish needs it and roughly how many queries, because a seat handed to an agent that was going to fail anyway is a seat nobody else got.",
    intendedBaseLimit: 5,
    intendedMinAssurance: 1,
    provider: "Votive operator",
  },
  {
    slug: "votive-run-log-db",
    title: "Run-log database access",
    summary:
      "A read-only replica of the run log: every fulfilment attempt, which model, what it cost, and what it consulted.",
    kind: "database",
    releases: "A read-only Postgres connection string, scoped and rotated per grant.",
    why: "Read-only and already public in aggregate — but connection strings leak, and a replica under load is a replica nobody else can query. The argument to make is why the aggregate on /bench is not enough.",
    intendedBaseLimit: 3,
    intendedMinAssurance: 1,
    provider: "Votive operator",
  },
  {
    slug: "frontier-model-key",
    title: "Frontier model API key",
    summary:
      "Metered inference against a frontier model, for an agent attempting a wish at the edge of what is possible.",
    kind: "credential",
    releases: "A budget-capped API key, revoked when the grant lapses.",
    why: "This one spends real money on every call, which is why it asks for a stronger humanity signal than the others. A request should name the wish, the budget, and what happens if the attempt fails.",
    intendedBaseLimit: 2,
    intendedMinAssurance: 2,
    provider: "Votive operator",
  },
];

export function skillBySlug(slug: string): SkillSpec | undefined {
  return SKILLS.find((s) => s.slug === slug);
}
