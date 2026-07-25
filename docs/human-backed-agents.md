# Human-backed agents

An agent working on Votive spends real money: it buys an API call, a dataset, a
compute run, another agent's time. That money comes from a shared pot. A shared
pot and anonymous agents are a bad combination — the optimal strategy against one
is always to register more agents — so something has to make an operator's budget
theirs rather than their wallet's.

That something is a proof of humanity. Not to know who anybody is; only to know
that two wallets are the same person.

## The shape

```
World Chain                   wherever the protocol runs
───────────                   ──────────────────────────
  AgentBook   ──attestor──▶   HumanBackingRegistry ──┐
  (AgentKit)                                         ├─▶ CommonsPool     (what you may spend)
                              StandingLedger ────────┼─▶ HumanBackedAccessGate (what you may open)
                              (record + bar)         └─▶ AgentBountyRail (what you may take on)
```

AgentKit answers one question: **which unique human is behind this wallet?** The
answer is an anonymous identifier — the same person always yields the same one,
however many agents they register, and nothing about them is recoverable from it.

An attestor mirrors that answer onto the chain the protocol runs on, because the
contracts holding the money cannot reach across to World Chain to ask. Everything
downstream keys on the human, never on the wallet.

## Why keying on the human is the whole design

Three properties fall out of that one choice, and none of them is available to a
system that keys on addresses:

**One operator, one budget.** Ten agents get you no more than one, because all ten
resolve to the same identifier and spend from the same epoch allowance. Registering
more wallets is not a strategy.

**A bar cannot be escaped by rotating keys.** Somebody whose wish asked for a person
to be killed is barred, and a fresh keypair attested to them opens nothing. This is
the property an address-keyed reputation system cannot have at all.

**Standing survives rotation in the other direction too.** An operator who retires an
agent and starts a new one keeps what they earned.

## What an operator earns, and what they cannot

Two separate axes, deliberately multiplicative:

| | what it is | how it moves |
|---|---|---|
| **assurance** | how strongly the humanity claim is evidenced | device ×0.25, selfie ×1, orb ×2 |
| **standing** | what the track record is worth | ×0.25 to ×3, from deliveries and failures |

Neither substitutes for the other. The strongest evidence with a bad record draws
little; a spotless record on a device-only signal also draws little. And above a
step-up threshold, no record at all is enough without the strongest evidence —
past performance is not proof that a person is still on the other end.

The step-up is measured against the epoch's **running total**, not a single draw.
Writing the tests showed a per-draw check is no control: an operator wanting twice
the threshold simply asks twice. Cumulative also closes the same trick spread
across several wallets, because the total belongs to the human.

## Conduct, and the line the mechanism will not cross

A conduct report carries a **category** and a **severity**, and the category sets a
floor the reviewer cannot file below. Violence, exploitation and mass-harm requests
are `Critical` however they are graded — so a reviewer's mis-grade fails safe
rather than leaving the operator drawing from the commons the next block.

Three limits, all deliberate:

- **Standing cannot buy past a bar.** Five hundred deliveries after a critical report
  still leave the multiplier at zero. Wiring reputation into the bar would let an
  operator pre-purchase impunity by farming easy wishes.
- **A bar is an exclusion, not a fine.** Money already earned still withdraws. A rail
  that confiscated settled earnings is one nobody sane would work for.
- **Votives that already exist are untouched.** Admission is checked at creation and
  never re-checked. Money committed to a wish belongs to that wish; making a bar
  reach back into pledged funds would turn an admission policy into a confiscation
  power.

Failure is not misconduct. Attempting hard things and missing is the normal shape
of this work: it costs headroom and leaves a floor to climb back from. And handing
a task back yourself costs nothing at all, because charging for that would teach
agents to sit on claims until the window ran out.

## Screening, which is off-chain because it has to be

No contract can read a wish and tell that it asks for somebody to be hurt. So
`votive_screen_wish` runs before an agent claims anything. It fails closed — an
unreadable wish is refused, and a classifier that throws falls through to patterns
rather than to approval — and it **names a category without deciding a penalty**.
Filing a report bars a human across every wallet they will ever hold; that is not
something a regex should be able to do alone.

The patterns match the request, not the topic. A war memoir, nerve-agent
epidemiology and a homicide-statistics dataset all pass; an earlier draft refused
two of them, which is why the false-positive cases are tested as heavily as the
true ones.

## Rate limiting that comes from the chain

AgentKit asks a resource server one question before granting access:
`tryIncrementUsage(endpoint, humanId, limit)`. The stock backing counts in memory
against a config value — that is how you build a free trial or a discount.

Votive answers it from its own on-chain state instead:

- a **barred** operator gets nothing, whatever limit the endpoint asked for;
- the limit is **earned** — the caller's number is a baseline, scaled by standing.

So the rate limit is Sybil-resistant and revocable for conduct, rather than a
reward for having proved you are a person.

## Prize compliance — AgentKit New Use Cases

| requirement | where |
|---|---|
| "Uses AgentKit in a meaningful way" | `sdk/src/world/agentBook.ts` resolves through `createAgentBookVerifier`; `sdk/src/world/attestor.ts` mirrors it on-chain; `sdk/src/world/rateLimit.ts` implements `AgentKitStorage` |
| "Verifies an agent is human-backed" | `HumanBackingRegistry` + `HumanBackedAccessGate`; verified live against World Chain |
| "Shows a working end-to-end flow, not just a wrapper" | deployed to Base Sepolia; `ops/world-live-test.sh`, 17 checks, all passing on chain |

The track's description names *access control, authorization, rate limits, economic
terms, payments, moderation, accountability*. This is those, from one signal.

**On the exclusion list.** The rules exclude "agent reputation systems" and
"human-backed benefits for AI agents (API call discounts)" as prior-hackathon
patterns. This is deliberately neither:

- nothing here is a discount — no agent pays less for anything;
- the reputation score is the *smaller* half. The load-bearing parts are the
  per-human commons and a bar that survives key rotation, and both work with the
  multiplier pinned at parity;
- the novel mechanism is that **standing and exclusion are keyed to a human rather
  than an address**, which is what makes the bar hold at all. An address-keyed
  version of this is defeated by generating a keypair.

Judge it on the barring, not on the score.
