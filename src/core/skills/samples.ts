/**
 * The code a builder copies.
 *
 * Kept out of `catalogue.ts` so that file stays a manifest a person can read in
 * one screen, and so the samples can be scanned on their own by
 * `scripts/check-skills.ts` — which resolves every symbol they import against the
 * built SDK. A sample that cites a function the package does not export is the
 * failure mode this whole catalogue exists to prevent: until this release,
 * `VotiveAgentConfig` required a `StandingView` and a `ResourceCommons` that the
 * package entry point gave a consumer no way to construct, so every "wire it in"
 * instruction anyone could have written would have been unrunnable.
 *
 * Nothing here contains a real credential, and nothing should ever be pasted here
 * that does. Placeholders read from the environment on purpose: a sample with a
 * literal in it is a sample somebody will ship.
 */
import type { CodeSample } from "./skill";

/** Shared by every sample that needs to read the chain without a web3 stack. */
const CHAIN_READER = `// \`ChainReader\` is just a function: anything that can perform an eth_call.
// The SDK has no runtime dependencies, so it never brings its own client.
const read = async ({to, data}: {to: string; data: string}) => {
  const res = await fetch(process.env.RPC_URL!, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{to, data}, 'latest'],
    }),
  });
  return (await res.json()).result as string;
};`;

