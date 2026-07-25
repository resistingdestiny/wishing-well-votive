import assert from 'node:assert/strict';
import {test} from 'node:test';

import {humanIdToBytes32, keccak256Utf8} from '../dist/world/agentBook.js';

/**
 * Known answers taken from Solidity's own `keccak256`, not from another
 * JavaScript implementation. The identifier this produces is the key an
 * operator's whole standing and any bar against them hangs off, so it has to
 * agree with the contract exactly and forever — a digest that is merely
 * self-consistent would silently detach every human from their record.
 */
const SOLIDITY_VECTORS: [string, string][] = [
  ['', '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
  ['abc', '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'],
  ['human:alice', '0xd82b4073c56eccb9b580c75303821b1aecd542912c9a6c951ed1ee675fcd6b6a'],
  ['0.0.9699740', '0xc6bccb672cfa4446eaa732b5e34457aaca0199d237d1041b5fc0aaa6ce3366fa'],
];

test('keccak256 agrees with Solidity on known answers', () => {
  for (const [input, expected] of SOLIDITY_VECTORS) {
    assert.equal(keccak256Utf8(input), expected, `digest differs for ${JSON.stringify(input)}`);
  }
});

/**
 * The rate is 136 bytes, so these are the lengths where a wrong padding or a
 * mishandled second block shows up. The first draft of this module had truncated
 * round constants and passed nothing at all; a single short vector would have
 * caught that, but only lengths either side of a block boundary catch an absorb
 * bug, which is the more likely mistake to survive review.
 */
test('keccak256 is right either side of every block boundary', () => {
  // Also from Solidity. One short vector would have caught the truncated round
  // constants the first draft shipped with, but only lengths straddling a block
  // boundary catch an absorb or padding bug — the mistake likelier to survive
  // review, since the digest still looks like a digest.
  const boundaries: [number, string][] = [
    [135, '0x16570bdb055e663ea1cb57ac6f09194f4bc7b7070847971fc0b86710366dc34f'],
    [136, '0x50da8ef3747b7a7f01d08563aa11c72a2a668563fb928adc6e8d2a1ab4e36096'],
    [137, '0x01e0852c139fa337a5d3f746ab3b2d3400442195225e2f10c34702f8f37ae8d3'],
    [271, '0xe1a7e54686b1e56716c253c5ca60f99d092dcc617eb3fe99978ca4f551f89423'],
    [272, '0x96bc2208643ac0c338f0aee0c5fce6b05e3deab879d939a413e8094ab5895377'],
    [273, '0x16b72899755a903874422b4ed4d2a566f0500f7f63396720d650982a118d2e1b'],
  ];
  for (const [length, expected] of boundaries) {
    assert.equal(keccak256Utf8('x'.repeat(length)), expected, `digest differs at length ${length}`);
  }
});

test('every length up to 300 gives a distinct, stable, well-formed digest', () => {
  const seen = new Set<string>();
  for (let n = 0; n <= 300; n++) {
    const digest = keccak256Utf8('x'.repeat(n));
    assert.match(digest, /^0x[0-9a-f]{64}$/, `malformed digest at length ${n}`);
    assert.equal(digest, keccak256Utf8('x'.repeat(n)), `unstable digest at length ${n}`);
    assert.ok(!seen.has(digest), `collision at length ${n}`);
    seen.add(digest);
  }
  assert.equal(seen.size, 301);
});

// --------------------------------------------------------------- identifiers

test('an identifier already 32 bytes wide passes straight through', () => {
  const word = `0x${'AB'.repeat(32)}`;
  assert.equal(humanIdToBytes32(word), `0x${'ab'.repeat(32)}`);
});

/// Two spellings of one identifier must not become two humans, each with their own
/// standing and neither carrying the other's bar.
test('case does not split one human into two', () => {
  const lower = humanIdToBytes32(`0x${'ab'.repeat(32)}`);
  const upper = humanIdToBytes32(`0x${'AB'.repeat(32)}`);
  assert.equal(lower, upper);
});

test('an opaque identifier is hashed to a stable word', () => {
  const once = humanIdToBytes32('worldid:opaque-token-from-agentbook');
  const twice = humanIdToBytes32('worldid:opaque-token-from-agentbook');
  assert.equal(once, twice);
  assert.match(once, /^0x[0-9a-f]{64}$/);
  assert.notEqual(once, humanIdToBytes32('worldid:a-different-token'));
});

test('surrounding whitespace is not a different person', () => {
  assert.equal(humanIdToBytes32('  token  '), humanIdToBytes32('token'));
});

test('an empty identifier is refused rather than hashed to a constant', () => {
  assert.throws(() => humanIdToBytes32(''));
  assert.throws(() => humanIdToBytes32('   '));
});
