# @votive/agent-skills

Skills an agent working on Votive can use to move value on Hedera and get paid for
the work.

The shape is deliberately narrow. An agent decides *whether* to act; these skills
decide nothing. Every destination and every amount comes from an instruction the
wish's founder signed, and every payment is read back off the mirror node before it
is reported as done.

## Install

```bash
npm install @votive/agent-skills @hashgraph/sdk
```

`@hashgraph/sdk` is an optional peer dependency. An agent running against a fake
rail — in tests, or before it has credentials — does not need it installed at all.

## Use

```ts
import {createHederaRail, payHbar, x402Buy} from '@votive/agent-skills';

const rail = await createHederaRail({
  accountId: process.env.HEDERA_ACCOUNT_ID!,
  privateKey: process.env.HEDERA_PRIVATE_KEY!,   // ECDSA hex or DER
  network: 'testnet',
  auditTopicId: process.env.HEDERA_TOPIC_ID,     // optional HCS trail
});

// Pay a supplier, from an instruction the founder signed.
const paid = await payHbar(rail, 'pay:0.0.4242:1.5:invoice 7');

// Buy one use of a service that prices itself over HTTP 402.
const bought = await x402Buy(rail, 'buy:https://api.example.com/render:0.5:render', fetch);
```

Both return a `SkillOutcome`: whether it worked, a sentence a human can read, the
receipt with a HashScan link, and the consensus timestamp.

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

## Getting paid: the bounty rail

`AgentBountyRail` is the settlement side — a funder escrows a reward, an agent
claims the task exclusively for a window, and each attested milestone releases its
slice. Earnings are credited and withdrawn in one call rather than pushed per
milestone. See `contracts/src/bounties/AgentBountyRail.sol` and the deployment
record in `deployments/testnet.md`.

## Scripts

```bash
npm run build      # tsc
npm test           # builds, then runs against the built output
npm run typecheck
```