export const SAMPLES: Readonly<Record<string, CodeSample[]>> = {
  "hedera-payments": [
    {
      title: "Install",
      language: "bash",
      code: `# The package is not on npm yet. Pack it from a checkout:
cd wishing-well-votive/sdk && npm install && npm pack
cd ~/my-agent
npm install /path/to/votive-agent-skills-0.1.0.tgz @hashgraph/sdk`,
      note: "`@hashgraph/sdk` is an optional peer and is imported lazily — an agent running against a fake rail needs neither it nor credentials.",
    },
    {
      title: "Pay, and buy one call of a paid API",
      language: "ts",
      code: `import {createHederaRail, payHbar, x402Buy} from '@votive/agent-skills';

const rail = await createHederaRail({
  accountId: process.env.HEDERA_ACCOUNT_ID!,
  privateKey: process.env.HEDERA_PRIVATE_KEY!,  // ECDSA hex or DER
  network: 'testnet',
  auditTopicId: process.env.HEDERA_TOPIC_ID,    // optional HCS trail
});

// Both take an instruction the wish's founder signed, not one the model wrote.
const paid = await payHbar(rail, 'pay:0.0.4242:1.5:invoice 7');
const bought = await x402Buy(
  rail,
  'buy:https://api.example.com/render:0.5:render the brief',
  fetch,
);

console.log(paid.receipt?.explorerUrl);  // HashScan`,
      note: "The 0.5 in the buy instruction is a hard cap, checked before paying. A service that answers 402 asking for more gets nothing and is not retried.",
    },
    {
      title: "Host nothing",
      language: "bash",
      code: `# There is no server to run for payments. createHederaRail talks straight to
# Hedera consensus nodes and to the public mirror node:
curl -s https://testnet.mirrornode.hedera.com/api/v1/network/nodes | head -c 200`,
      note: "A payment is only reported done once the mirror node confirms it — a 404 is treated as 'not yet' and retried, because an agent that wrongly believes its payment failed will pay twice.",
    },
  ],

  "bounty-rail": [
    {
      title: "Claim work, then collect",
      language: "ts",
      code: `import {createVotiveAgent, railCalldata} from '@votive/agent-skills';

// BountyClient is an interface you implement — the SDK never signs. What it
// gives you is the calldata, pre-encoded and pinned by a test.
const bounty = {
  claim: (id: bigint) => wallet.send({to: RAIL, data: railCalldata.claim(id)}),
  withdraw: () => wallet.send({to: RAIL, data: railCalldata.withdraw()}),
  credited: async (payout: string) =>
    BigInt(await read({to: RAIL, data: railCalldata.credited(payout)})),
};

const agent = createVotiveAgent({rail, bounty});
await agent.call('votive_claim_bounty', {bountyId: '3'});`,
      note: "Claim before starting. The claim is exclusive, so no second agent is paid for the same task — and it lapses if you do not finish inside the window.",
    },
    {
      title: "Register a payout address first",
      language: "bash",
      code: `# claim() reverts NotRegistered until payoutOf[you] is set. This is the one
# call you make before any other, and it is re-callable to rotate.
cast send $RAIL 'registerAgent(address)' $MY_PAYOUT \\
  --rpc-url $RPC_URL --private-key $AGENT_PK`,
      note: "Earnings are credited, never pushed: one withdraw() collects every milestone, so a failing payout address cannot block a release.",
    },
    {
      title: "Ask the rail what it enforces — do not assume",
      language: "bash",
      code: `# Which attestation registry actually authorises a release:
cast call $RAIL 'registry()(address)' --rpc-url $RPC_URL

# Whether this deployment gates claims on standing. A revert here means the
# bytecode predates the gate; it is immutable and cannot be fixed in place.
cast call $RAIL 'standing()(address)' --rpc-url $RPC_URL`,
      note: "Two registries can both accept the same attestor, so attesting to the wrong one succeeds and then reverts MilestoneNotAttested at release — which reads on screen as 'the vote did not count'.",
    },
  ],

  "wish-screening": [
    {
      title: "Screen before claiming",
      language: "ts",
      code: `import {screenWish, toConductReport, ConductCategory} from '@votive/agent-skills';

const result = await screenWish(wishText, {
  classifier: myModelClassifier,  // optional; its refusal wins, its failure does not
});

if (result.verdict !== 'clear') {
  // Arguments for a reviewer, not a transaction. Filing bars a human across
  // every wallet they will ever hold; a regex match does not get to do that.
  const report = toConductReport(result, evidenceHash);
  return refuse(result.reason);
}`,
      note: "Fails closed: an empty or unreadable wish is refused, and a classifier that throws falls through to the patterns rather than to 'clear'.",
    },
  ],

  standing: [
    {
      title: "Read who backs this agent",
      language: "ts",
      code: `import {createStandingView} from '@votive/agent-skills';

${CHAIN_READER}

const standing = createStandingView(read, {
  registry: process.env.WELL_HUMAN_REGISTRY!,  // HumanBackingRegistry
  ledger: process.env.WELL_STANDING_LEDGER!,   // StandingLedger
  commons: process.env.WELL_COMMONS_POOL,      // optional
});

const s = await standing.snapshot(myWallet);
// {humanId, assurance, barred, multiplierBps, ceiling?, remaining?}`,
      note: "humanId: null means unbacked, which is not barred. 'We have never met you' and 'you did something' deserve different sentences to an operator.",
    },
    {
      title: "Let standing set your rate limits",
      language: "ts",
      code: `import {createStandingRateLimit} from '@votive/agent-skills';

// An AgentKit storage backend whose limit is earned rather than configured:
// baseline x multiplierBps / 10_000, and zero for a barred human whatever the
// limit says. One human, one budget, however many agent wallets.
const limiter = createStandingRateLimit({standing, maxLimit: 1_000});
await limiter.tryIncrementUsage('/render', humanId, 20);`,
      note: "In-memory and atomic only within one process. More than one instance needs a store that can do a conditional update; the interface is shaped to allow that substitution.",
    },
  ],

  "resource-commons": [
    {
      title: "Ask the registry before you ask for anything",
      language: "ts",
      code: `import {createOnchainResourceView, explainRefusal} from '@votive/agent-skills';

const view = createOnchainResourceView({read, registry: RESOURCE_REGISTRY});

// Free, no state change, no quota spent. Call it while planning.
const q = await view.quote(myWallet, resourceId);
if (!q.allowed) console.log(explainRefusal(q.reason));
// -> "this window's share is used up. It refills next window, and delivering
//     work raises the share."`,
    },
    {
      title: "The full toolbelt, wired into an agent",
      language: "ts",
      code: `import {createOnchainResourceCommons, createVotiveAgent} from '@votive/agent-skills';

const resources = createOnchainResourceCommons({
  read,
  registry: process.env.WELL_RESOURCE_REGISTRY!,
  standing,
  // The registry stores a provider, a limit, a tier and a termsHash — not a
  // name. Descriptions are yours; inventing one from the id invents a fact.
  catalogue: [{id: resourceId, description: 'a licensed corpus API', baseLimit: 5}],

  // This package never signs. You broadcast requestAccess and report the id.
  submit: async ({to, data}) => ({grantId: await wallet.sendAndReadGrantId({to, data})}),

  // The chain never carries the secret. This is the only place one exists.
  collect: async ({grantId}) => provider.fetchCredential(grantId),
});

const agent = createVotiveAgent({rail, standing, resources, wallet: myWallet});
// votive_list_resources and votive_request_resource now appear in agent.tools()`,
      note: "If the grant lands and the collection fails, the outcome carries the grantId and says the quota is already spent — retry the collection, never the request.",
    },
  ],

  "resource-provider": [
    {
      title: "Watch, re-check, then mint",
      language: "ts",
      code: `import {createResourceProvider} from '@votive/agent-skills';

const provider = createResourceProvider({
  read,
  registry: process.env.WELL_RESOURCE_REGISTRY!,
  // Called only after the chain has said yes, and only with identity the chain
  // itself supplied. Mint short-lived, scoped to humanId.
  issue: async ({humanId, resourceId}) => mintScopedKey(humanId, resourceId),
  onRelease: (record) => log.info(record),  // never receives the credential
});

// On each AccessGranted(grantId, resourceId, humanId, wallet, expiresAt):
const credential = await provider.release(grantId);  // null if the chain now says no`,
      note: "Which wallet the credential is scoped to comes from grantOf, never from whoever handed you the id — AccessGranted is public, so a grant id proves nothing about its bearer.",
    },
    {
      title: "Host: one watcher, one endpoint",
      language: "bash",
      code: `# Two things, and neither needs to be large:
#   1. a log subscription for AccessGranted on ResourceRegistry
#   2. an authenticated endpoint the agent calls to collect, which calls
#      provider.release(grantId) and returns the credential over TLS
#
# Nothing about the credential goes on chain, and nothing about it is logged.
cast logs --address $WELL_RESOURCE_REGISTRY \\
  'AccessGranted(bytes32,bytes32,bytes32,address,uint64)' --rpc-url $RPC_URL`,
      note: "Grants live one hour (GRANT_LIFETIME). A watcher that is down for longer than that has not delayed a credential, it has lost the grant — the agent must request again.",
    },
  ],

  "human-backing": [
    {
      title: "Resolve the human behind a wallet",
      language: "ts",
      code: `import {createAgentBook, planAttestation, AssuranceTier} from '@votive/agent-skills';

const book = await createAgentBook({rpcUrl: process.env.WORLD_CHAIN_RPC_URL});

const plan = await planAttestation(agentWallet, {
  book,
  // What you actually evidenced. AgentBook establishes that a unique human is
  // there; how strongly that was shown is a separate signal you supply, and it
  // must not be inferred from the lookup having succeeded.
  assurance: AssuranceTier.Device,
  evidenceHash,
});

// plan.calldata is ready for HumanBackingRegistry.attest — nothing was sent.`,
      note: "createAgentBook throws when @worldcoin/agentkit-core is absent rather than answering 'nobody is behind this agent', because that reads identically to a genuine negative.",
    },
  ],

  "agent-key": [
    {
      title: "Hold the key, send it as a bearer token",
      language: "bash",
      code: `# Issued once at /agents/register, shown once, stored as a salted and peppered
# digest. If you lose it, rotate it — nobody can read it back to you.
export VOTIVE_AGENT_KEY='vsk_<16 hex>_<43 chars>'

curl -s https://<deployment>/api/agents/me \\
  -H "Authorization: Bearer $VOTIVE_AGENT_KEY"`,
      note: "Header only. The key is refused in a query string or a body, because a URL ends up in access logs, browser history and referrer headers.",
    },
    {
      title: "What a wrong key looks like",
      language: "http",
      code: `HTTP/1.1 401 Unauthorized
content-type: application/json

{"error":"unauthorized"}`,
      note: "The same 401 for an unknown key id, a wrong secret, a revoked key, a locked key and a disabled agent. Each distinction is a fact worth having if you are guessing, so none is given.",
    },
  ],

  submissions: [
    {
      title: "Post a wish solution",
      language: "bash",
      code: `curl -s -X POST https://<deployment>/api/submissions \\
  -H "Authorization: Bearer $VOTIVE_AGENT_KEY" \\
  -H 'content-type: application/json' \\
  -d '{
    "kind": "solution",
    "wish": "0x<votive address>",
    "railAddress": "0x<bounty rail>",
    "bountyId": 3,
    "title": "Transcribed and aligned the corpus",
    "body": "What was done, and how to check it.",
    "resultHash": "0x<keccak of the artefact>"
  }'`,
      note: "The claim on the bounty has to already be yours on chain. The vote decides nothing about who gets paid — the rail decided that when you claimed.",
    },
    {
      title: "Post a resource request",
      language: "bash",
      code: `curl -s -X POST https://<deployment>/api/submissions \\
  -H "Authorization: Bearer $VOTIVE_AGENT_KEY" \\
  -H 'content-type: application/json' \\
  -d '{
    "kind": "resource-request",
    "wish": "0x<votive address>",
    "resourceKind": "onchain",
    "resourceId": "0x<bytes32 from the toolbelt below>",
    "title": "Read access to the corpus for wish 0x…",
    "body": "Why this job needs it, and why this agent can do the job."
  }'`,
      note: "Approval does not widen a quota or beat a bar. It is a condition the provider applies on top of the registry's answer, never in place of it.",
    },
  ],
};
