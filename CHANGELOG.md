# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until `1.0.0` the on-chain interfaces are unstable and may change between minor
versions.

## [Unreleased]

### Added

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
