# Deployments

Testnet only. Every address below was produced by `script/Deploy.s.sol`, which
hardcodes nothing — these are recorded here as a deployment *record*, so a
reviewer can go and look at the thing rather than take a claim on trust.

## Base Sepolia — chain 84532

| contract | address |
|---|---|
| `AttestationRegistry` | `0x2d90442d8b3884771dCb5a5fe823656B9C010810` |
| `VotiveFactory` | `0x3fb2EE8098340a4621D3984FCf0Cd3e911059A6A` |
| `OpenAccessGate` | `0x683cda08FdF4f8072f355154CD97E699976eB3F2` |
| `NativeVotive` implementation | `0xDFF08A003df0c6E14553Cd4dAb44b72004B9Db16` |
| `TokenVotive` implementation | `0xe5660B81C2253B37616DD096A9d18716733bD957` |

A votive taken through its whole life on chain:
`0x9853cDa2faDFEa0F960B61A2d4E5bb1D5B5E754d` — opened, capability attested,
attempted, condition attested, fulfilled. It accrued 74,835,108 wei of streaming
fee, which is 118 seconds of 2 %/yr on 0.001 ETH: the fee engine agrees with a
real clock to the wei.

## Hedera testnet — chain 296

| contract | address |
|---|---|
| `AttestationRegistry` | `0xa96E37110ab17ca161cd63c8066cec672Ea7eA08` |
| `VotiveFactory` | `0x2caFE5706b6Ff129CaEbb92DE1d7fEE7009b6BA0` |
| `OpenAccessGate` | `0x85e3FE4b01b5Ae5A4bC4Db7c2F9d1aAAd1A4B2E8` |
| `NativeVotive` implementation | `0x348FE66FAF6f63d71986399948BD28654BdB523F` |
| `TokenVotive` implementation | `0xd63db838D0f7150a49c6e27Ed72a80991BcA113c` |

Lifecycle proven on `0x66293C4560ef31F748D4FB6E747880aE5Eb28F15` — opened with
1 HBAR, attested, attempted, fulfilled.

### AgentBountyRail — agentic payments

| contract | address |
|---|---|
| `AgentBountyRail` | `0x65E76108610933d69046b68070aFbc925B363e9e` |

A complete agent payment cycle, executed on Hedera testnet with real HBAR:

| step | on-chain result |
|---|---|
| `registerAgent` | agent's payout address recorded |
| `attestCapability` | the frontier gate opened for the task |
| `postBounty` (3 ℏ) | `escrowed() == 300000000` tinybar |
| `claim` | agent took the exclusive claim |
| `release` × 3 | `credited` walked 1 ℏ → 2 ℏ → 3 ℏ |
| `withdraw` | `credited == 0`, rail balance `0`, `creditedTotal == 0` |

Final state: `earned == 300000000`, `milestonesDelivered == 3`, `escrowed() == 0`.
Three separate on-chain payments, each gated on its own attestation, settled to a
payout address the agent nominated — and one withdrawal to collect them, which is
the reason earnings are credited rather than pushed.

### One thing to know about Hedera

`eth_getBalance` reports 18 decimals while the EVM itself denominates `msg.value`
and `address(this).balance` in tinybars, at 8. So on Hedera a votive funded with
1 HBAR reads `principal() == 1e8` while `cast balance` reads `1e18`, and the two
look like they disagree by ten orders of magnitude.

They do not. `offerings()` returns 0 on that votive, and `offerings()` is computed
as *held minus parked minus unpaid fee* — so the contract's own view of its balance
matches its principal exactly. The mismatch is entirely in how the JSON-RPC layer
presents the number. Nothing in the protocol compares an RPC-reported balance
against an internal figure, so nothing is affected; but do not add code that does.

## Reproducing

```bash
# deploy
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" --private-key "$PK" --broadcast --slow

# exercise every route reachable without waiting out a real clock
RPC_URL=... PK=... FACTORY=0x... REGISTRY=0x... ./ops/live-test.sh
```

Hedera needs `--legacy`; it does not price EIP-1559 transactions the way Base does.

---

# Human-backing layer — Base Sepolia

Deployed 2026-07-25. Throwaway keys; nothing here custodies anything worth taking.

| contract | address |
|---|---|
| `HumanBackingRegistry` | `0x46C1a6e212701724C1802211d09c0581B3d777C7` |
| `StandingLedger` | `0xDD9F86CB8893BFc440B5FF9Ff79BA757AD6fd2d7` |
| `AgentStandingAdapter` | `0x1F4b09a2d352eabCCFc5d1dCE4dDa89C28C7b52d` |
| `CommonsPool` | `0xC5CA17f63bA972c98B05786e04B1e194ABF988FF` |
| `HumanBackedAccessGate` | `0xc970BD5b09779D7d6bFD2F4B72B0A941319E32D2` |
| `AgentBountyRail` (standing-gated) | `0x1F29dc489d501C095D2D85941098b3c7281fA3F8` |

