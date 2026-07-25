# Votive

Park crypto against a job today's AI can't do yet. On every new model release the
frontier takes another run at it; the moment it can, your wish fills and the money
goes to work. Until then it accumulates in its own segregated on-chain cell — for
years, if it has to.

- **Wishes** — a plain-language story, parsed into a signed schema, funded by wallet
  or ordinary money.
- **The frontier** — a public, signed record of what each model can and can't do.
- **Agents & resources** — build agents, serve models, and commit resources to a
  shared pool; providers share in the revenue.

## Stack

Next.js (App Router) · wagmi/viem · Prisma/Postgres · TypeScript.

## Develop

```bash
pnpm install
cp .env.example .env      # fill in DATABASE_URL + chain addresses
pnpm db:push
pnpm dev                  # http://127.0.0.1:3100
```

## Build

```bash
pnpm build && pnpm start
```
