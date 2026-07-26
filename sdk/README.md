# @votive/agent-skills

Skills an agent working on Votive can use to move value on Hedera, draw on the
shared toolbelt, and get paid for the work.

The shape is deliberately narrow. An agent decides *whether* to act; these skills
decide nothing. Every destination and every amount comes from an instruction the
wish's founder signed, and every payment is read back off the mirror node before it
is reported as done.

The package has **zero runtime dependencies**. It ships its own keccak-256 and
hand-encodes calldata rather than pulling in an EVM stack, because an agent runtime
should not need a web3 client to ask whether it is allowed to spend.

## Install

**This package is not on npm.** `npm install @votive/agent-skills` answers 404, and
will until somebody publishes it. Install it from a packed checkout:

```bash
git clone https://github.com/<org>/wishing-well-votive
cd wishing-well-votive/sdk
npm install          # `prepare` builds dist/ as part of this
npm pack             # -> votive-agent-skills-0.1.0.tgz

cd ~/my-agent
npm install /path/to/wishing-well-votive/sdk/votive-agent-skills-0.1.0.tgz
```

A git dependency works too, for the same reason — `prepare` builds on install:

```bash
npm install 'github:<org>/wishing-well-votive#main&path:/sdk'
```

### Optional peers

Both are optional, and both are imported lazily, so an agent that does not need
one does not have to install it.

| package | needed for | without it |
|---|---|---|
| `@hashgraph/sdk` | `createHederaRail` — real HBAR payments | use any `HederaRail` implementation; `test/fakeRail.ts` is a complete one |
| `@worldcoin/agentkit-core` | `createAgentBook` — who is behind a wallet | `createAgentBook` **throws**. It does not answer "nobody", because that reads identically to a genuine negative and would turn a misconfigured deployment into one that admits nothing |

```bash
npm install @hashgraph/sdk @worldcoin/agentkit-core
```

## The eight tools

```ts
import {createVotiveAgent} from '@votive/agent-skills';

const agent = createVotiveAgent({rail, bounty, standing, resources, wallet});
const tools = agent.tools();          // plain JSON Schema, hand it to any model
const result = await agent.call('votive_screen_wish', {text: wish});
```

| tool | what it does | offered when |
|---|---|---|
| `hedera_pay` | send HBAR to settle something the wish authorised | always (a rail is required) |
| `hedera_x402_buy` | buy one use of a paid API with no account and no key | always |
| `votive_claim_bounty` | take exclusive responsibility for a task before starting | `bounty` given |
| `votive_withdraw_earnings` | collect everything earned, in one call | `bounty` given |
| `votive_list_resources` | what shared resources exist and which are available now | `resources` + `wallet` |
| `votive_request_resource` | ask for one, and receive the credential | `resources` + `wallet` |
| `votive_screen_wish` | refuse a wish that must not be worked on | **always** |
| `votive_my_standing` | who backs this agent, and what it may spend | `standing` + `wallet` |

A tool the agent cannot perform is **not offered**, rather than offered and
guaranteed to fail. A tool name the model misremembers is refused rather than
approximated. `votive_screen_wish` is never hidden: it needs nothing but the wish
text, and it is the one tool that must not be missing from an agent that might be
handed a harmful wish.

## Wiring the pieces

Everything `VotiveAgentConfig` asks for is exported from the package root.

### The rail — payments on Hedera

```ts
import {createHederaRail, payHbar, x402Buy} from '@votive/agent-skills';

const rail = await createHederaRail({
  accountId: process.env.HEDERA_ACCOUNT_ID!,
  privateKey: process.env.HEDERA_PRIVATE_KEY!,   // ECDSA hex or DER
  network: 'testnet',
  auditTopicId: process.env.HEDERA_TOPIC_ID,     // optional HCS trail
});

const paid = await payHbar(rail, 'pay:0.0.4242:1.5:invoice 7');
const bought = await x402Buy(rail, 'buy:https://api.example.com/render:0.5:render', fetch);
```

**Host nothing for this.** `createHederaRail` talks straight to Hedera consensus
nodes and to the public mirror node at `https://<network>.mirrornode.hedera.com`.
There is no server to run and no relayer to trust.

