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

**Three kinds of wish.** `ReleaseOnCondition` pays a named beneficiary (the
founder, if none was named). `RealWorldTask` reimburses whoever went and did the
thing, up to a ceiling the founder agreed to, and sends the rest where a release
would have gone. `ShareWithActive` is a wish for everyone still waiting: the
settled value is allocated across the votives that were open at a snapshot block,
in proportion to what each had parked, and each one pulls its own slice. Fees
settle on chain *before* the allocation is recorded, so a mis-computed allocation
can mis-address value but can never overcharge or overdraw — and the attestor can
correct it during a challenge window, before any of it can be claimed.

**Fee schedule.** Two rates, quoted by the factory and frozen into the votive at
the moment it opens:

| | default | ceiling | basis |
|---|---|---|---|
| streaming | 2 % / yr | 5 % / yr | committed principal, accrued continuously, capped lifetime at principal |
| performance | 8 % | 20 % | offerings above principal, taken once at settlement |

Top-ups raise principal and are never performance-charged. Offerings — anything
anyone else sends — are, at settlement, and only the amount above principal.
Every route out — fulfil, redirect, escheat — pays the same two rates. There is no
cheaper exit, and in particular no way to reach one by doing nothing.

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

## Deployments

Testnet only, currently live. Every address below is produced by a deployment
script — recorded here as a deployment *record* so a reviewer can go and look at
the thing rather than take a claim on trust. Per-wish votives are EIP-1167 clones
of the implementations below and are not listed individually.

### Base Sepolia — chain 84532

The protocol, the World human-backing layer, and the 1inch Aqua integration.