Reading an existing `AttestationRegistry` at
`0x36f4751653FD7a21618ea57a732c19b6240410db`. Commons seeded with 0.02 ETH; base
allowance 0.01 ETH per day; step-up off; minimum tier `Device`.

## What was exercised on chain

`ops/world-live-test.sh`, 17 checks, all passing against the addresses above.
The ones worth naming:

- two wallets attested to **one** operator share a single allowance — the second
  wallet sees the first's spend and cannot overdraw the remainder;
- a conduct report of `ViolenceAgainstPeople` / `Critical` bars the operator, and
  in the same block both wallets lose admission and the commons closes on both;
- a **brand-new wallet** attested to that barred operator is admitted nowhere and
  draws nothing — a new keypair is not a new start;
- their existing wallet **cannot be relabelled** onto a clean identifier: the
  registry refuses a rebind without an explicit revoke first;
- an unrelated operator keeps their full allowance throughout.

## AgentBook, live

`@worldcoin/agentkit-core` resolves against the canonical AgentBook deployment on
World Chain. Verified from this repository: `createAgentBookVerifier().lookupHuman()`
returns `null` for an address nobody has registered, which is the RPC round trip
completing and the contract answering — not a swallowed error.

## Two things that only showed up off a local chain

**Reads lag their own writes.** A public endpoint serves `eth_call` from replicas
behind the node that just returned a receipt, so an assertion made straight after
a write routinely reads pre-write state. The harness polls rather than reading
once. The same class of problem, in a different disguise, as the mirror-node lag
recorded above for Hedera.

**Nonces collide.** `eth_getTransactionCount` comes from a replica too, so two
sends in quick succession from one key are rejected with `nonce too low`. Retried
on that specific error, because it is a property of the endpoint rather than of
anything under test.

## Reproducing

```bash
forge script script/DeployWorld.s.sol:DeployWorld \
  --rpc-url "$RPC_URL" --private-key "$PK" --broadcast --slow

RPC_URL=... DEPLOYER_KEY=... \
HUMAN_REGISTRY=0x... STANDING_LEDGER=0x... COMMONS_POOL=0x... ACCESS_GATE=0x... \
./ops/world-live-test.sh
```

Agent wallets are derived per run and topped up for gas automatically, so the
harness is safe to re-run against a chain that keeps its state.

---

# 1inch Aqua — Base Sepolia

Deployed 2026-07-25. The official `Aqua` contract is not on Base Sepolia, so it is
deployed here from the package's own bytecode, unmodified.

| contract | address |
|---|---|
| `Aqua` (official, unmodified) | `0x6f2e859894A17405ac74F7C75cfd2Bca2720C2f9` |
| `VotiveAquaRouter` | `0xA83f98719Cf6FAc8FAB3B224a391Ee14c861E398` |
| demo token A (VDA) | `0xFF1e3bb6FC6FAB6D26A616E889a81eF8581C6479` |
| demo token B (VDB) | `0xd9cDa867f4fC35e36795ADf9290F21C8C464aCae` |
| `MockTaker` | `0x4765837B11b9b07Efb87fC11aBbFD9bC27904aa6` |

Votive opcode base **33** — the official table's length. Our four instructions sit
immediately after it, so a program the Aqua SDK encodes against the stock router
runs here byte-identically.

## The position, priced off a real votive

Strategy `0xf8f83f51…abc9d31e`, priced off votive
`0xef624b1794c8a46da8a6610a94c25ff4b59c74cf` and attestation registry
`0x7204F32BefE33b33d5E89c0E2E63D1eD8155558A`.

Not mocks. The gates open and shut because of the deployed protocol's state, and
the fee threshold is the votive's own `principal()` read from chain.

**Shipped while the capability gate was shut** — the script reported
`Not fillable: the frontier has not reached this wish yet`, which is the whole
point of the instrument.

**Then attested and filled:**

| | |
|---|---|
| tokenA in | 50.0 VDA |
| tokenB out | 66.666 VDB |
| taker | 0 → 66.666 VDB |
| treasury | 0 → **3.9984 VDA** |

The fee checks out against the chain: principal `0.02 ETH` = `2e16`, so the gain
is `50e18 − 2e16 = 49.98e18` and 8% of that is `3.9984e18`. Nothing was charged on
the principal itself.

## Reproducing

```bash
cd aqua
forge script script/DeployAqua.s.sol:DeployAqua \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --slow

AQUA=0x... AQUA_ROUTER=0x... AQUA_TOKEN_A=0x... AQUA_TOKEN_B=0x... AQUA_TAKER=0x... \
VOTIVE_ADDRESS=0x... VOTIVE_ATTESTATIONS=0x... \
VOTIVE_CAPABILITY=0x... VOTIVE_CONDITION=0x... \
forge script script/ShipVotivePosition.s.sol:ShipVotivePosition \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --slow
```

The local-node demo (`script/DemoFill.s.sol`) still works and is faster for
showing the whole arc in one run; this is the version with an address.
