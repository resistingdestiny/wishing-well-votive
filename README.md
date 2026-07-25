# Votive

Park crypto against a job today's AI can't do yet. On every new model release the
frontier takes another run at it; the moment it can, your wish fills and the money
goes to work. Until then it accumulates in its own segregated on-chain cell — for
years, if it has to.

- **Wishes** — a plain-language story, parsed into a signed schema, funded by wallet
  or ordinary money.
- **The frontier** — a public, signed record of what each model can and can't do.
- **Agents & resources** — build agents, serve models, and commit resources to a
  shared pool; providers share in the revenue.

## Stack

Next.js (App Router) · wagmi/viem · Prisma/Postgres · TypeScript.

## Develop

```bash
pnpm install
cp .env.example .env      # fill in DATABASE_URL + chain addresses
pnpm db:push
pnpm dev                  # http://127.0.0.1:3100
```

## Build

```bash
pnpm build && pnpm start
```

---

## The on-chain protocol

Lives in [`contracts/`](contracts/).

**Fund a wish today, release it the day it becomes possible.**

A votive is an offering made in fulfilment of a vow. Here it is a contract: you
park value, you write down what has to become true, and the money sits in its own
segregated vessel until an oracle attests that the world (or a model) can finally
deliver it. If that day never comes, the vow still has an ending — you can redirect
it, a guardian can redirect it on your behalf after long silence, or it escheats to
a destination you named up front.

This repository is the protocol. Milestone 1 is the Solidity core; integrations
land afterwards, each behind its own pull request.

---

## The three invariants

Everything in `contracts/src` exists to hold these three lines. A change that
weakens any of them is a bug, no matter how convenient.

1. **Segregation.** One `Votive` contract per wish. Value is never pooled, never
   rehypothecated, never lent between wishes. A votive can only ever pay out
   what it itself holds.
2. **Fee transparency.** Every votive freezes its own fee terms at creation and
   can never charge more than them. Terms are two numbers — a streaming rate on
   parked principal and a performance rate on gains above principal — both bounded
   by constants in the bytecode. There is no privileged path that moves value out
   of a votive outside the published schedule.
3. **Intent control.** Execution runs off the signed `Intent` struct, never off
   the prose that produced it. Redirecting a votive requires the founder's
   authority (directly or by signature), or a named guardian after a long
   inactivity window. Escheat requires a longer one. A sealed votive forecloses
   redirection entirely.

## How it works

```
                        ┌─────────────────────────────────────────┐
   founder ──create──▶  │  Votive  (one contract, one wish)       │
                        │                                         │
   anyone  ──offer───▶  │  principal   ── streaming fee ──▶ treasury
                        │  offerings   ── performance fee ─▶ treasury
                        │                                         │
   executor ─attempt─▶  │  Pending → Waiting → Attempting → ...   │
                        └─────────────────────────────────────────┘
                                    ▲                  │
                          capability│gate         payout│per Intent
                                    │                  ▼
                      AttestationRegistry       beneficiary / guardian
                                                / fallback / escheat
```

**Lifecycle.** `Nascent` (a deployed but unopened clone) → `Waiting` →
`Attempting` → one of `Fulfilled`, `Redirected` or `Escheated`. `Waiting` and
`Attempting` are the live states; everything past them is terminal, and there is
no path back.

**One contract per wish, cheaply.** Each votive is an EIP-1167 clone of a single
immutable implementation, so opening one costs a proxy deployment rather than a
redeployment of the protocol — and the factory's own bytecode does not grow as the
protocol does. The implementation address is immutable in the factory on purpose:
the fee ceilings and clock floors compiled into it should not be only as durable
as an owner's key.

**Capability gate.** A votive names a `capabilityId` — the identifier of a check
that some model has to pass before anyone is allowed to attempt the wish. The
`AttestationRegistry` records pass/fail per (capability, model) and counts the
models currently passing. The gate opens on the first pass and stays open while
any model still holds it: a later, weaker model failing the same check can never
close a capability another model has already demonstrated. Failures are recorded
on purpose — they are the benchmark record.

**Release condition.** Separately from *can it be done*, a votive names a
`conditionHash` — *has it been done*. Fulfilment requires an attestation that the
condition is met for this specific votive.

**Fee schedule.** Two rates, quoted by the factory and frozen into the votive at
the moment it opens:

| | default | ceiling | basis |
|---|---|---|---|
| streaming | 2 % / yr | 5 % / yr | committed principal, accrued continuously, capped lifetime at principal |
| performance | 8 % | 20 % | offerings above principal, taken once at settlement |

Top-ups raise principal and are never performance-charged. Offerings — anything
anyone else sends — are, at settlement, and only the amount above principal.
Escheat charges no performance fee at all: the fee is for delivering a wish, and
an escheat delivers nothing.

Repricing the factory affects only future votives. An existing votive holds its
own terms and there is no code path that rewrites them. Founders pass the worst
terms they will accept when they open, so a repricing landing in the same block
cannot quietly become the deal they agreed to.

**Remedies.** A votive that has outlived its point can be *redirected* by its
founder at any time, or by a named guardian after a long silence. One that nobody
ever comes back for *escheats*, permissionlessly, to the destination its founder
named — or to the treasury as a backstop. A votive marked irrevocable forecloses
redirection entirely, and may not name a guardian, since a guardian's only power
would be one it could never use.

## Repository layout

```
contracts/          Foundry project — the protocol
  src/              Solidity sources
  test/             unit, fuzz and invariant tests
  script/           deployment scripts (no addresses committed)
STATE.md            current status, cold-start accurate
CHANGELOG.md        what shipped, per release
```

## Working on it

```bash
cd contracts
forge build            # compile
forge test             # unit + fuzz + invariant
forge fmt --check      # formatting
forge coverage         # line coverage
```

Requires [Foundry](https://book.getfoundry.sh/getting-started/installation).
Dependencies (`forge-std`, `openzeppelin-contracts`) are git submodules — clone
with `--recurse-submodules`, or run `git submodule update --init --recursive`.

## Scope

Testnet only. No mainnet deployment, no real funds, no production KYC vendor
(the gate is an interface with a permissive default), no token.

## License

MIT. See [LICENSE](LICENSE).
