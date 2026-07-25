# Prize compliance

Checked against the published qualification text, requirement by requirement.
Where something is not met, it says so.

---

## Hedera — AI & Agentic Payments ($6,000)

| requirement (verbatim) | status | evidence |
|---|---|---|
| "Build an AI agent or multi-agent system that executes at least one payment, token transfer, or financial operation on Hedera Testnet." | ✅ | `sdk/src/agent.ts` toolbelt; **0.25 ℏ paid on testnet**, tx `0.0.9699740@1784989128.491172099`, consensus `1784989133.036089104` |
| "Use one or more of: Hedera Agent Kit, OpenClaw ACP, **x402**, A2A protocol, or **Hedera SDKs directly**." | ✅ | both — `@hashgraph/sdk` in `sdk/src/rail.ts`, x402 in `sdk/src/skills/pay.ts` |
| "Provide source code in a public GitHub repo with a README covering setup, architecture, and how the payment flow works." | ✅ | `sdk/README.md` |
| "Include a ≤ 5-minute demo video showing the agent performing autonomous payment actions." | ⬜ | **not done — yours** |

Optional enhancements claimed: x402 implementation, audit trails (HCS topic
append per payment), agent identity (the World layer below).

The full agent payment cycle also ran on Hedera testnet against
`AgentBountyRail` at `0x65E76108610933d69046b68070aFbc925B363e9e`: register →
attest → escrow 3 ℏ → claim → three incremental releases → withdraw, rail drained
to zero.

---

## 1inch — Build an Aqua App ($5,000)

| requirement (verbatim) | status | evidence |
|---|---|---|
| "Official Aqua/SwapVM contracts must be used (redeployments of a modified SwapVM contract is allowed)" | ✅ | `aqua/src/VotiveAquaRouter.sol` extends the official `AquaSwapVMRouter`; instructions are **appended** to `super._opcodes()`, nothing official replaced. Pinned by `test_theOfficialOpcodeSetIsUntouched` |
| "Onchain execution of token transfers should be presented during the final demo (local forks are ok)" | ✅ | `aqua/script/DemoFill.s.sol` — 16 broadcast transactions, all status 1; taker **+66.67 tokenB**, treasury **+1.6 tokenA** |
| "Proper Git commit history (no single-commit entries on the final day)" | ✅ | the Aqua work is spread over many small commits across several days |

**What the demo shows.** A votive is shipped to the official `Aqua` contract
priced by our program. Filling it is refused while the capability gate is shut —
the AI frontier has not reached the job the wish was opened for. The capability
opens, the wish is attested, and the same fill succeeds. The performance fee is
carved from the surplus only: `(50 − 30) × 8% = 1.6`, with nothing charged on
the principal.

```bash
anvil &
cd aqua && forge script script/DemoFill.s.sol:DemoFill \
  --rpc-url http://127.0.0.1:8545 --private-key "$PK" --broadcast
```

---

## World — AgentKit New Use Cases ($8,000)

| requirement (verbatim) | status | evidence |
|---|---|---|
| "Uses AgentKit in a meaningful way" | ✅ | `createAgentBookVerifier` resolves the human (`sdk/src/world/agentBook.ts`, verified live against World Chain); `sdk/src/world/attestor.ts` mirrors it on-chain; `sdk/src/world/rateLimit.ts` implements `AgentKitStorage` |
| "Verifies an agent is human-backed" | ✅ | `HumanBackingRegistry` + `HumanBackedAccessGate`; live on Base Sepolia |
| "Shows a working end-to-end flow, not just a wrapper or static demo" | ✅ | `ops/world-live-test.sh` — 17 checks on a real deployment; `contracts/test/integration/FullJourney.t.sol` traces one wish through everything |
| "≤5 min demo video" | ⬜ | **not done — yours** |

### The exclusion list, addressed directly

> "Projects that reuse patterns from prior hackathons without a genuinely new
> workflow, vertical, or trust model, for example: **Agent reputation** …
> **Human-backed benefits for AI agents (i.e. API calls, discounts)**"

This is a real risk and worth being straight about.

**Nothing here is a discount.** No agent pays less for anything. There is no
free trial, no discounted call, no preferential price.

**The reputation score is the smaller half.** Everything load-bearing works with
the multiplier pinned at parity: the per-human commons budget, the bar, and the
fact that a fresh keypair escapes neither.

**The new trust model is the point.** Standing and exclusion are keyed to a
*human*, not an address. That is what makes the bar hold — an address-keyed
version of this is defeated by generating a keypair, which is why the pattern
being excluded is excluded. Concretely, and proven on chain:

- ten agents get an operator no more budget than one, because all ten resolve to
  the same identifier;
- a wish asking for somebody to be killed bars the operator across **every wallet
  they hold, in the same block**;
- a brand-new wallet attested to that operator afterwards opens nothing;
- their existing wallet cannot be relabelled onto a clean identifier;
- settled earnings are still withdrawable, because a bar is an exclusion and not
  a fine.

The track description names *access control, authorization, rate limits, economic
terms, payments, moderation, accountability*. This is those, from one signal.

**Judge it on the barring, not on the score.**

---

## Not claimed

Stated so nobody wastes time looking:

- **Hedera Tokenization** — no HTS token is created or managed.
- **Hedera "No Solidity Allowed"** — this project is largely Solidity.
- **Hedera Schedule Service / Axelar** — no scheduled transactions.
- **World Selfie Check / Identity Check** — the assurance tiers model these, and
  the registry stores which tier backed an attestation, but neither beta SDK is
  called and there is no testing documentation with user feedback, which both
  tracks require.

---

## Verification

Everything below was run at the time of writing.

| suite | result |
|---|---|
| `contracts` — `forge test` | **318 passed** |
| `aqua` — `forge test` | **7 passed** |
| `sdk` — `npm test` | **76 passed** |
| `ops/world-live-test.sh` (deployed contracts, over RPC) | **17 passed** |
| `aqua/script/DemoFill.s.sol` (broadcast) | **16 transactions, all status 1** |

Formatters and the lint gate are clean in all three projects, and the SDK
typechecks.

### Live deployments

**Base Sepolia** — `HumanBackingRegistry` `0x46C1a6e212701724C1802211d09c0581B3d777C7`,
`StandingLedger` `0xDD9F86CB8893BFc440B5FF9Ff79BA757AD6fd2d7`,
`CommonsPool` `0xC5CA17f63bA972c98B05786e04B1e194ABF988FF`,
`HumanBackedAccessGate` `0xc970BD5b09779D7d6bFD2F4B72B0A941319E32D2`.

**Hedera testnet** — `AgentBountyRail` `0x65E76108610933d69046b68070aFbc925B363e9e`.

Full records in `deployments/testnet.md`.
