/**
 * What a consumer of the published package can actually reach — and the two
 * behaviours that only exist because of what it can now reach.
 *
 * The regression this file exists for is not a bug in any function. It is that
 * `VotiveAgentConfig` has always *required* a `StandingView` and a
 * `ResourceCommons`, while `src/index.ts` exported neither the constructor for
 * one nor the constructor for the other. Every other test in this suite imports
 * straight out of `dist/world/…`, so every one of them passed against a package
 * whose documented examples could not be typed, let alone run. These import from
 * the entry point only, exactly as `npm install` would.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import * as sdk from '../dist/index.js';
import {fakeRail} from './fakeRail.ts';

// ------------------------------------------------------------ the entry point

/**
 * The symbols the skills catalogue on `/agents/skills` names in its code samples.
 *
 * `scripts/check-skills.ts` checks the other direction — that every symbol the
 * catalogue mentions resolves here — and would catch a sample citing something
 * that never existed. This list catches the opposite and more likely mistake: an
 * export quietly dropped in a refactor, breaking published instructions that
 * nothing in the SDK's own suite would otherwise exercise.
 */
const MUST_EXPORT = [
  // the rail and the payment skills
  'createHederaRail',
  'hbarToTinybars',
  'tinybarsToHbar',
  'explorerUrl',
  'toMirrorId',
  'payHbar',
  'x402Buy',
  'parsePayInstruction',
  'parseBuyInstruction',
  'parseRequirements',
  'ACCOUNT_ID',
  'HBAR_DECIMALS',
  // the agent
  'createVotiveAgent',
  'railCalldata',
  // screening
  'screenWish',
  'toConductReport',
  'isPermanentlyBarring',
  'ConductCategory',
  'ConductSeverity',
  // identity and standing
  'createAgentBook',
  'humanIdToBytes32',
  'keccak256Utf8',
  'planAttestation',
  'planAttestations',
  'AssuranceTier',
  'createStandingView',
  'standingCalldata',
  'STANDING_SELECTORS',
  'encodeAddress',
  'encodeWord',
  'encodeUint',
  'decodeUint',
  'decodeBool',
  'decodeWord',
  // the toolbelt
  'createResourceCommons',
  'createOnchainResourceView',
  'createOnchainResourceCommons',
  'createResourceProvider',
  'explainRefusal',
  'ResourceRefusal',
  'RESOURCE_SELECTORS',
  'createStandingRateLimit',
] as const;

test('every symbol the catalogue documents is reachable from the package root', () => {
  const missing = MUST_EXPORT.filter((name) => (sdk as Record<string, unknown>)[name] === undefined);
  assert.deepEqual(missing, [], `not exported from the package entry point: ${missing.join(', ')}`);
});

test('the two selector tables are distinguishable by name', () => {
  // Both used to be called `SELECTORS` in their own module. Exporting both from
  // one entry point without renaming is not possible, and picking whichever won
  // would silently give a builder the wrong contract's calldata.
  assert.equal(sdk.STANDING_SELECTORS.attest, '0x9bdcc9a4');
  assert.equal(sdk.RESOURCE_SELECTORS.requestAccess, '0x841fb503');
});

// ------------------------------------------- a fully equipped agent, from root

const REGISTRY = '0x1111111111111111111111111111111111111111';
const LEDGER = '0x2222222222222222222222222222222222222222';
const RESOURCES = '0x3333333333333333333333333333333333333333';
const WALLET = '0x00000000000000000000000000000000000000a1';
const HUMAN = `0x${'ab'.repeat(32)}`;
const CORPUS = `0x${'cc'.repeat(32)}`;
const GRANT = `0x${'11'.repeat(32)}`;

const word = (value: bigint | boolean | string): string => {
  if (typeof value === 'string') return value.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return (typeof value === 'boolean' ? (value ? 1n : 0n) : value).toString(16).padStart(64, '0');
};

/** An `eth_call` answering machine keyed by selector, recording what it was asked. */
function chain(answers: Record<string, string>) {
  const calls: {to: string; data: string}[] = [];
  const read: sdk.ChainReader = async ({to, data}) => {
    calls.push({to, data});
    return answers[data.slice(0, 10)] ?? '0x';
  };
  return {read, calls};
}

