# End-to-end tests

Driven against the real Base Sepolia deployment, not a mock. That is slower and
depends on a public endpoint, and it is worth it: the thing most likely to be
broken on demo day is the seam between this app and the contracts, and a test
that stubs the chain cannot see that seam at all.

```bash
set -a; . ./.env.local; set +a
npx next dev -H 127.0.0.1 -p 3100 &
npx playwright test
```

## On MetaMask

The wallet tests inject an EIP-1193 provider at `window.ethereum` and announce it
over EIP-6963 — the same two things the MetaMask extension does — backed by a
real private key signing real transactions. Every wagmi hook and every
`writeContract` in the app runs unchanged.

Driving the actual extension would need a headful browser, a persistent profile,
and a scripted click-through of MetaMask's onboarding and of every confirmation
dialog. That machinery tests MetaMask's UI more than it tests ours, and it breaks
on somebody else's release. The one thing this does not cover is a human clicking
"Confirm", which is stated here rather than left to be discovered.
