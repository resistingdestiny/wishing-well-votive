/**
 * Skills an agent working on Votive can use to move value on Hedera and get paid
 * for the work.
 *
 * The shape is deliberately small. An agent decides *whether* to act; these
 * skills decide nothing — every destination and every amount comes from an
 * instruction its founder signed, and every payment is read back off the mirror
 * node before it is reported as done.
 */
export {
  createHederaRail,
  explorerUrl,
  hbarToTinybars,
  tinybarsToHbar,
  toMirrorId,
  ACCOUNT_ID,
  HBAR_DECIMALS,
} from './rail.js';
export type {Confirmation, HederaRail, RailConfig, Receipt} from './rail.js';

export {
  parseBuyInstruction,
  parsePayInstruction,
  parseRequirements,
  payHbar,
  x402Buy,
} from './skills/pay.js';
export type {
  BuyInstruction,
  FetchLike,
  PayInstruction,
  PaymentRequirements,
  SkillOutcome,
} from './skills/pay.js';
