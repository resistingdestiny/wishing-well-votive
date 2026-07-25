# Votive — build plan

A phased plan to build the Votive web app: users park crypto against a job today's AI
can't do yet; on every new model release the frontier takes another run at it, and the
moment it can, the wish fills. Each phase below is a coherent slice that builds on the
last, and each step maps to a single focused commit.

**Stack:** Next.js (App Router) · wagmi/viem · Prisma/Postgres · TypeScript. No CSS
framework — a hand-built design system. A `src/core/` data layer holds the protocol
primitives (schema, run-log, benchmark, resources, providers); `src/lib/` adapts them to
the web runtime (chain reads, DB, money rails); `src/app/` is the App-Router UI + APIs.

---



## Phase 0 — Foundation

Stand the project up and lock the visual language before any feature work.

1. **Scaffold the Next.js app** — `package.json`, `tsconfig`, `next.config`, `.gitignore`,
  `.nvmrc`, an env template, and a README. Path aliases (`@/*`) and a `.js`→`.ts`
   resolver so the core layer's ESM specifiers resolve.
2. **Dependencies + lockfile** — wagmi/viem, Prisma, TanStack Query, web-push, zod.
3. **Design system** — one stylesheet of tokens (canvas/card/ink/blue, spacing scale),
  typography (Space Grotesk display + Inter Tight body), component classes (panels,  pills, badges, tables, forms, nav), and a full dark-theme pair based on the PDF design documents.



## Phase 1 — Core protocol layer (`src/core/`)

The framework-agnostic heart: how a wish is described, how the frontier is measured, and
how money and agents plug in. Pure TypeScript, unit-testable, no React.

1. **Story schema, beneficiaries, parser, story store** — the signed `StorySchema` (wish
  type, capability, condition, guardian, beneficiaries commitment), the prose→schema
   parser, and off-chain story persistence.
2. **Signed run-log + capability sweep tracking** — the hash-chained, oracle-signed record
  of every capability check, with pass@k streak accounting.
3. **Trustless conditions, Merkle distribution, LLM client** — on-chain condition
  resolvers, the Merkle pull-claim builder, and the model-inference client.
4. **Model registry, pricing, cost ledger, reputation** — the catalogue of models with
  release dates/tiers, USD pricing, per-model spend, and a reputation score derived from
   the signed log.
5. **Benchmark corpus & dataset** — the run-log as a versioned, content-addressed,
  independently verifiable open dataset (per-capability + whole-corpus).
6. **Frontier report** — the editorial projection: what's newly in reach, what still
  isn't, median sweeps to unlock, demand-ranked backlog.
7. **Shared resource registry, store, attribution** — resources agents draw on (tools,
  data, credentials, budget) with usage attribution.
8. **Money-service providers** — a uniform interface + sandbox adapters for wallet,
  onramp, bank rail, KYC, and offramp (the fiat funding + claim rails).
9. **Beneficiary claims & strategy agents** — claim matching/service (identity → payout)
  and the strategy-agent model (base model + system prompt + granted tools).
10. **Runtime config, human assurance, eval harness** — env-driven config, human-backed
  agent verification, and the sandboxed eval harness.



## Phase 2 — Application data layer (`src/lib/`)

Adapt the core to the web runtime: chain reads, the database, and the money/notification plumbing the routes call.

1. **Chain reads & formatting** — resilient cell/registry reads (viem) + display helpers.
2. **Prisma database client** — the singleton DB client.
3. **wagmi config, subgraph, attestations** — the browser wallet config, the subgraph
  query layer, and on-chain attestation lookups.
4. **Run-log ingest, money rails, claims, solver agents, human-backed identity** — the
  server seams that bridge core services to the app.
5. **Notifications, push, rate-limit, geofence, PII, local cells** — the web-push +
  inbox layer, an in-process rate limiter, the jurisdiction gate, PII encryption at
    rest, and browser-local wish tracking.



## Phase 3 — App shell & navigation

The chrome every page shares based on the PDF design documents.

1. **Root layout & providers** — the layout, fonts, and wagmi/query providers.
2. **UI primitives** — page head, field, and empty-state building blocks.
3. **Navigation model & grouped top nav** — the single nav source of truth + the grouped
  topbar (Wishes / Research / Build).
4. **Section tab bar & app footer** — per-section sub-navigation and the footer.
5. **Global wallet connect button** — one persistent connection control in the chrome.
6. **Command palette, notifications, push toggle, watch, logo** — ⌘K "ask the well",
  the notification bell + push toggle, watch buttons, and the mark.



## Phase 4 — Landing

1. **Page, sections & live data** — the marketing landing wired to live platform stats.
2. **Liquid cube & motion** — the hero scene and the scroll/reveal motion layer.



## Phase 5 — The wish lifecycle

The core user journey, from writing a wish to watching it wait.

1. **Make-a-wish wizard** — the step-through: compose → review the parsed schema → fund
  (wallet or ordinary money) → done.

**Fund-with-money flow** — the no-wallet fiat path (bank/card → USDC in a segregated cell), shared with the wizard.

1. **Explore — all wishes** — the full directory of on-chain cells with live stats.
2. **Your wishes dashboard** — the connected wallet's positions plus a wallet-less
  "from this browser" view.
3. **Wish detail page** — one cell: story, funds & fees, schema, on-chain history, agent
  activity, and owner actions (top-up, amend, claim, escheat).



## Phase 6 — The frontier (transparency surfaces)

The public, signed record of what AI can and can't do.

1. **The board, solver agents & frontier report page** — the capability × model matrix,
  the solver-agent roster, and the editorial report.
2. **Bench, verify & proof surfaces** — the downloadable benchmark, an in-browser
  attestation verifier, and permalink proofs.
3. **Embeddable frontier widget** — an iframe widget + a public read API.



## Phase 7 — Agents & the resource marketplace

1. **Agents hub** — build a strategy agent (model + prompt + tools) and submit it.
2. **Resource marketplace & toolbelt** — commit a resource to the shared pool, browse
  the toolbelt, and (feature-detected) deposit into the resource pool.



## Phase 8 — Onboarding, compliance, claims

1. **Getting-started guide & region gate** — the guided walkthrough and the geofence
  block page.
2. **Beneficiary claim portal** — the invitation-token claim flow (KYC → payout rail).



## Phase 9 — API layer

The server routes behind the surfaces above.

1. **Read APIs** — ask, bench, proof, public board/marketplace, run-log, distribution,
  notifications, watch.
2. **Write API — parse story into schema.**
3. **Write APIs — register wish, curate, ingest run-log.**
4. **Write APIs — solver agents, strategy agents, resources.**
5. **Money-rail APIs — fund, claim, push subscribe.**



## Phase 10 — Middleware & persistence

1. **Geofence middleware, service worker, database schema** — the edge jurisdiction
  guard, the web-push service worker, and the Prisma schema.

---



### Notes on sequencing

- The core layer (Phase 1) lands before anything imports it, so every later phase builds
on stable primitives.
- The design system (Phase 0) precedes all UI, so pages inherit the tokens for free.
- The API layer (Phase 9) can be built alongside its pages, but is grouped here so the
server contract is reviewable as a unit.
- Money-movement routes (fund/claim) and the geofence are deliberately last, so the
compliance surface is in place before any value path is wired.