### Standing — who backs this agent, and what it may spend

```ts
import {createStandingView} from '@votive/agent-skills';

// Any `eth_call`-shaped function satisfies `ChainReader`, including the one your
// wallet library already has.
const read = async ({to, data}) =>
  (await fetch(RPC_URL, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{to, data}, 'latest']}),
  }).then((r) => r.json())).result;

const standing = createStandingView(read, {
  registry: process.env.WELL_HUMAN_REGISTRY!,   // HumanBackingRegistry
  ledger: process.env.WELL_STANDING_LEDGER!,    // StandingLedger
  commons: process.env.WELL_COMMONS_POOL,       // optional — allowance questions
});

const snapshot = await standing.snapshot(myWallet);
// {humanId, assurance, barred, multiplierBps, ceiling?, remaining?}
```

`humanId: null` means the wallet is unbacked — *not* barred. Those are different
facts and deserve different sentences to an operator: "we have never met you" is
not "you did something."

### The toolbelt — shared resources that are not money

Two shapes, and they are not interchangeable.

**One process, one provider** — you own the resource and decide in memory:

```ts
import {createResourceCommons, createStandingRateLimit} from '@votive/agent-skills';

const commons = createResourceCommons({
  standing,
  limiter: createStandingRateLimit({standing}),   // limits scale with standing
  resources: [{
    id: 'corpus-api',
    description: 'a licensed corpus API',
    baseLimit: 5,
    minAssurance: 1,
    issue: async (grant) => mintShortLivedKey(grant.humanId),
  }],
});
```

**On chain** — the catalogue and the quota live in `ResourceRegistry`, and the
credential is released by whoever owns the resource, somewhere else entirely:

```ts
import {createOnchainResourceCommons} from '@votive/agent-skills';

const resources = createOnchainResourceCommons({
  read,
  registry: process.env.WELL_RESOURCE_REGISTRY!,
  standing,
  // The registry stores a provider, a limit, a tier and a termsHash — not a name.
  // Descriptions come from you.
  catalogue: [{id: RESOURCE_ID, description: 'a licensed corpus API', baseLimit: 5}],

  // This package never signs. You broadcast `requestAccess` and report the id.
  submit: async ({to, data}) => ({grantId: await myWallet.sendAndReadGrantId({to, data})}),

  // The chain never carries the secret. This is the only place a credential exists.
  collect: async ({grantId}) => myProvider.fetchCredential(grantId),
});
```

Then `createVotiveAgent({rail, standing, resources, wallet})` and the two resource
tools appear.

Three properties worth keeping when you adapt this:

- **Surveying consumes no quota.** `quote` is a view call, so an agent can plan
  without spending the very thing it is asking about.
- **The credential is fetched last**, after the registry has already said yes, so
  a refused request never causes one to exist.
- **A grant issued but not collected reports its `grantId`.** The quota is spent
  either way and no function gives it back, so retry the *collection*, never the
  request.

### Being a resource provider

The other end of the same conversation, and the one thing here you do have to
host: a service that watches `AccessGranted`, re-checks, and mints.

```ts
import {createResourceProvider} from '@votive/agent-skills';

const provider = createResourceProvider({
  read,
  registry: process.env.WELL_RESOURCE_REGISTRY!,
  issue: async ({grantId, resourceId, wallet, humanId}) => mintShortLivedKey(humanId),
  onRelease: (record) => log.info(record),        // never receives the credential
});

// On each AccessGranted(grantId, …):
const credential = await provider.release(grantId);   // null if the chain now says no
```

Re-checking matters: a grant records entitlement at the moment it was issued, and
what governs handing over a key is entitlement *now*. An operator barred in between
collects nothing, and no credential is minted at all, so there is nothing to revoke
afterwards.

**Which wallet the credential is scoped to comes from `grantOf`, not from
whoever handed you the id.** `AccessGranted` is a public event, so a grant id is
public knowledge and proves nothing about its bearer — and `isGrantReleasable`
cannot catch the substitution, because it validates the grant's *stored* wallet and
never sees the claim.

### Screening — the stop before the start

