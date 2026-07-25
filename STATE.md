# STATE

Single source of truth for where this repository actually is. Cold-start
accurate: someone who has never seen the project should be able to read this
file and know exactly what exists, what is next, and what is blocked.

**Last updated:** 2026-07-25
**Current milestone:** M1 — protocol core (Solidity only) — **complete**, 208 tests green

---

## Milestone map

| # | Milestone | Status |
|---|-----------|--------|
| M1 | Protocol core — segregated votives, fee engine, lifecycle, oracle | in progress |
| M2 | Sponsor integrations — each behind its own PR | not started |
| M3 | Off-chain runtime + surfaces | not started |

M2 covers exactly four integrations and nothing else: Hedera, 1inch, Aqua and
World. Anything outside that list is out of scope for this repository.

---

## M1 — protocol core

Each line is one pull request. Nothing lands on `main` with a stub, a TODO, or a
failing test.

- [x] **1. Scaffold** — Foundry project, pinned toolchain, dependency submodules,
      CI, license, docs skeleton.
- [x] **2. Attestation layer** — `AttestationRegistry` (capability attestations
      per model, release-condition attestations per votive, votive→capability
      binding), `IAccessGate` + `OpenAccessGate`.
- [x] **3. Core votive** — `VotiveTypes` + `VotiveLimits`, `VotiveBase`
      (lifecycle, fee engine, settlement, redirect, escheat, deferred ledger),
      `NativeVotive`, `VotiveFactory`. 152 tests.
- [x] **4. Token votive** — `TokenVotive`, ERC-20 creation path, funding-token
      allowlist. 175 tests.
- [x] **5. Shared settlement** — the `ShareWithActive` wish kind: Merkle
      allocation over the live set, challenge window, claim window, leftover
      sweep, and the factory view the snapshot is built from. 196 tests.
- [x] **6. Hardening** — invariant suite over randomised histories, deployment
      script with no addresses in it, contract-size guard. 208 tests.

### Deliberately not in M1

- **Multi-beneficiary and identity claims** — a votive whose payout is split
  across a wisher-signed set of beneficiaries, where a beneficiary may be a wallet
  *or* a person who has to come forward and prove who they are. The wallet half is
  a straightforward extension of the shared-settlement machinery; the identity half
  is inseparable from proof-of-personhood, so it belongs with the World
  integration in M2 rather than being half-built here.

## M2 — integrations (not started)

Deliberately empty until M1 is green. Each integration is additive: it must not
change any fee already quoted to an existing votive, and must fail closed if the
integrated system is unavailable.

- [ ] Hedera
- [ ] 1inch
- [ ] Aqua
- [ ] World

---

## Conventions in force

- Solidity `0.8.28`, EVM target `cancun`, optimizer on (200 runs).
- `deny = "warnings"` in `foundry.toml` — a compiler warning fails the build.
- Conventional commits. One feature per branch, one branch per pull request.
- No contract address, deployment record, or key material is ever committed.
  `script/` produces addresses at run time; it never hardcodes them.

## Blocked

Nothing is blocked.

## Decisions worth remembering

- **Fee terms are per-votive immutables, not global constants.** The factory
  holds the *default* terms; each votive copies them into immutables at
  construction and can never be repriced afterwards. Changing platform pricing
  therefore affects only future votives — existing ones are frozen at the terms
  their founder agreed to. Hard ceilings live in the votive bytecode so even a
  compromised factory owner cannot quote terms above them.
- **The capability gate is monotonic.** It counts *distinct models whose latest
  attestation is a pass*, rather than storing one global boolean. Without this, a
  newly-released weak model failing an eval would slam shut a gate that a strong
  model had already opened.
- **Payouts push, then fall back to a pull ledger.** A settlement never reverts
  because one recipient refuses value; the amount is credited to `deferred` and
  that recipient pulls it later at full gas. Terminal transitions must not be
  blockable by their own beneficiaries.
- **Votives are EIP-1167 clones of one immutable implementation.** Opening a wish
  costs a proxy deployment, not a redeployment of the protocol, so small votives
  are viable; and the factory's bytecode does not grow with the protocol, so the
  contract-size limit never becomes an architectural constraint. The
  implementation reference is immutable in the factory — otherwise the fee
  ceilings compiled into it would only be as durable as the owner's key.
- **The streaming fee is charged against committed principal, not the declining
  balance.** Charging the declining balance makes the total depend on how often
  somebody happens to call `accrue`, which is not a property a fee schedule should
  have. What is left is a wei of truncation per accrual, always rounding towards
  the founder.
- **Founders pass the worst terms they will accept.** `open` applies the factory's
  current terms and reverts if they exceed the caller's ceiling, so a repricing
  landing in the same block cannot become the deal somebody thought they signed.
