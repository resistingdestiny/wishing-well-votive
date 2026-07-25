import assert from 'node:assert/strict';
import {test} from 'node:test';

import {hbarToTinybars, tinybarsToHbar} from '../dist/rail.js';
import {parseBuyInstruction, parsePayInstruction, payHbar, x402Buy} from '../dist/skills/pay.js';
import {fakeRail} from './fakeRail.ts';

// ------------------------------------------------------------------- amounts

test('HBAR converts to tinybars without going through a float', () => {
  assert.equal(hbarToTinybars(1), 100_000_000n);
  assert.equal(hbarToTinybars(0.00000001), 1n);
  // 0.1 + 0.2 territory: the fixed-point path must not drift.
  assert.equal(hbarToTinybars(0.3), 30_000_000n);
  assert.equal(tinybarsToHbar(30_000_000n), '0.3');
  assert.equal(tinybarsToHbar(100_000_000n), '1');
});

test('a non-positive amount is refused rather than silently zeroed', () => {
  assert.throws(() => hbarToTinybars(0));
  assert.throws(() => hbarToTinybars(-1));
});

// -------------------------------------------------------------- instructions

test('a pay instruction keeps colons in its memo', () => {
  const parsed = parsePayInstruction('pay:0.0.4242:1.5:invoice: batch 7');
  assert.equal(parsed.to, '0.0.4242');
  assert.equal(parsed.tinybars, 150_000_000n);
  assert.equal(parsed.memo, 'invoice: batch 7');
});

test('an account id a model invented is a parse failure, not a transfer', () => {
  assert.throws(() => parsePayInstruction('pay:not-an-account:1:x'));
  assert.throws(() => parsePayInstruction('pay:0.0.1::x'));
});

test('a buy instruction splits off the amount, not the url', () => {
  const parsed = parseBuyInstruction('buy:https://api.example.com/v1/render?x=1:0.25:render');
  assert.equal(parsed.url, 'https://api.example.com/v1/render?x=1');
  assert.equal(parsed.capTinybars, 25_000_000n);
  assert.equal(parsed.memo, 'render');
});

// ---------------------------------------------------------------- paying

test('a payment is only reported done once the mirror node confirms it', async () => {
  const {rail, transfers} = fakeRail();
  const outcome = await payHbar(rail, 'pay:0.0.4242:2:supplier');

  assert.equal(outcome.ok, true);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0]?.tinybars, 200_000_000n);
  assert.match(outcome.summary, /paid 2 ℏ to 0\.0\.4242/);
  assert.match(outcome.receipt?.explorerUrl ?? '', /hashscan\.io\/testnet/);
});

test('a submitted-but-unconfirmed payment is not reported as success', async () => {
  const {rail} = fakeRail({confirmed: false});
  const outcome = await payHbar(rail, 'pay:0.0.4242:2:supplier');

  assert.equal(outcome.ok, false, 'submission is not consensus');
  assert.match(outcome.summary, /not confirmed/);
});

test('a bad instruction moves nothing at all', async () => {
  const {rail, transfers} = fakeRail();
  const outcome = await payHbar(rail, 'pay:hello:1:x');

  assert.equal(outcome.ok, false);
  assert.equal(transfers.length, 0, 'nothing was sent');
  assert.ok(outcome.error);
});

test('a payment writes an audit record when a topic is configured', async () => {
  const {rail, audits} = fakeRail({auditTopicId: '0.0.777'});
  const outcome = await payHbar(rail, 'pay:0.0.4242:1:x');

  assert.equal(outcome.audit?.topicId, '0.0.777');
  assert.equal(audits.length, 1);
  assert.match(audits[0] ?? '', /"kind":"pay"/);
});

// ------------------------------------------------------------------- x402

function service(options: {price?: string; payTo?: string; status?: number} = {}) {
  const calls: {url: string; headers?: Record<string, string>}[] = [];
  const fetchImpl = async (url: string, init?: {headers?: Record<string, string>}) => {
    calls.push({url, ...(init?.headers ? {headers: init.headers} : {})});
    const paid = init?.headers?.['x-payment'] !== undefined;
    if (!paid) {
      return {
        status: 402,
        json: async () => ({payTo: options.payTo ?? '0.0.9001', amountHbar: options.price ?? '0.2'}),
        text: async () => 'payment required',
      };
    }
    return {
      status: options.status ?? 200,
      json: async () => ({ok: true}),
      text: async () => 'the thing you paid for',
    };
  };
  return {fetchImpl, calls};
}

test('x402: call, get priced, pay, call again with the proof', async () => {
  const {rail, transfers} = fakeRail();
  const {fetchImpl, calls} = service({price: '0.2'});

  const outcome = await x402Buy(rail, 'buy:https://api.example.com/render:1:render', fetchImpl);

  assert.equal(outcome.ok, true);
  assert.equal(transfers.length, 1, 'paid exactly once');
  assert.equal(transfers[0]?.tinybars, 20_000_000n);
  assert.equal(calls.length, 2, 'called, then called again');
  assert.equal(calls[1]?.headers?.['x-payment'], outcome.receipt?.transactionId);
  assert.equal(calls[1]?.headers?.['x-payment-network'], 'hedera-testnet');
  assert.equal(outcome.body, 'the thing you paid for');
});

test('x402: a service asking above the signed cap gets nothing', async () => {
  const {rail, transfers} = fakeRail();
  const {fetchImpl, calls} = service({price: '5'});

  const outcome = await x402Buy(rail, 'buy:https://api.example.com/render:1:render', fetchImpl);

  assert.equal(outcome.ok, false);
  assert.equal(transfers.length, 0, 'the cap is enforced before paying, not after');
  assert.equal(calls.length, 1, 'never retried');
  assert.match(outcome.summary, /signed cap/);
});

test('x402: nothing to pay for means nothing is paid', async () => {
  const {rail, transfers} = fakeRail();
  const fetchImpl = async () => ({
    status: 200,
    json: async () => ({}),
    text: async () => 'free',
  });

  const outcome = await x402Buy(rail, 'buy:https://api.example.com/free:1:x', fetchImpl);

  assert.equal(outcome.ok, true);
  assert.equal(transfers.length, 0);
  assert.match(outcome.summary, /no payment required/);
});

test('x402: a 402 that names no Hedera account is refused', async () => {
  const {rail, transfers} = fakeRail();
  const fetchImpl = async () => ({
    status: 402,
    json: async () => ({payTo: '0xdeadbeef', amountHbar: '0.1'}),
    text: async () => 'payment required',
  });

  const outcome = await x402Buy(rail, 'buy:https://api.example.com/x:1:x', fetchImpl);

  assert.equal(outcome.ok, false);
  assert.equal(transfers.length, 0);
});