| contract | address — **in use now** | redeployed & verified (standby, not wired in) |
|---|---|---|
| `VotiveFactory` | [`0xc673B8DEf8d1A73FE6962373126dBC6a3a903301`](https://sepolia.basescan.org/address/0xc673B8DEf8d1A73FE6962373126dBC6a3a903301#code) | [`0x9d37fAd3F07cb4B655a5C27BD20251335FA7E222`](https://sepolia.basescan.org/address/0x9d37fAd3F07cb4B655a5C27BD20251335FA7E222#code) ✅ |
| `AttestationRegistry` | [`0x9620b2BD26e367eD84769FdA064790B08Bf6dA65`](https://sepolia.basescan.org/address/0x9620b2BD26e367eD84769FdA064790B08Bf6dA65#code) | [`0xc31903AC19B7F5bB038d435c3739F850Df580edA`](https://sepolia.basescan.org/address/0xc31903AC19B7F5bB038d435c3739F850Df580edA#code) ✅ |
| `OpenAccessGate` | [`0xC8cE1765643A0eeFB2C4EFa67F424914a584324d`](https://sepolia.basescan.org/address/0xC8cE1765643A0eeFB2C4EFa67F424914a584324d#code) | [`0xe1Fb9283B2Cd58d147Aad4689eaa01A26Dc2a8d6`](https://sepolia.basescan.org/address/0xe1Fb9283B2Cd58d147Aad4689eaa01A26Dc2a8d6#code) ✅ |
| `HumanBackingRegistry` | [`0xcFc7c7F7D5d0F42233cfFE6Ec0FDB7aDF2c093ad`](https://sepolia.basescan.org/address/0xcFc7c7F7D5d0F42233cfFE6Ec0FDB7aDF2c093ad#code) | [`0x84aB2B0d9Dd87ff3ce21aAa386e91E1d2A98c2fb`](https://sepolia.basescan.org/address/0x84aB2B0d9Dd87ff3ce21aAa386e91E1d2A98c2fb#code) ✅ |
| `StandingLedger` | [`0xC42b36D39BAC7f42d62Ec1c6827f2687d724b59f`](https://sepolia.basescan.org/address/0xC42b36D39BAC7f42d62Ec1c6827f2687d724b59f#code) | [`0x8a7A0c7d4CF4108ef6b76A3234Bab5B48aCEE23c`](https://sepolia.basescan.org/address/0x8a7A0c7d4CF4108ef6b76A3234Bab5B48aCEE23c#code) ✅ |
| `AgentStandingAdapter` | [`0xE873C3d53f494D02A30c3dcd8e5f6D6Ae2Ee36a5`](https://sepolia.basescan.org/address/0xE873C3d53f494D02A30c3dcd8e5f6D6Ae2Ee36a5#code) | [`0xB9db579a3e9d27b8b80C14B3552c168198D2C2c9`](https://sepolia.basescan.org/address/0xB9db579a3e9d27b8b80C14B3552c168198D2C2c9#code) ✅ |
| `CommonsPool` | [`0x792f6E552363A7110FB9495D2B754868D742eB97`](https://sepolia.basescan.org/address/0x792f6E552363A7110FB9495D2B754868D742eB97#code) | [`0x3fa74D93A4F202E814AD672C03D4448547c2c3Db`](https://sepolia.basescan.org/address/0x3fa74D93A4F202E814AD672C03D4448547c2c3Db#code) ✅ |
| `HumanBackedAccessGate` | [`0xeC0129807b8650f2f582Bd484b592f8376e6fa37`](https://sepolia.basescan.org/address/0xeC0129807b8650f2f582Bd484b592f8376e6fa37#code) | [`0x1D7409185Ad221D3D864b32E6FEEa8863875baBa`](https://sepolia.basescan.org/address/0x1D7409185Ad221D3D864b32E6FEEa8863875baBa#code) ✅ |
| `ResourceRegistry` | [`0x379c25Ec56984D93b22A87a74EB8418200b99d38`](https://sepolia.basescan.org/address/0x379c25Ec56984D93b22A87a74EB8418200b99d38#code) | [`0x0F92924153936bA74e6B4730298ca7332851549b`](https://sepolia.basescan.org/address/0x0F92924153936bA74e6B4730298ca7332851549b#code) ✅ |
| `AgentBountyRail` (standing-gated) | [`0x75A59872882C8F39931c762eb7887e1902838924`](https://sepolia.basescan.org/address/0x75A59872882C8F39931c762eb7887e1902838924#code) | [`0xf787575F83F7B17b150528C492cd5e6CB55b41A5`](https://sepolia.basescan.org/address/0xf787575F83F7B17b150528C492cd5e6CB55b41A5#code) ✅ |
| `Aqua` (official 1inch, unmodified) | [`0x3e5c9d946B8f6771e610E316b5BA87bd9b429910`](https://sepolia.basescan.org/address/0x3e5c9d946B8f6771e610E316b5BA87bd9b429910#code) | — not redeployed |
| `VotiveAquaRouter` (7 votive opcodes appended) | [`0x71A5a6164Ce51F48796710100fEE0cEEB3E7287b`](https://sepolia.basescan.org/address/0x71A5a6164Ce51F48796710100fEE0cEEB3E7287b#code) | — not redeployed |
| `AquaVotive` (wish-as-vault implementation) | [`0xFe95dCE0E6c52396950404C893Fc1Fa1cd3A1cC7`](https://sepolia.basescan.org/address/0xFe95dCE0E6c52396950404C893Fc1Fa1cd3A1cC7#code) | — not redeployed |
| `VotiveToken` — VOTIVE (funding unit) | [`0x736655e2cEBB322D493b4219A6669C81bDe90001`](https://sepolia.basescan.org/address/0x736655e2cEBB322D493b4219A6669C81bDe90001#code) | — not redeployed |
| `VotiveToken` — vUSD (quote token) | [`0xdd22b0aff43419d73DbFd5377d24Cf23C1A08C51`](https://sepolia.basescan.org/address/0xdd22b0aff43419d73DbFd5377d24Cf23C1A08C51#code) | — not redeployed |
| `NativeVotive` (implementation, cloned per ETH-funded wish) | — not in the previous record | [`0xA71f6f2417C9F88E677eC196656F0FC16029a1aD`](https://sepolia.basescan.org/address/0xA71f6f2417C9F88E677eC196656F0FC16029a1aD#code) ✅ |
| `AquaVotive` (implementation, cloned per token-funded wish) | — not in the previous record | [`0x484752b99981952c6ff40E5ED07f77619D9F2CED`](https://sepolia.basescan.org/address/0x484752b99981952c6ff40E5ED07f77619D9F2CED#code) ✅ |
| `WishShare` (implementation, cloned per wish that sells claims) | — not in the previous record | [`0x7f999e3f1956a5987ceD561035ab6592b0678797`](https://sepolia.basescan.org/address/0x7f999e3f1956a5987ceD561035ab6592b0678797#code) ✅ |

**Which column the app uses.** The middle one, and it is read from
`.env.local` rather than from here. Note that the previous version of this table
listed a *different* earlier factory than the worktree the dev server runs from;
the addresses above are the ones the running app resolves. A full redeploy was made and every
contract in the right-hand column was verified on BaseScan — each ✅ was re-checked
against the Etherscan V2 API, which returned the expected contract name for all
thirteen, rather than being copied from the deploy log. It is **not** in use, and
reverting to it is not just an address swap: every existing wish and the Aqua demo
wish were created by the factory in the middle column, so `isVotive()` on the new
factory returns false for all of them and they would disappear from the site.

Three things about the standby deployment, so nobody has to read the chain to find
them out:

- Its factory's gate is `OpenAccessGate`, so anyone may open a wish.
  `HumanBackedAccessGate` is deployed and verified but deliberately not wired in —
  `factory.setAccessGate` changes who may open a votive and should be a decision,
  not a side effect of running a script.
- `ResourceRegistry` had to be redeployed with it: it takes the human registry and
  the standing ledger in its constructor, so an older one meters quotas against a
  registry in which no currently-attested agent exists. The three toolbelt
  resources are registered on the new one, keyed by `keccak256("resource:<slug>")`.
- The funding-token allowlist is a post-deploy step and easy to miss.
  `Deploy.s.sol` only calls `setTokenAllowed` when `VOTIVE_TOKEN` is set, so a run
  without it leaves every `openWithToken` reverting `TokenNotAllowed()`
  (`0xa29c4986`) while ETH-funded wishes work — which reads like a broken contract
  rather than missing configuration. VOTIVE and vUSD are allowlisted on both.

### Hedera Testnet — chain 296

Agentic payments. Agents settle real HBAR through the Hedera Payment Skill in the
agent SDK — a milestone-gated escrow rail, direct agent-to-agent transfers, and
x402 pay-per-request. Untouched by the Base redeploy.

| contract | address |
|---|---|
| `AgentBountyRail` | [`0x65E76108610933d69046b68070aFbc925B363e9e`](https://hashscan.io/testnet/contract/0x65E76108610933d69046b68070aFbc925B363e9e) |

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
