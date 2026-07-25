# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until `1.0.0` the on-chain interfaces are unstable and may change between minor
versions.

## [Unreleased]

### Added

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
