import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createStandingRateLimit} from '../dist/world/rateLimit.js';
import {
  SELECTORS,
  createStandingView,
  decodeUint,
  standingCalldata,
} from '../dist/world/standing.js';
import type {ChainReader} from '../dist/world/standing.js';

const REGISTRY = '0x1111111111111111111111111111111111111111';
const LEDGER = '0x2222222222222222222222222222222222222222';
const COMMONS = '0x3333333333333333333333333333333333333333';

const ALICE = `0x${'aa'.repeat(32)}`;
const WALLET = '0x00000000000000000000000000000000000000a1';
const ZERO_WORD = `0x${'0'.repeat(64)}`;

const word = (value: bigint | string): string =>
  typeof value === 'bigint'
    ? `0x${value.toString(16).padStart(64, '0')}`
    : `0x${value.replace(/^0x/, '').padStart(64, '0')}`;

/** A chain that answers from a table, and records what it was asked. */
function fakeChain(answers: Record<string, string>) {
  const calls: {to: string; data: string}[] = [];
  const read: ChainReader = async ({to, data}) => {
    calls.push({to, data});
    const key = `${to.toLowerCase()}:${data.slice(0, 10)}`;
    return answers[key] ?? ZERO_WORD;
  };
  return {read, calls};
}

// ------------------------------------------------------------------ selectors

/**
 * Pinned against Solidity. A hand-written selector in this package was once wrong
 * by a nibble; the call did not revert, it returned zero — which reads exactly
 * like "this operator has no allowance" and would have been believed.
 */
test('the selectors are the ones the contracts actually expose', () => {
  assert.equal(SELECTORS.isBarred, '0x673c804f');
  assert.equal(SELECTORS.multiplierBpsOf, '0x7b195175');
  assert.equal(SELECTORS.humanOf, '0xb64664c4');
  assert.equal(SELECTORS.assuranceOf, '0x8d972249');
  assert.equal(SELECTORS.ceilingOf, '0xc0e33e9c');
  assert.equal(SELECTORS.remainingOf, '0xfa19fde7');
  assert.equal(SELECTORS.isPermitted, '0x3fd8cc4e');
  assert.equal(SELECTORS.draw, '0xb702a879');
  assert.equal(SELECTORS.attest, '0x9bdcc9a4');
  assert.equal(SELECTORS.reportConduct, '0xf09969db');
  assert.equal(SELECTORS.currentEpoch, '0x76671808');
});

test('calldata is the selector followed by one word per argument', () => {
  const data = standingCalldata.attest(WALLET, ALICE, 3, `0x${'cd'.repeat(32)}`);
  assert.ok(data.startsWith(SELECTORS.attest));
  assert.equal(data.length, 10 + 4 * 64, 'four arguments, one word each');
  assert.ok(data.includes('a1'), 'the wallet is in there');

  const draw = standingCalldata.draw(1_500n, WALLET);
  assert.ok(draw.startsWith(SELECTORS.draw));
  assert.equal(decodeUint(`0x${draw.slice(10, 74)}`), 1_500n);
});

// -------------------------------------------------------------------- reading

test('an unbacked wallet is nobody, and is not reported as barred', async () => {
  const {read} = fakeChain({});
  const view = createStandingView(read, {registry: REGISTRY, ledger: LEDGER});

  const snapshot = await view.snapshot(WALLET);

  assert.equal(snapshot.humanId, null);
  assert.equal(snapshot.barred, false, '"never met you" is not "you did something"');
  assert.equal(snapshot.multiplierBps, 0n);
});

test('a backed wallet reports its human, tier and standing', async () => {
  const {read} = fakeChain({
    [`${REGISTRY}:${SELECTORS.humanOf}`]: word(ALICE),
    [`${REGISTRY}:${SELECTORS.assuranceOf}`]: word(3n),
    [`${LEDGER}:${SELECTORS.isBarred}`]: word(0n),
    [`${LEDGER}:${SELECTORS.multiplierBpsOf}`]: word(12_000n),
    [`${COMMONS}:${SELECTORS.ceilingOf}`]: word(24n * 10n ** 18n),
    [`${COMMONS}:${SELECTORS.remainingOf}`]: word(9n * 10n ** 18n),
  });
  const view = createStandingView(read, {
    registry: REGISTRY,
    ledger: LEDGER,
    commons: COMMONS,
  });

  const snapshot = await view.snapshot(WALLET);

  assert.equal(snapshot.humanId, ALICE);
  assert.equal(snapshot.assurance, 3);
  assert.equal(snapshot.barred, false);
  assert.equal(snapshot.multiplierBps, 12_000n);
  assert.equal(snapshot.ceiling, 24n * 10n ** 18n);
  assert.equal(snapshot.remaining, 9n * 10n ** 18n);
});

test('the standing questions are asked about the human, not the wallet', async () => {
  const {read, calls} = fakeChain({
    [`${REGISTRY}:${SELECTORS.humanOf}`]: word(ALICE),
    [`${LEDGER}:${SELECTORS.isBarred}`]: word(1n),
  });
  const view = createStandingView(read, {registry: REGISTRY, ledger: LEDGER});

  const snapshot = await view.snapshot(WALLET);
  assert.equal(snapshot.barred, true);

  const barredCall = calls.find((c) => c.data.startsWith(SELECTORS.isBarred));
  assert.ok(barredCall, 'never asked whether they were barred');
  assert.ok(
    barredCall.data.endsWith('aa'.repeat(32)),
    'asked about the wallet instead of the human'
  );
});

