# STATE

Single source of truth for where this repository actually is. Cold-start
accurate: someone who has never seen the project should be able to read this
file and know exactly what exists, what is next, and what is blocked.

**Last updated:** 2026-07-25
**Current milestone:** M1 — protocol core (Solidity only)

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
- [ ] **3. Core votive** — `VotiveTypes`, `VotiveBase` (lifecycle, fee engine,
      settlement, redirect, escheat, owed ledger), `NativeVotive`,
      `VotiveFactory`.
- [ ] **4. Token votive** — `TokenVotive`, ERC-20 creation path, funding-token
      allowlist.
- [ ] **5. Multi-party settlement** — pro-rata distribution to the active set and
      the multi-beneficiary claim lifecycle.
- [ ] **6. Hardening** — invariant suite, deployment script, gas snapshot.

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
  because one recipient refuses value; the amount is credited to `owed` and that
  recipient pulls it later. Terminal transitions must not be blockable by their
  own beneficiaries.
