import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createStandingRateLimit} from '../dist/world/rateLimit.js';
import {createResourceCommons} from '../dist/world/resourceCommons.js';
import type {SharedResource} from '../dist/world/resourceCommons.js';

const HUMAN = `0x${'aa'.repeat(32)}` as const;
const WALLET_A = '0x00000000000000000000000000000000000000a1';
const WALLET_B = '0x00000000000000000000000000000000000000b2';

function standingStub(
  options: {barred?: boolean; multiplierBps?: bigint; assurance?: number; humanId?: string | null} = {}
) {
  const humanId = options.humanId === undefined ? HUMAN : options.humanId;
  return {
    async snapshot() {
      return {
        humanId: humanId as `0x${string}` | null,
        assurance: options.assurance ?? 2,
        barred: options.barred ?? false,
        multiplierBps: options.multiplierBps ?? 10_000n,
      };
    },
    async isBarred() {
      return options.barred ?? false;
    },
    async multiplierBps() {
      return options.multiplierBps ?? 10_000n;
    },
  };
}

let issued = 0;
function corpus(overrides: Partial<SharedResource> = {}): SharedResource {
  return {
    id: 'corpus-api',
    description: 'A licensed text corpus, metered by the seat we pay for',
    baseLimit: 3,
    async issue() {
      issued += 1;
      return `secret-key-${issued}`;
    },
    ...overrides,
  };
}

function commonsWith(
  standingOptions: Parameters<typeof standingStub>[0] = {},
  resources: SharedResource[] = [corpus()]
) {
  const standing = standingStub(standingOptions);
  const records: {granted: boolean; reason?: string}[] = [];
  const commons = createResourceCommons({
    standing,
    limiter: createStandingRateLimit({standing}),
    resources,
    onDecision: (r) => records.push({granted: r.granted, ...(r.reason ? {reason: r.reason} : {})}),
  });
  return {commons, records};
}

// ------------------------------------------------------------------ granting

test('a verified agent in good standing is handed a credential', async () => {
  const {commons} = commonsWith();

  const decision = await commons.request(WALLET_A, 'corpus-api');

  assert.equal(decision.granted, true);
  assert.ok(decision.granted && decision.credential.startsWith('secret-key-'));
  assert.equal(decision.granted && decision.effectiveLimit, 3);
  assert.equal(decision.granted && decision.remaining, 2);
});

test('the share runs out and refuses without minting another credential', async () => {
  const before = issued;
  const {commons} = commonsWith();

  for (let i = 0; i < 3; i++) {
    assert.equal((await commons.request(WALLET_A, 'corpus-api')).granted, true, `use ${i}`);
  }
  const fourth = await commons.request(WALLET_A, 'corpus-api');

  assert.equal(fourth.granted, false);
  assert.equal(!fourth.granted && fourth.reason, 'quota-exhausted');
  assert.equal(issued - before, 3, 'a credential was minted for a refused request');
});

/// The economic half: delivering work buys a bigger share of the same resource.
test('better standing earns a larger share of the same resource', async () => {
  const {commons} = commonsWith({multiplierBps: 30_000n});

  let granted = 0;
  for (let i = 0; i < 12; i++) {
    if ((await commons.request(WALLET_A, 'corpus-api')).granted) granted++;
  }

  assert.equal(granted, 9, '3 baseline × 3.0 standing');
});

test('poor standing earns a smaller one', async () => {
  const {commons} = commonsWith({multiplierBps: 2_500n});

  let granted = 0;
  for (let i = 0; i < 12; i++) {
    if ((await commons.request(WALLET_A, 'corpus-api')).granted) granted++;
  }

  assert.equal(granted, 0, '3 baseline × 0.25 standing rounds to nothing');
});

// -------------------------------------------------- the Sybil property, again

/// The reason this shares the identity layer with the money pool at all. Two
/// wallets of one operator draw on one share — otherwise an operator throttled on
/// an API just registers a second agent.
test('two wallets of one operator share one allowance', async () => {
  const {commons} = commonsWith();

  assert.equal((await commons.request(WALLET_A, 'corpus-api')).granted, true);
  assert.equal((await commons.request(WALLET_B, 'corpus-api')).granted, true);
  assert.equal((await commons.request(WALLET_A, 'corpus-api')).granted, true);

  const fourth = await commons.request(WALLET_B, 'corpus-api');
  assert.equal(fourth.granted, false, 'a second wallet bought a second allowance');
});

// ------------------------------------------------------------------ refusing

/// The whole point of sharing the identity layer: an operator barred from
/// spending money must not simply carry on using the expensive API instead.
test('a barred operator gets no credential at all', async () => {
  const before = issued;
  const {commons, records} = commonsWith({barred: true, multiplierBps: 30_000n});

  const decision = await commons.request(WALLET_A, 'corpus-api');

  assert.equal(decision.granted, false);
  assert.equal(!decision.granted && decision.reason, 'barred');
  assert.match(!decision.granted ? decision.explanation : '', /not a quota you can wait out/);
  assert.equal(issued, before, 'a barred operator was issued a credential');
  assert.deepEqual(records, [{granted: false, reason: 'barred'}]);
});

test('an unverified agent is told to verify, not that it is barred', async () => {
  const {commons} = commonsWith({humanId: null});

  const decision = await commons.request(WALLET_A, 'corpus-api');

  assert.equal(decision.granted, false);
  assert.equal(!decision.granted && decision.reason, 'not-human-backed');
  assert.doesNotMatch(!decision.granted ? decision.explanation : 'x', /barred/);
});

