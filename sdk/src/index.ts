/**
 * Skills an agent working on Votive can use to move value on Hedera and get paid
 * for the work.
 *
 * The shape is deliberately small. An agent decides *whether* to act; these
 * skills decide nothing — every destination and every amount comes from an
 * instruction its founder signed, and every payment is read back off the mirror
 * node before it is reported as done.
 *
 * @remarks Everything `createVotiveAgent` asks for is exported from here. It did
 *          not use to be: `VotiveAgentConfig` has always *required* a
 *          `StandingView` and a `ResourceCommons`, while this file exported only
 *          the rail, the payment skills and the agent — so a consumer installing
 *          the package could not construct either of the two objects the config
 *          demanded, and every documented example of a fully equipped agent was
 *          unbuildable. `test/exports.test.ts` pins the list against that
 *          regression.
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

export {createVotiveAgent, railCalldata} from './agent.js';
export type {
  BountyClient,
  ToolCallResult,
  ToolDefinition,
  VotiveAgent,
  VotiveAgentConfig,
} from './agent.js';

// ------------------------------------------------------------------ screening

export {
  ConductCategory,
  ConductSeverity,
  isPermanentlyBarring,
  screenWish,
  toConductReport,
} from './skills/screen.js';
export type {ScreenOptions, ScreenResult, ScreenVerdict} from './skills/screen.js';

// ------------------------------------------------------- identity and standing

export {createAgentBook, humanIdToBytes32, keccak256Utf8} from './world/agentBook.js';
export type {AgentBookOptions, HumanLookup} from './world/agentBook.js';

export {AssuranceTier, planAttestation, planAttestations} from './world/attestor.js';
export type {AttestationPlan, PlanOptions} from './world/attestor.js';

export {
  createStandingView,
  decodeBool,
  decodeUint,
  decodeWord,
  encodeAddress,
  encodeUint,
  encodeWord,
  standingCalldata,
  // Renamed at the boundary on purpose: `SELECTORS` alone does not say which
  // contract, and this package exports a second selector table right below it.
  SELECTORS as STANDING_SELECTORS,
} from './world/standing.js';
export type {
  ChainReader,
  StandingAddresses,
  StandingSnapshot,
  StandingView,
} from './world/standing.js';

// --------------------------------------------------------------- the toolbelt

export {createResourceCommons} from './world/resourceCommons.js';
export type {
  AccessDecision,
  AccessRecord,
  GrantContext,
  RefusalReason,
  ResourceCommons,
  ResourceCommonsOptions,
  SharedResource,
} from './world/resourceCommons.js';

export {
  createOnchainResourceView,
  createResourceProvider,
  explainRefusal,
  RESOURCE_SELECTORS,
  ResourceRefusal,
} from './world/onchainResources.js';
export type {
  CredentialIssuer,
  OnchainGrant,
  OnchainResourceView,
  OnchainResourcesOptions,
  ProviderOptions,
  ReleaseCheck,
  ResourceProvider,
  ResourceQuote,
} from './world/onchainResources.js';

export {createOnchainResourceCommons} from './world/onchainCommons.js';
export type {
  OnchainAccessOutcome,
  OnchainCommonsOptions,
  OnchainResourceCommons,
  OnchainResourceEntry,
  OnchainSurveyEntry,
} from './world/onchainCommons.js';

export {createStandingRateLimit} from './world/rateLimit.js';
export type {
  AgentKitStorage,
  RateLimitDecision,
  StandingLimiter,
  StandingRateLimitOptions,
} from './world/rateLimit.js';
