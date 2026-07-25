# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until `1.0.0` the on-chain interfaces are unstable and may change between minor
versions.

## [Unreleased]

### Fixed

- **A share allocation naming `address(0)` burned its slice silently.** A transfer
  to the zero address succeeds at the EVM level, so the value left the votive with
  no revert, no deferral, and an event indistinguishable from an ordinary claim.
  `claimShare` now refuses it, and the slice stays in the pot.
- **A share allocation naming the votive itself stranded its slice for good.** The
  push failed into `deferred[address(this)]`, which nothing can ever claim.
  Reachable by griefing: open a cheap votive whose beneficiary is a live shared
  votive and its address turns up in `liveShares`. Also refused now.
- **`escheat` let a founder dodge the performance fee.** Naming yourself as
  `fallbackTo` and taking the minimum ninety-day clock produced the same outcome as
  a redirect for no performance fee at all — waiting was strictly cheaper than
  asking. Escheat now pays the full schedule like every other exit, and the flag
  that allowed a partial one has been removed rather than defaulted.
- **`recoverToken` could be made to walk off with the principal.** It compared
  addresses, so a funding token with a second entry point over the same balance
  store passed the guard — turning a permissionless rescue function into a
  fee-free withdrawal of the whole principal from a `Waiting` votive. It now
  measures the funding balance across the transfer and refuses any movement in it.

### Added

- Hardening: an invariant suite checking ten properties against randomised
  histories — segregation (no votive ever holds more than was sent to it), value
  conservation, the fee ceilings, and agreement between the factory's live set and
  each votive's own state. Plus a deployment script with no address written in it,
  and a contract-size guard that fails the build rather than a testnet.
- `ShareWithActive` — a third wish kind, for wishes meant for everyone still
  waiting. `fulfilBySharing` settles the fee schedule on chain and *then* records
  a Merkle allocation over the live set, weighted by what each votive had parked;
  recipients pull their own slice. An hour-long challenge window lets the attestor
  correct a mis-computed allocation before any of it can be claimed, every claim is
  clamped to what remains in the pot, and after ninety days whatever nobody
  collected goes back to the founder. `VotiveFactory.liveShares` publishes the
  snapshot the allocation is built from, so the executor's arithmetic is
  reproducible by anyone.
- `TokenVotive` — a votive funded in a single ERC-20, plus `openWithToken` and an
  owner-curated funding-token allowlist on the factory. The funding token is
  captured at creation and never re-read, so de-listing blocks new votives
  without disturbing existing ones. Principal is the measured balance, and the
  optimistic push tolerates tokens that return nothing, return a dirty word, or
  refuse a blocklisted recipient — none of which can wedge a settlement.
- `VotiveBase` — the protocol core: the `Nascent → Waiting → Attempting →
  {Fulfilled | Redirected | Escheated}` state machine, the two-rate fee engine,
  settlement, the redirect and escheat remedies, EIP-712 signed redirects with
  ERC-1271 support, and the deferred-payout ledger. Value leaves a votive through
  four doors and no fifth: `settleStream`, settlement, `claimDeferred`,
  `sweepStray`.
- `NativeVotive` — the native-asset votive. Supplies four asset hooks and nothing
  else, so the ETH and token votives cannot drift apart in behaviour.
- `VotiveFactory` — opens votives as EIP-1167 clones of one immutable
  implementation, tracks the live set in constant time, and holds the
  protocol-wide settings. Founders declare the worst terms they will accept, so a
  repricing cannot be sandwiched onto an opening.
- `VotiveTypes` and `VotiveLimits` — the shared vocabulary, and the outer bounds
  on what a votive may ever be opened with, in one place so the factory that
  quotes them and the votive that enforces them cannot drift.
- 152 tests across lifecycle, fees, redirects, escheat, payout failure modes and
  factory administration, including fuzzed value-conservation and fee-ceiling
  properties.

- `AttestationRegistry` — the protocol's record of what has been demonstrated and
  what has come true. Stores capability verdicts per (capability, model) and
  release-condition verdicts per (votive, condition), binds each votive to the
  capability it requires, and exposes the two gates the protocol reads:
  `isCapabilityOpen` and `isConditionMet`. Attestor and factory keys are
  rotatable by a two-step owner; the registry never custodies funds.
- `IAccessGate` and `OpenAccessGate` — the admission check consulted once at
  creation, with a stateless, ownerless, permit-everyone default.
- Foundry project scaffold: pinned Solidity `0.8.28` / `cancun`, optimizer at 200
  runs, warnings promoted to build errors, fuzz and invariant profiles, and a
  heavier `ci` profile.
- `forge-std` and `openzeppelin-contracts` v5.4.0 pinned as git submodules.
- Continuous integration: build, format check, and the full test suite on every
  push and pull request.
- Repository documentation: `README.md` (protocol overview and invariants),
  `STATE.md` (cold-start status), this changelog, and an MIT license.