function equippedAgent(overrides: Partial<sdk.OnchainCommonsOptions> = {}) {
  const {read, calls} = chain({
    [sdk.STANDING_SELECTORS.humanOf]: `0x${word(HUMAN)}`,
    [sdk.STANDING_SELECTORS.assuranceOf]: `0x${word(2n)}`,
    [sdk.STANDING_SELECTORS.isBarred]: `0x${word(false)}`,
    [sdk.STANDING_SELECTORS.multiplierBpsOf]: `0x${word(10_000n)}`,
    [sdk.RESOURCE_SELECTORS.quote]: `0x${word(true)}${word(0n)}${word(12n)}${word(5n)}`,
  });

  const standing = sdk.createStandingView(read, {registry: REGISTRY, ledger: LEDGER});
  const submitted: string[] = [];
  const collected: string[] = [];

  const resources = sdk.createOnchainResourceCommons({
    read,
    registry: RESOURCES,
    standing,
    catalogue: [{id: CORPUS, description: 'a licensed corpus API', baseLimit: 5}],
    async submit(request) {
      submitted.push(request.data);
      return {grantId: GRANT};
    },
    async collect(grant) {
      collected.push(grant.grantId);
      return 'sk-the-actual-secret';
    },
    ...overrides,
  });

  const agent = sdk.createVotiveAgent({
    rail: fakeRail().rail,
    bounty: {
      async claim() {
        return {transactionHash: '0xdead'};
      },
      async withdraw() {
        return {transactionHash: '0xbeef'};
      },
      async credited() {
        return 0n;
      },
    },
    standing,
    resources,
    wallet: WALLET,
  });

  return {agent, resources, standing, calls, submitted, collected};
}

test('an agent built only from package-root exports offers all eight tools', () => {
  const {agent} = equippedAgent();

  assert.deepEqual(
    agent.tools().map((tool) => tool.name).sort(),
    [
      'hedera_pay',
      'hedera_x402_buy',
      'votive_claim_bounty',
      'votive_list_resources',
      'votive_my_standing',
      'votive_request_resource',
      'votive_screen_wish',
      'votive_withdraw_earnings',
    ]
  );
});

test('votive_request_resource reaches ResourceRegistry and comes back with a credential', async () => {
  const {agent, submitted, collected} = equippedAgent();

  const result = await agent.call('votive_request_resource', {resourceId: CORPUS});

  assert.equal(result.ok, true);
  assert.equal(submitted.length, 1, 'nothing was broadcast to the registry');
  assert.ok(
    submitted[0]?.startsWith(sdk.RESOURCE_SELECTORS.requestAccess),
    'the broadcast calldata was not requestAccess'
  );
  assert.deepEqual(collected, [GRANT]);
});

// ------------------------------------------------- the on-chain commons itself

test('surveying costs no quota — it only ever asks quote', async () => {
  const {resources, calls, submitted} = equippedAgent();

  const survey = await resources.surveyOnchain(WALLET);

  assert.equal(survey[0]?.available, true);
  assert.equal(survey[0]?.remaining, 5);
  assert.equal(submitted.length, 0, 'a survey broadcast a transaction');
  assert.ok(
    calls.every((call) => !call.data.startsWith(sdk.RESOURCE_SELECTORS.requestAccess)),
    'a survey asked for access'
  );
});

test('a refused quote never reaches the signer', async () => {
  const {read} = chain({
    [sdk.RESOURCE_SELECTORS.quote]: `0x${word(false)}${word(4n)}${word(0n)}${word(0n)}`,
  });
  let submits = 0;
  const commons = sdk.createOnchainResourceCommons({
    read,
    registry: RESOURCES,
    standing: sdk.createStandingView(read, {registry: REGISTRY, ledger: LEDGER}),
    catalogue: [{id: CORPUS, description: 'a licensed corpus API', baseLimit: 5}],
    async submit() {
      submits += 1;
      return {grantId: GRANT};
    },
    async collect() {
      return 'sk-should-never-exist';
    },
  });

  const outcome = await commons.requestOnchain(WALLET, CORPUS);

  assert.equal(outcome.granted, false);
  assert.equal(submits, 0, 'a refused request still sent a transaction');
  assert.ok(!outcome.granted && outcome.refusal === sdk.ResourceRefusal.Barred);
  assert.match(
    (outcome as {explanation: string}).explanation,
    /not a quota you can wait out/,
    'the registry’s own sentence was lost'
  );
});

