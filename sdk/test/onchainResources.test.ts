import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  RESOURCE_SELECTORS,
  ResourceRefusal,
  createOnchainResourceView,
  createResourceProvider,
} from '../dist/world/onchainResources.js';
import type {ChainReader} from '../dist/world/standing.js';

const REGISTRY = '0x1111111111111111111111111111111111111111';
const WALLET = '0x00000000000000000000000000000000000000a1';
const CORPUS = `0x${'cc'.repeat(32)}`;
const GRANT = `0x${'11'.repeat(32)}`;

const w = (value: bigint | boolean): string =>
  (typeof value === 'boolean' ? (value ? 1n : 0n) : value).toString(16).padStart(64, '0');

function chain(answers: Record<string, string>) {
  const calls: {to: string; data: string}[] = [];
  const read: ChainReader = async ({to, data}) => {
    calls.push({to, data});
    return answers[data.slice(0, 10)] ?? '0x';
  };
  return {read, calls};
}

// ------------------------------------------------------------------ selectors

/**
 * The first draft of the module these pin guessed all five and got all five
 * wrong — and a wrong selector does not revert. An `eth_call` to a function that
 * does not exist returns empty, which decodes to zero, which reads exactly like
 * "not allowed, no quota left". A caller would believe it and an operator could
 * never debug it.
 */
test('the selectors are the ones the registry actually exposes', () => {
  assert.equal(RESOURCE_SELECTORS.quote, '0x75c854c3');
  assert.equal(RESOURCE_SELECTORS.requestAccess, '0x841fb503');
  assert.equal(RESOURCE_SELECTORS.isGrantReleasable, '0x6c4966fb');
  assert.equal(RESOURCE_SELECTORS.effectiveLimitOf, '0x193e5741');
  assert.equal(RESOURCE_SELECTORS.grantOf, '0x9aee26f1');
});

// ----------------------------------------------------------------- agent side

test('a quote decodes all four fields the registry returns', async () => {
  const {read} = chain({
    [RESOURCE_SELECTORS.quote]: `0x${w(true)}${w(0n)}${w(12n)}${w(5n)}`,
  });
  const view = createOnchainResourceView({read, registry: REGISTRY});

  const quote = await view.quote(WALLET, CORPUS);

  assert.deepEqual(quote, {
    allowed: true,
    reason: ResourceRefusal.None,
    effectiveLimit: 12,
    remaining: 5,
  });
});

test('a refusal comes back with the reason the registry gave', async () => {
  const {read} = chain({
    [RESOURCE_SELECTORS.quote]: `0x${w(false)}${w(4n)}${w(0n)}${w(0n)}`,
  });
  const view = createOnchainResourceView({read, registry: REGISTRY});

  const quote = await view.quote(WALLET, CORPUS);

  assert.equal(quote.allowed, false);
  assert.equal(quote.reason, ResourceRefusal.Barred);
});

test('the request is calldata, not a signed transaction', async () => {
  const {read} = chain({});
  const view = createOnchainResourceView({read, registry: REGISTRY});

  const data = view.requestCalldata(CORPUS);

  assert.ok(data.startsWith(RESOURCE_SELECTORS.requestAccess));
  assert.equal(data.length, 10 + 64, 'one argument, one word');
  assert.ok(data.endsWith('cc'.repeat(32)));
});

test('a quote asks about the wallet and the resource, at the registry', async () => {
  const {read, calls} = chain({
    [RESOURCE_SELECTORS.quote]: `0x${w(true)}${w(0n)}${w(1n)}${w(1n)}`,
  });
  const view = createOnchainResourceView({read, registry: REGISTRY});

  await view.quote(WALLET, CORPUS);

  assert.equal(calls[0]?.to, REGISTRY);
  assert.ok(calls[0]?.data.includes('a1'), 'the wallet was not in the call');
  assert.ok(calls[0]?.data.endsWith('cc'.repeat(32)), 'the resource was not in the call');
});

// -------------------------------------------------------------- provider side

test('a provider releases a credential when the chain still says yes', async () => {
  const {read} = chain({
    [RESOURCE_SELECTORS.isGrantReleasable]: `0x${w(true)}${w(0n)}`,
  });
  let minted = 0;
  const provider = createResourceProvider({
    read,
    registry: REGISTRY,
    issue: async () => {
      minted += 1;
      return 'sk-the-actual-secret';
    },
  });

  const credential = await provider.release(GRANT, {resourceId: CORPUS, wallet: WALLET});

  assert.equal(credential, 'sk-the-actual-secret');
  assert.equal(minted, 1);
});

/**
 * The case the whole split exists for. A grant records entitlement at the moment
 * it was issued; what governs handing over a key is entitlement *now*. An operator
 * barred in between must collect nothing — and no credential should even be minted,
 * so there is nothing to revoke afterwards.
 */
test('a grant that stopped being releasable mints no credential at all', async () => {
  const {read} = chain({
    [RESOURCE_SELECTORS.isGrantReleasable]: `0x${w(false)}${w(4n)}`,
  });
  let minted = 0;
  const provider = createResourceProvider({
    read,
    registry: REGISTRY,
    issue: async () => {
      minted += 1;
      return 'sk-should-never-exist';
    },
  });

  const credential = await provider.release(GRANT, {resourceId: CORPUS, wallet: WALLET});

  assert.equal(credential, null);
  assert.equal(minted, 0, 'a credential was minted for a grant the chain refused');
});

test('a refusal is reported with a sentence, not just a number', async () => {
  const {read} = chain({
    [RESOURCE_SELECTORS.isGrantReleasable]: `0x${w(false)}${w(4n)}`,
  });
  const provider = createResourceProvider({read, registry: REGISTRY, issue: async () => 'x'});

  const verdict = await provider.check(GRANT);

  assert.equal(verdict.releasable, false);
  assert.equal(verdict.reason, ResourceRefusal.Barred);
  assert.match(verdict.explanation, /not a quota you can wait out/);
});

test('the release log records the decision and never the credential', async () => {
  const seen: unknown[] = [];
  const {read} = chain({
    [RESOURCE_SELECTORS.isGrantReleasable]: `0x${w(true)}${w(0n)}`,
  });
  const provider = createResourceProvider({
    read,
    registry: REGISTRY,
    issue: async () => 'sk-do-not-log-me',
    onRelease: (r) => seen.push(r),
  });

  await provider.release(GRANT, {resourceId: CORPUS, wallet: WALLET});

  const line = JSON.stringify(seen[0]);
  assert.doesNotMatch(line, /sk-do-not-log-me/, 'a credential reached the release log');
  assert.match(line, /"released":true/);
});

/// A provider working a queue should be able to skip a refused grant without the
/// whole batch unwinding.
test('a refused grant returns null rather than throwing', async () => {
  const {read} = chain({
    [RESOURCE_SELECTORS.isGrantReleasable]: `0x${w(false)}${w(6n)}`,
  });
  const provider = createResourceProvider({read, registry: REGISTRY, issue: async () => 'x'});

  await assert.doesNotReject(() => provider.release(GRANT, {resourceId: CORPUS, wallet: WALLET}));
});