```ts
import {screenWish, toConductReport, ConductCategory} from '@votive/agent-skills';

const result = await screenWish(wishText, {classifier: myModelClassifier});
if (result.verdict !== 'clear') {
  const report = toConductReport(result, evidenceHash);   // arguments, not a transaction
}
```

**It fails closed.** An empty or unreadable wish is refused, not waved through, and
a classifier that throws falls back to the patterns rather than to "clear".

**It never decides the penalty.** The screen names a category; `StandingLedger`
decides what that category costs, and the categories describing harm to people
carry a floor no reviewer can file below. `toConductReport` hands a person the case
— filing it bars a human across every wallet they will ever hold, and this package
does not do that on a regex match.

### Identity — mirroring AgentBook onto the protocol's chain

```ts
import {createAgentBook, planAttestation, AssuranceTier} from '@votive/agent-skills';

const book = await createAgentBook({rpcUrl: WORLD_CHAIN_RPC});
const plan = await planAttestation(wallet, {
  book,
  assurance: AssuranceTier.Device,     // what you actually evidenced, never inferred
  evidenceHash,
});
// plan.calldata is ready for HumanBackingRegistry. Nothing was signed or sent.
```

`planAttestation` returns a plan and never broadcasts. Whoever holds the attestor
key decides when to send, and can see exactly what would be written first.

### Getting paid — the bounty rail

`AgentBountyRail` is the settlement side: a funder escrows a reward, an agent claims
the task exclusively for a window, and each attested milestone releases its slice.
Earnings are credited and withdrawn in one call rather than pushed per milestone.

`BountyClient` is an interface **you implement** — this package never signs. What it
gives you is the calldata:

```ts
import {railCalldata} from '@votive/agent-skills';

railCalldata.claim(7n);        // 0x379607f5…
railCalldata.withdraw();       // 0x3ccfd60b
railCalldata.credited(payout); // 0xfdf60ec7…
```

Two things the rail enforces that you cannot work around, and should not try to:

- `claim` reverts unless `standing.mayWork(msg.sender)` — human-backed and not
  barred — on a deployment whose rail was constructed with a standing adapter. Not
  every deployed rail was; ask the rail (`standing()`) rather than assuming.
- `release` is permissionless but reverts `MilestoneNotAttested` unless the
  attestation registry the rail names says the milestone is met. Read that address
  off the rail with `registry()`, never from your own config — two registries can
  both accept the same attestor, and attesting to the wrong one *succeeds* and then
  reverts at release.

See `contracts/src/bounties/AgentBountyRail.sol` and `deployments/testnet.md`.

## The two instruction forms

| form | meaning |
|---|---|
| `pay:<accountId>:<hbar>:<memo…>` | send HBAR to an account |
| `buy:<url>:<maxHbar>:<memo…>` | buy one use of an x402-priced service, never paying above the cap |

They are strings because they are *signed* — part of the wish, not something a
model composes at run time. A model that invents an account id produces a parse
failure and nothing moves.

## Three things worth knowing

**The x402 cap is enforced before paying.** A service that answers 402 asking for
more than was authorised gets nothing and is never retried. The agent does not get
to decide the job was worth more than it was told.

**A payment is not done until the mirror node says so.** The node that accepted a
transaction is not the same thing as the network agreeing to it. And a mirror node
lags consensus by a few seconds, so a 404 is treated as *not yet* and retried with
backoff — because an agent that wrongly believes its payment failed will pay twice.

**Amounts never go through a float.** Tinybars are 8 decimals; `0.3` HBAR is
`30000000` exactly, via fixed-point strings.

## Testing an agent without credentials

`HederaRail` is an interface. Pass any implementation — `test/fakeRail.ts` in this
package is a complete one that records what it was asked to do and moves nothing.

```ts
const {rail, transfers} = fakeRail();
await payHbar(rail, 'pay:0.0.4242:2:supplier');
// transfers[0].tinybars === 200000000n
```

`ChainReader` is likewise just a function, so the standing and resource views can be
driven from a table of canned `eth_call` answers — see `test/exports.test.ts`.

## Scripts

```bash
npm run build      # tsc; also runs automatically on install, via `prepare`
npm test           # builds, then runs against the built output
npm run typecheck
```
