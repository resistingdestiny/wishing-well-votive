import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createVotiveAgent, railCalldata} from '../dist/agent.js';
import {fakeRail} from './fakeRail.ts';

/**
 * These four-byte values are hand-written in agent.ts rather than derived from an
 * ABI at run time, so they are pinned here against the values `cast sig` produces
 * for the real contract. One of them was wrong when first written; this is why.
 */
test('the hand-encoded selectors match the contract', () => {
  assert.equal(railCalldata.withdraw(), '0x3ccfd60b');
  assert.ok(railCalldata.claim(1n).startsWith('0x379607f5'));
  assert.ok(railCalldata.credited('0x024A97D71B32E93ccEfa92aBeEc5326AfACA351C').startsWith('0xfdf60ec7'));
});

test('claim calldata pads its argument to a full word', () => {
  const data = railCalldata.claim(7n);
  assert.equal(data.length, 2 + 8 + 64, 'selector plus one 32-byte word');
  assert.ok(data.endsWith('7'));
});

test('credited calldata left-pads the address', () => {
  const data = railCalldata.credited('0xabc');
  assert.equal(data.length, 2 + 8 + 64);
  assert.ok(data.endsWith('abc'));
});

// ------------------------------------------------------------------- toolbelt

test('an agent without a bounty client does not offer bounty tools', () => {
  const {rail} = fakeRail();
  const agent = createVotiveAgent({rail});
  const names = agent.tools().map((t) => t.name);

  assert.deepEqual(names, ['hedera_pay', 'hedera_x402_buy', 'votive_screen_wish']);
});

/// Screening needs nothing but the wish text, and it is the one tool that must
/// never be missing from an agent that might be handed a harmful wish. So it is
/// offered whatever else the agent was configured with.
test('wish screening is always offered, however little else is configured', () => {
  const {rail} = fakeRail();
  const bare = createVotiveAgent({rail});

  assert.ok(bare.tools().some((t) => t.name === 'votive_screen_wish'));
});

test('the standing tool appears only when the agent can actually answer it', () => {
  const {rail} = fakeRail();
  const standing = {
    async snapshot() {
      return {humanId: `0x${'aa'.repeat(32)}` as const, assurance: 2, barred: false, multiplierBps: 10_000n};
    },
    async isBarred() { return false; },
    async multiplierBps() { return 10_000n; },
  };

  assert.ok(!createVotiveAgent({rail}).tools().some((t) => t.name === 'votive_my_standing'));
  assert.ok(
    !createVotiveAgent({rail, standing}).tools().some((t) => t.name === 'votive_my_standing'),
    'offered without knowing which wallet to ask about'
  );
  assert.ok(
    createVotiveAgent({rail, standing, wallet: '0xabc'})
      .tools()
      .some((t) => t.name === 'votive_my_standing')
  );
});

test('an agent with a bounty client offers the paid-work tools too', () => {
  const {rail} = fakeRail();
  const agent = createVotiveAgent({
    rail,
    bounty: {
      async claim() { return {transactionHash: '0xclaim'}; },
      async withdraw() { return {transactionHash: '0xwithdraw'}; },
      async credited() { return 300_000_000n; },
    },
  });

  assert.equal(agent.tools().length, 5);
  for (const tool of agent.tools()) {
    assert.ok(tool.description.length > 40, `${tool.name} needs a description a model can act on`);
    assert.equal(tool.input_schema.type, 'object');
  }
});

test('a tool call pays, through the same skill as a direct instruction', async () => {
  const {rail, transfers} = fakeRail();
  const agent = createVotiveAgent({rail});

  const result = await agent.call('hedera_pay', {instruction: 'pay:0.0.4242:1:x'});

  assert.equal(result.ok, true);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0]?.tinybars, 100_000_000n);
});

test('a misremembered tool name is refused, not guessed at', async () => {
  const {rail} = fakeRail();
  const agent = createVotiveAgent({rail});

  const result = await agent.call('hedera_send', {instruction: 'pay:0.0.4242:1:x'});
  assert.equal(result.ok, false);
  assert.match(result.summary, /no such tool/);
});