/**
 * The failure that costs money twice if it is reported as an ordinary refusal.
 * `requestAccess` has already incremented the per-human counter and there is no
 * function that decrements it, so a caller that retried the *request* would buy a
 * second grant it already owns.
 */
test('a grant issued but not collected reports the grant id, not a plain refusal', async () => {
  const {resources} = equippedAgent({
    async collect() {
      throw new Error('provider unreachable');
    },
  });

  const outcome = await resources.requestOnchain(WALLET, CORPUS);

  assert.equal(outcome.granted, false);
  assert.equal((outcome as {grantId?: string}).grantId, GRANT);
  assert.match((outcome as {explanation: string}).explanation, /already spent/);
  assert.match((outcome as {explanation: string}).explanation, /retry the collection/);
});

test('an id the agent was never given is refused before any gas is spent', async () => {
  const {resources, calls} = equippedAgent();

  const outcome = await resources.requestOnchain(WALLET, `0x${'ff'.repeat(32)}`);

  assert.equal(outcome.granted, false);
  assert.equal(calls.length, 0, 'an unknown id still hit the chain');
});

// --------------------------------------------------------- the provider side

/**
 * A grant id is public — `AccessGranted` emits it — so whoever hands one to a
 * provider is not thereby proving anything about themselves. Before this, the
 * wallet the credential was scoped to came from the caller's own argument, and
 * `isGrantReleasable` could not catch it: that function validates the grant's
 * *stored* wallet and never sees the claim, so it would have answered `true`
 * throughout.
 */
test('a released credential is scoped to the wallet the registry recorded, not the one claimed', async () => {
  const IMPOSTOR = '0x00000000000000000000000000000000000000ff';
  const {read} = chain({
    [sdk.RESOURCE_SELECTORS.isGrantReleasable]: `0x${word(true)}${word(0n)}`,
    [sdk.RESOURCE_SELECTORS.grantOf]:
      `0x${word(CORPUS)}${word(HUMAN)}${word(WALLET)}${word(1_700_000_000n)}${word(1_700_003_600n)}`,
  });

  const seen: {wallet: string; humanId: string; resourceId: string}[] = [];
  const provider = sdk.createResourceProvider({
    read,
    registry: RESOURCES,
    issue: async (grant) => {
      seen.push({wallet: grant.wallet, humanId: grant.humanId, resourceId: grant.resourceId});
      return 'sk-the-actual-secret';
    },
  });

  const credential = await provider.release(GRANT, {resourceId: CORPUS, wallet: IMPOSTOR});

  assert.equal(credential, 'sk-the-actual-secret');
  assert.equal(seen[0]?.wallet, WALLET, 'the credential was scoped to the claimed wallet');
  assert.equal(seen[0]?.humanId, HUMAN);
  assert.equal(seen[0]?.resourceId, CORPUS);
});

test('the grant a provider reads back is the registry’s five fields', async () => {
  const {read} = chain({
    [sdk.RESOURCE_SELECTORS.grantOf]:
      `0x${word(CORPUS)}${word(HUMAN)}${word(WALLET)}${word(1_700_000_000n)}${word(1_700_003_600n)}`,
  });
  const provider = sdk.createResourceProvider({
    read,
    registry: RESOURCES,
    issue: async () => 'x',
  });

  const grant = await provider.grant(GRANT);

  assert.equal(grant.resourceId, CORPUS);
  assert.equal(grant.humanId, HUMAN);
  assert.equal(grant.wallet, WALLET);
  assert.equal(grant.expiresAt - grant.issuedAt, 3600, 'GRANT_LIFETIME is one hour');
});

test('a refused grant is never even looked up, and mints nothing', async () => {
  const {read, calls} = chain({
    [sdk.RESOURCE_SELECTORS.isGrantReleasable]: `0x${word(false)}${word(4n)}`,
  });
  let minted = 0;
  const provider = sdk.createResourceProvider({
    read,
    registry: RESOURCES,
    issue: async () => {
      minted += 1;
      return 'sk-should-never-exist';
    },
  });

  const credential = await provider.release(GRANT);

  assert.equal(credential, null);
  assert.equal(minted, 0);
  assert.ok(
    calls.every((call) => !call.data.startsWith(sdk.RESOURCE_SELECTORS.grantOf)),
    'a refused grant was still read'
  );
});