// ------------------------------------------------------------- the rate limit

function standingStub(options: {barred?: boolean; multiplierBps?: bigint} = {}) {
  return {
    async snapshot() {
      throw new Error('not used');
    },
    async isBarred() {
      return options.barred ?? false;
    },
    async multiplierBps() {
      return options.multiplierBps ?? 10_000n;
    },
  };
}

test('at parity standing the baseline limit is what applies', async () => {
  const limiter = createStandingRateLimit({standing: standingStub()});

  for (let i = 0; i < 5; i++) {
    assert.equal(await limiter.tryIncrementUsage('/commons', ALICE, 5), true, `call ${i}`);
  }
  assert.equal(await limiter.tryIncrementUsage('/commons', ALICE, 5), false, 'the sixth');
});

/// Delivering work buys a higher rate, which is the "earned, not configured" half.
test('good standing raises the limit above the baseline', async () => {
  const limiter = createStandingRateLimit({
    standing: standingStub({multiplierBps: 30_000n}),
  });

  let granted = 0;
  for (let i = 0; i < 40; i++) {
    if (await limiter.tryIncrementUsage('/commons', ALICE, 10)) granted++;
  }
  assert.equal(granted, 30, '10 baseline × 3.0 standing');
});

test('poor standing lowers it', async () => {
  const limiter = createStandingRateLimit({
    standing: standingStub({multiplierBps: 2_500n}),
  });

  let granted = 0;
  for (let i = 0; i < 40; i++) {
    if (await limiter.tryIncrementUsage('/commons', ALICE, 10)) granted++;
  }
  assert.equal(granted, 2, '10 baseline × 0.25 standing, floored');
});

/// The headline behaviour: a bar is not a smaller allowance, it is none, and it
/// does not care what limit the endpoint asked for.
test('a barred operator gets nothing whatever the limit says', async () => {
  const decisions: string[] = [];
  const limiter = createStandingRateLimit({
    standing: standingStub({barred: true, multiplierBps: 30_000n}),
    onDecision: (d) => decisions.push(d.reason),
  });

  assert.equal(await limiter.tryIncrementUsage('/commons', ALICE, 1_000_000), false);
  assert.deepEqual(decisions, ['barred']);
});

test('a refusal says which kind it was, so an operator can be told', async () => {
  const seen: {reason: string; effectiveLimit: number}[] = [];
  const limiter = createStandingRateLimit({
    standing: standingStub({multiplierBps: 10_000n}),
    onDecision: (d) => seen.push({reason: d.reason, effectiveLimit: d.effectiveLimit}),
  });

  await limiter.tryIncrementUsage('/commons', ALICE, 1);
  await limiter.tryIncrementUsage('/commons', ALICE, 1);

  assert.deepEqual(seen.map((s) => s.reason), ['granted', 'exhausted']);
  assert.equal(seen[1]?.effectiveLimit, 1);
});

test('the window rolls over and frees usage', async () => {
  let clock = 1_000;
  const limiter = createStandingRateLimit({
    standing: standingStub(),
    windowSeconds: 100,
    now: () => clock,
  });

  assert.equal(await limiter.tryIncrementUsage('/commons', ALICE, 1), true);
  assert.equal(await limiter.tryIncrementUsage('/commons', ALICE, 1), false);

  clock += 100;
  assert.equal(await limiter.tryIncrementUsage('/commons', ALICE, 1), true, 'window did not roll');
});

/// Two agents of one human draw on the same budget — the Sybil property, at the
/// rate-limit layer rather than the money layer.
test('one human has one budget however many agents they run', async () => {
  const limiter = createStandingRateLimit({standing: standingStub()});

  // Two different agent wallets, but AgentBook resolves both to the same human,
  // and the human is what the limiter is keyed on.
  assert.equal(await limiter.tryIncrementUsage('/commons', ALICE, 2), true);
  assert.equal(await limiter.tryIncrementUsage('/commons', ALICE, 2), true);
  assert.equal(await limiter.tryIncrementUsage('/commons', ALICE, 2), false, 'a third slipped in');
});

test('endpoints are metered separately', async () => {
  const limiter = createStandingRateLimit({standing: standingStub()});

  assert.equal(await limiter.tryIncrementUsage('/commons', ALICE, 1), true);
  assert.equal(await limiter.tryIncrementUsage('/commons', ALICE, 1), false);
  assert.equal(await limiter.tryIncrementUsage('/claim', ALICE, 1), true, 'endpoints bled together');
});

test('a nonce is only usable once', async () => {
  const limiter = createStandingRateLimit({standing: standingStub()});

  assert.equal(await limiter.hasUsedNonce?.('n1'), false);
  await limiter.recordNonce?.('n1');
  assert.equal(await limiter.hasUsedNonce?.('n1'), true);
  assert.equal(await limiter.hasUsedNonce?.('n2'), false);
});

test('an earned rate is still capped', async () => {
  const limiter = createStandingRateLimit({
    standing: standingStub({multiplierBps: 30_000n}),
    maxLimit: 5,
  });

  let granted = 0;
  for (let i = 0; i < 30; i++) {
    if (await limiter.tryIncrementUsage('/commons', ALICE, 100)) granted++;
  }
  assert.equal(granted, 5);
});