test('bounty tools fail cleanly when the agent has no chain client', async () => {
  const {rail} = fakeRail();
  const agent = createVotiveAgent({rail});

  const result = await agent.call('votive_claim_bounty', {bountyId: '1'});
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.detail), /without a bounty client/);
});

test('withdrawing reports what was collected', async () => {
  const {rail} = fakeRail();
  const agent = createVotiveAgent({
    rail,
    bounty: {
      async claim() { return {transactionHash: '0xclaim'}; },
      async withdraw() { return {transactionHash: '0xwithdraw'}; },
      async credited() { return 300_000_000n; },
    },
  });

  const result = await agent.call('votive_withdraw_earnings', {});
  assert.equal(result.ok, true);
  assert.match(result.summary, /withdrew 3 ℏ/);
});

test('an unrecognised instruction moves nothing', async () => {
  const {rail, transfers} = fakeRail();
  const agent = createVotiveAgent({rail});

  const outcome = await agent.run('transfer:0.0.1:5:x');
  assert.equal(outcome.ok, false);
  assert.equal(transfers.length, 0);
});

// ------------------------------------------------------------ world tools

/// A refusal comes back as ok:false so a model that treats a failed tool call as
/// "stop and reconsider" does the right thing without parsing the payload.
test('screening a harmful wish refuses it, loudly enough for a model to notice', async () => {
  const {rail} = fakeRail();
  const agent = createVotiveAgent({rail});

  const result = await agent.call('votive_screen_wish', {
    text: 'Have this person killed and I will pay well',
  });

  assert.equal(result.ok, false);
  assert.match(result.summary, /refuse this wish/i);
  assert.match(result.summary, /do not claim it/i);
});

test('screening an ordinary wish clears it', async () => {
  const {rail} = fakeRail();
  const agent = createVotiveAgent({rail});

  const result = await agent.call('votive_screen_wish', {
    text: 'Translate this 14th-century manuscript into modern English',
  });

  assert.equal(result.ok, true);
});

test('an agent whose operator is barred is told to stop', async () => {
  const {rail} = fakeRail();
  const agent = createVotiveAgent({
    rail,
    wallet: '0xabc',
    standing: {
      async snapshot() {
        return {
          humanId: `0x${'aa'.repeat(32)}` as const,
          assurance: 3,
          barred: true,
          multiplierBps: 0n,
        };
      },
      async isBarred() { return true; },
      async multiplierBps() { return 0n; },
    },
  });

  const result = await agent.call('votive_my_standing', {});

  assert.equal(result.ok, false);
  assert.match(result.summary, /barred/);
  assert.match(result.summary, /do not take on work/i);
});

test('an unverified agent is told to get verified, not that it is barred', async () => {
  const {rail} = fakeRail();
  const agent = createVotiveAgent({
    rail,
    wallet: '0xabc',
    standing: {
      async snapshot() {
        return {humanId: null, assurance: 0, barred: false, multiplierBps: 0n};
      },
      async isBarred() { return false; },
      async multiplierBps() { return 0n; },
    },
  });

  const result = await agent.call('votive_my_standing', {});

  assert.equal(result.ok, false);
  assert.match(result.summary, /no verified human/i);
  assert.doesNotMatch(result.summary, /barred/, 'unverified was reported as barred');
});

test('a verified agent is told what it may spend', async () => {
  const {rail} = fakeRail();
  const agent = createVotiveAgent({
    rail,
    wallet: '0xabc',
    standing: {
      async snapshot() {
        return {
          humanId: `0x${'aa'.repeat(32)}` as const,
          assurance: 2,
          barred: false,
          multiplierBps: 12_000n,
          ceiling: 1_000n,
          remaining: 400n,
        };
      },
      async isBarred() { return false; },
      async multiplierBps() { return 12_000n; },
    },
  });

  const result = await agent.call('votive_my_standing', {});

  assert.equal(result.ok, true);
  assert.match(result.summary, /tier 2/);
  assert.match(result.summary, /120%/);
  assert.match(result.summary, /400 left to spend/);
});
