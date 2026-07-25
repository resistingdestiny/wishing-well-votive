# Demo runbook

Everything needed to show this working, in order.

## Live deployment — Base Sepolia

| contract | address |
|---|---|
| `VotiveFactory` | `0x71E160b9c24ACCed6DC6974B1Ce57bAb6015EE91` |
| `AttestationRegistry` | `0x7204F32BefE33b33d5E89c0E2E63D1eD8155558A` |
| `HumanBackingRegistry` | `0xF326fdDE0455eEeD5CAD0EE9462db3C587f6924e` |
| `StandingLedger` | `0x440F9Bc7f050AA80A3CaA921281c16b42b8967b4` |
| `AgentStandingAdapter` | `0x5eF85549EfF800A4DdDf25b7A482967B1478d41B` |
| `CommonsPool` | `0x024E3f1B1d6732ac26058ED5A5856ee37b998090` |
| `ResourceRegistry` | `0xf1177F9650311150fC15994d3CCDf9e47e019CeE` |
| `HumanBackedAccessGate` | `0x9Ae14aD4004D5C9a644573bFC1c30406ffC1f558` |
| `AgentBountyRail` | `0x1F0EC50a93c37041d163C0d06aa411e5bfD4d4CF` |

Hedera testnet: `AgentBountyRail` at `0x65E76108610933d69046b68070aFbc925B363e9e`.

## Start it

```bash
set -a; . ./.env.local; set +a
npx next dev -H 127.0.0.1 -p 3100
```

`.env.local` is gitignored and holds the addresses above, the database URL and the
demo wallet. It is the only file with a key in it.

## Give a fresh deployment something to show

```bash
set -a; . ./.env.local; set +a
ops/demo-seed.sh
```

Sends one real transaction per integration and records each through the same
endpoint the browser uses. Idempotent — re-running skips what is already done,
including the attestation, which the registry refuses to rebind on purpose.

## The route to walk

1. **`/live`** — start here. Positions and standing read from the contracts on
   load; transactions from our own record. Every hash links to a block explorer.
2. **`/explore`** — every wish, its state and its balance.
3. **`/wish/<address>`** — one wish in full.
4. **`/create`** — write a wish in prose, watch it become a schema, fund it.

## The Aqua fill

Not on Base Sepolia — the official Aqua contracts are not deployed there, and the
track allows a local run.

```bash
anvil &
cd aqua && forge script script/DemoFill.s.sol:DemoFill \
  --rpc-url http://127.0.0.1:8545 --private-key "$PK" --broadcast
```

16 transactions, all successful. Taker gains 66.67 tokenB; the treasury gains
1.6 tokenA, which is 8% of the surplus above principal and nothing on the
principal itself.

## Checks

```bash
cd contracts && forge test     # 338
cd aqua && forge test          # 7
cd sdk && npm test             # 103
npx playwright test            # 8, against the live deployment
ops/world-live-test.sh         # 17, against deployed contracts over RPC
```

## What the demo wallet is

A throwaway key generated for this, funded on both testnets, imported nowhere
that matters. It holds a small amount of Base Sepolia ETH and testnet HBAR. The
key lives only in `.env.local`.
