import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createVotiveAgent} from '../dist/agent.js';
import {fakeRail} from './fakeRail.ts';

/**
 * An agent's whole working day, through the toolbelt a model actually drives.
 *
 * The unit tests hold each skill to its own promises. This is about the order:
 * that an agent handed a wish screens it before it claims anything, checks what it
 * is allowed to spend before it plans, spends, delivers, and collects — and that
 * every one of those steps refuses in the right way when the operator behind it
 * has been barred.
 *
 * Everything is faked below the toolbelt on purpose. The point is the sequence a
 * model is steered through, not the chain underneath it, and that sequence has to
 * be checkable without credentials.
 */

const HUMAN = `0x${'aa'.repeat(32)}` as const;

function standingStub(options: {barred?: boolean; remaining?: bigint; humanId?: string | null} = {}) {
  const humanId = options.humanId === undefined ? HUMAN : options.humanId;
  return {
    async snapshot() {
      return {
        humanId: humanId as `0x${string}` | null,
        assurance: 2,
        barred: options.barred ?? false,
        multiplierBps: options.barred ? 0n : 12_000n,
        ceiling: 1_000n,
        remaining: options.remaining ?? 600n,
      };
    },
    async isBarred() {
      return options.barred ?? false;
    },
    async multiplierBps() {
      return options.barred ? 0n : 12_000n;
    },
  };
}

function bountyStub() {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async claim() {
        calls.push('claim');
        return {transactionHash: '0xclaim'};
      },
      async withdraw() {
        calls.push('withdraw');
        return {transactionHash: '0xwithdraw'};
      },
      async credited() {
        return 450_000_000n;
      },
    },
  };
}

// ------------------------------------------------------------- the good day

test('an agent screens, checks its budget, claims, pays and collects', async () => {
  const {rail, transfers} = fakeRail();
  const bounty = bountyStub();
  const agent = createVotiveAgent({
    rail,
    bounty: bounty.client,
    wallet: '0xagent',
    standing: standingStub(),
  });

  // Everything it needs is on the belt, with descriptions a model can act on.
  const names = agent.tools().map((t) => t.name);
  assert.deepEqual(names.sort(), [
    'hedera_pay',
    'hedera_x402_buy',
    'votive_claim_bounty',
    'votive_my_standing',
    'votive_screen_wish',
    'votive_withdraw_earnings',
  ]);
  for (const tool of agent.tools()) {
    assert.ok(tool.description.length > 40, `${tool.name} needs a description a model can act on`);
  }

  // 1. Read the wish before touching it.
  const screened = await agent.call('votive_screen_wish', {
    text: 'Translate this 14th-century tablet and publish the reading',
  });
  assert.equal(screened.ok, true, 'an ordinary wish was refused');

  // 2. Find out what may be spent, before planning work that costs money.
  const standing = await agent.call('votive_my_standing', {});
  assert.equal(standing.ok, true);
  assert.match(standing.summary, /600 left to spend/);

  // 3. Take the task exclusively.
  const claimed = await agent.call('votive_claim_bounty', {bountyId: '7'});
  assert.equal(claimed.ok, true);
  assert.deepEqual(bounty.calls, ['claim']);

  // 4. Pay for something the job needs.
  const paid = await agent.call('hedera_pay', {
    instruction: 'pay:0.0.4242:2:corpus licence',
  });
  assert.equal(paid.ok, true);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0]?.tinybars, 200_000_000n);

  // 5. Collect.
  const withdrawn = await agent.call('votive_withdraw_earnings', {});
  assert.equal(withdrawn.ok, true);
  assert.match(withdrawn.summary, /4\.5 ℏ/);
  assert.deepEqual(bounty.calls, ['claim', 'withdraw']);
});

// -------------------------------------------------------------- the dark day

test('a harmful wish stops the agent before it claims or spends anything', async () => {
  const {rail, transfers} = fakeRail();
  const bounty = bountyStub();
  const agent = createVotiveAgent({
    rail,
    bounty: bounty.client,
    wallet: '0xagent',
    standing: standingStub(),
  });

  const screened = await agent.call('votive_screen_wish', {
    text: 'Have this person killed, I will pay whatever it takes',
  });

  assert.equal(screened.ok, false);
  assert.match(screened.summary, /do not claim it or spend on it/i);
  // Nothing else was reached, because the screen came first and said no.
  assert.deepEqual(bounty.calls, [], 'it claimed a wish it had been told to refuse');
  assert.equal(transfers.length, 0, 'it spent on a wish it had been told to refuse');
});

test('a barred operator is told to stop, and its standing reads zero', async () => {
  const {rail} = fakeRail();
  const agent = createVotiveAgent({
    rail,
    bounty: bountyStub().client,
    wallet: '0xagent',
    standing: standingStub({barred: true}),
  });

  const standing = await agent.call('votive_my_standing', {});

  assert.equal(standing.ok, false);
  assert.match(standing.summary, /barred/);
  assert.match(standing.summary, /do not take on work/i);
});

test('an unverified agent is told to get verified, not that it misbehaved', async () => {
  const {rail} = fakeRail();
  const agent = createVotiveAgent({
    rail,
    wallet: '0xagent',
    standing: standingStub({humanId: null}),
  });

  const standing = await agent.call('votive_my_standing', {});

  assert.equal(standing.ok, false);
  assert.match(standing.summary, /no verified human/i);
  assert.doesNotMatch(standing.summary, /barred/);
});

// ------------------------------------------------------------- the x402 leg

test('the agent buys one use of a paid API it has no account with', async () => {
  const {rail, transfers} = fakeRail();
  const seen: string[] = [];
  const fetchImpl = async (url: string, init?: {headers?: Record<string, string>}) => {
    const paid = init?.headers?.['x-payment'] !== undefined;
    seen.push(paid ? 'paid' : 'quoted');
    if (!paid) {
      return {
        status: 402,
        json: async () => ({payTo: '0.0.9001', amountHbar: '0.4'}),
        text: async () => 'payment required',
      };
    }
    return {status: 200, json: async () => ({}), text: async () => 'the translation'};
  };

  const agent = createVotiveAgent({rail, fetchImpl, wallet: '0xagent'});
  const result = await agent.call('hedera_x402_buy', {
    instruction: 'buy:https://api.example.com/ocr:1:tablet',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(seen, ['quoted', 'paid'], 'the 402 handshake did not happen');
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0]?.tinybars, 40_000_000n);
});

test('a service asking above the signed cap is not paid, and the job stops', async () => {
  const {rail, transfers} = fakeRail();
  const fetchImpl = async () => ({
    status: 402,
    json: async () => ({payTo: '0.0.9001', amountHbar: '50'}),
    text: async () => 'payment required',
  });

  const agent = createVotiveAgent({rail, fetchImpl, wallet: '0xagent'});
  const result = await agent.call('hedera_x402_buy', {
    instruction: 'buy:https://api.example.com/ocr:1:tablet',
  });

  assert.equal(result.ok, false);
  assert.equal(transfers.length, 0, 'it paid over the cap it was given');
});
