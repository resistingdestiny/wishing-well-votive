import assert from 'node:assert/strict';
import {test} from 'node:test';

/**
 * The opcode indices the browser has to hardcode.
 *
 * On chain they are positions in a table of function pointers, resolved by
 * scanning it. A client cannot scan function pointers, so these are constants —
 * and a wrong constant does not fail loudly, it runs a different instruction.
 * `aqua/script/PrintOpcodes.s.sol` prints them from the same table the router
 * builds; these pin what it printed.
 */
test('the official opcode indices are the ones the router registers', async () => {
  const {OFFICIAL_OPCODES, VOTIVE_OPCODE_BASE, VOTIVE_OPCODES} = await import(
    '../../src/lib/aquaProgram.ts'
  );

  assert.equal(OFFICIAL_OPCODES.xycSwapXD, 17);
  assert.equal(OFFICIAL_OPCODES.salt, 20);
  // The official table's length. Our instructions begin here.
  assert.equal(VOTIVE_OPCODE_BASE, 33);

  // Order matters: the router registers them in exactly this sequence, and a
  // program encoded against different offsets means something else.
  assert.deepEqual(VOTIVE_OPCODES, {
    onlyCapabilityOpen: 0,
    onlyConditionMet: 1,
    onlyVotiveLive: 2,
    performanceFee: 3,
    onlyHumanBackedFiller: 4,
    onlyFillerInGoodStanding: 5,
    fillerStandingBonus: 6,
  });
});

test('an instruction is opcode, length, then args', async () => {
  const {instruction} = await import('../../src/lib/aquaProgram.ts');

  assert.equal(instruction(17, ''), '0x1100');
  assert.equal(instruction(33, '0xdeadbeef'), '0x210404deadbeef'.replace('0404', '04'));
  // Length is the byte count of the args, not their hex length.
  const withAddress = instruction(35, `0x${'ab'.repeat(20)}`);
  assert.equal(withAddress.slice(0, 6), '0x2314');
});

test('args longer than a byte can describe are refused', async () => {
  const {instruction} = await import('../../src/lib/aquaProgram.ts');
  assert.throws(() => instruction(1, `0x${'ff'.repeat(256)}`), /too long/);
});

/**
 * The traits word for the shape a votive uses: no hooks, no receiver, Aqua
 * balances instead of a signature. Every hook slice being empty is what makes
 * every length index zero and leaves a single flag standing.
 */
test('the order is the one flag a votive needs and nothing else', async () => {
  const {buildVotiveOrder} = await import('../../src/lib/aquaProgram.ts');

  const order = buildVotiveOrder(`0x${'11'.repeat(20)}`, '0xabcd');
  assert.equal(order.traits, 1n << 254n);
  assert.equal(order.data, '0xabcd');
});

/**
 * The taker side of a fill, pinned against Solidity.
 *
 * These three strings are what `TakerTraitsLib.build` actually printed for the
 * browser filler's exact arguments — see `aqua/script/PrintTakerTraits.s.sol`.
 * They are not a second reading of the bit table. Two readings of a spec agree
 * with each other far more often than either agrees with the code, and a wrong
 * bit here does not fail loudly: it produces a fill that reverts somewhere deep
 * in the VM, or one that succeeds on terms the screen never showed.
 */
test('taker traits encode exactly as the Solidity library does', async () => {
  const {buildTakerTraits} = await import('../../src/lib/aquaProgram.ts');

  // No floor: every slice index is zero, so the whole head is the flag word.
  // 0x61 = exactIn | firstTransferFromTaker | transferFromAndAquaPush.
  assert.equal(
    buildTakerTraits(),
    '0x00000000000000000000000000000000000000000061',
  );

  // With a floor the threshold occupies 32 bytes, so every index from it
  // onwards is 0x0020 — each slice ends where everything before it ended.
  assert.equal(
    buildTakerTraits({minAmountOut: 15_000000000000000000n}),
    '0x00200020002000200020002000200020002000200061' +
      '000000000000000000000000000000000000000000000000d02ab486cedc0000',
  );

  assert.equal(
    buildTakerTraits({minAmountOut: 1n}),
    '0x00200020002000200020002000200020002000200061' +
      '0000000000000000000000000000000000000000000000000000000000000001',
  );
});

/**
 * The flag combination is the whole reason a person can fill from a wallet.
 *
 * A wallet cannot implement the pre-transfer callback the test taker pays
 * through, so the callback bits must stay clear and the transferFrom+push path
 * must stay set. If this ever flips, filling silently becomes contracts-only.
 */
test('the filler path needs no callback contract', async () => {
  const {buildTakerTraits} = await import('../../src/lib/aquaProgram.ts');
  const flags = parseInt(buildTakerTraits().slice(-4), 16);

  assert.equal(flags & 0x0004, 0, 'pre-transfer-in callback must be off');
  assert.equal(flags & 0x0008, 0, 'pre-transfer-out callback must be off');
  assert.equal(flags & 0x0040, 0x0040, 'transferFrom + Aqua push must be on');
  // The fee is pulled from the maker in the token coming in, so the quote has
  // to arrive before it is taken.
  assert.equal(flags & 0x0020, 0x0020, 'taker leg must settle first');
});