/// Some resources are expensive enough that a cheap signal should not reach them
/// however good the record.
test('a resource can demand stronger evidence than standing can substitute for', async () => {
  const {commons} = commonsWith({assurance: 1, multiplierBps: 30_000n}, [
    corpus({id: 'gpu-cluster', minAssurance: 3, description: 'A seat on the compute cluster'}),
  ]);

  const decision = await commons.request(WALLET_A, 'gpu-cluster');

  assert.equal(decision.granted, false);
  assert.equal(!decision.granted && decision.reason, 'below-minimum-assurance');
});

test('asking for something nobody shares is refused clearly', async () => {
  const {commons} = commonsWith();

  const decision = await commons.request(WALLET_A, 'nothing-like-this');

  assert.equal(decision.granted, false);
  assert.equal(!decision.granted && decision.reason, 'no-such-resource');
});

// ------------------------------------------------------------------ planning

/// An agent planning its work must be able to ask what it may have without
/// spending the very thing it is asking about.
test('surveying does not consume any quota', async () => {
  const {commons} = commonsWith();

  for (let i = 0; i < 20; i++) await commons.survey(WALLET_A);

  const decision = await commons.request(WALLET_A, 'corpus-api');
  assert.equal(decision.granted, true, 'surveying burned the allowance');
  assert.equal(decision.granted && decision.remaining, 2, 'surveying moved the counter');
});

test('a survey says what is available and why not', async () => {
  const {commons} = commonsWith({assurance: 1}, [
    corpus(),
    corpus({id: 'gpu-cluster', minAssurance: 3}),
  ]);

  const survey = await commons.survey(WALLET_A);

  assert.deepEqual(survey, [
    {resourceId: 'corpus-api', available: true},
    {resourceId: 'gpu-cluster', available: false, reason: 'below-minimum-assurance'},
  ]);
});

test('a barred operator sees nothing as available', async () => {
  const {commons} = commonsWith({barred: true});

  const survey = await commons.survey(WALLET_A);

  assert.ok(survey.every((s) => !s.available));
  assert.ok(survey.every((s) => s.reason === 'barred'));
});

// -------------------------------------------------------------------- audit

/// The record has to be keepable. It carries the anonymous identifier the
/// protocol already uses and nothing else — no credential, and nothing that
/// points at a person.
test('the audit record carries no credential', async () => {
  const seen: unknown[] = [];
  const standing = standingStub();
  const commons = createResourceCommons({
    standing,
    limiter: createStandingRateLimit({standing}),
    resources: [corpus()],
    onDecision: (r) => seen.push(r),
  });

  await commons.request(WALLET_A, 'corpus-api');

  const record = JSON.stringify(seen[0]);
  assert.doesNotMatch(record, /secret-key/, 'a credential reached the audit log');
  assert.match(record, /"granted":true/);
  assert.match(record, new RegExp(HUMAN.slice(2, 20)));
});

test('the catalogue does not say who may have what', async () => {
  const {commons} = commonsWith({barred: true});

  const listed = commons.catalogue();

  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0] ?? {}).sort(), ['baseLimit', 'description', 'id']);
});

// ------------------------------------------------------- through the toolbelt

test('an agent plans, then requests, through its own toolbelt', async () => {
  const {createVotiveAgent} = await import('../dist/agent.js');
  const {fakeRail} = await import('./fakeRail.ts');
  const {rail} = fakeRail();

  const standing = standingStub();
  const resources = createResourceCommons({
    standing,
    limiter: createStandingRateLimit({standing}),
    resources: [corpus(), corpus({id: 'gpu-cluster', minAssurance: 3})],
  });
  const agent = createVotiveAgent({rail, wallet: WALLET_A, standing, resources});

  const names = agent.tools().map((t) => t.name);
  assert.ok(names.includes('votive_list_resources'));
  assert.ok(names.includes('votive_request_resource'));

  // Plan first — this must not cost anything.
  const listed = await agent.call('votive_list_resources', {});
  assert.equal(listed.ok, true);
  assert.match(listed.summary, /1 of 2 shared resources/);

  // Then take what the job needs.
  const got = await agent.call('votive_request_resource', {resourceId: 'corpus-api'});
  assert.equal(got.ok, true);
  assert.match(got.summary, /access granted to corpus-api/);
  assert.match(got.summary, /2 of 3 uses left/);

  // And the one it is not evidenced enough for is refused with a reason.
  const refused = await agent.call('votive_request_resource', {resourceId: 'gpu-cluster'});
  assert.equal(refused.ok, false);
  assert.match(refused.summary, /assurance tier 3 or better/);
});

test('a barred operator is refused resources through the toolbelt too', async () => {
  const {createVotiveAgent} = await import('../dist/agent.js');
  const {fakeRail} = await import('./fakeRail.ts');
  const {rail} = fakeRail();

  const standing = standingStub({barred: true});
  const resources = createResourceCommons({
    standing,
    limiter: createStandingRateLimit({standing}),
    resources: [corpus()],
  });
  const agent = createVotiveAgent({rail, wallet: WALLET_A, standing, resources});

  const result = await agent.call('votive_request_resource', {resourceId: 'corpus-api'});

  assert.equal(result.ok, false);
  assert.match(result.summary, /barred/);
});

test('the resource tools are hidden when the agent cannot perform them', async () => {
  const {createVotiveAgent} = await import('../dist/agent.js');
  const {fakeRail} = await import('./fakeRail.ts');
  const {rail} = fakeRail();

  const names = createVotiveAgent({rail}).tools().map((t) => t.name);
  assert.ok(!names.includes('votive_request_resource'));
});
