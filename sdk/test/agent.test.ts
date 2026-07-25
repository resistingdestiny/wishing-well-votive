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

  assert.deepEqual(names, ['hedera_pay', 'hedera_x402_buy']);
});

test('an agent with a bounty client offers all four', () => {
  const {rail} = fakeRail();
  const agent = createVotiveAgent({
    rail,
    bounty: {
      async claim() { return {transactionHash: '0xclaim'}; },
      async withdraw() { return {transactionHash: '0xwithdraw'}; },
      async credited() { return 300_000_000n; },
    },
  });

  assert.equal(agent.tools().length, 4);
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
