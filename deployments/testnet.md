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
