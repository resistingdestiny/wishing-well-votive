/**
 * The two halves of an on-chain resource grant.
 *
 * `resourceCommons.ts` decides everything in one process, which is right for a
 * single provider running one server. This module is for the other shape: the
 * catalogue and the quota live in `ResourceRegistry`, and the credential is
 * released by whoever owns the resource, somewhere else entirely.
 *
 * Two sides, and they should not be confused:
 *
 *   - **The agent side** asks the registry for a grant and comes away with a grant
 *     id. That is not a credential and cannot be used as one.
 *   - **The provider side** sees the grant, checks it is *still* releasable, and
 *     only then mints the secret. Checking again matters: a grant records
 *     entitlement at the moment it was issued, and what governs handing over a key
 *     is entitlement now.
 */
import {
  type ChainReader,
  decodeUint,
  encodeAddress,
  encodeWord,
} from './standing.js';

/** Mirrors `ResourceRegistry.Refusal`. */
export enum ResourceRefusal {
  None = 0,
  NoSuchResource = 1,
  Retired = 2,
  NotHumanBacked = 3,
  Barred = 4,
  BelowMinimumAssurance = 5,
  QuotaExhausted = 6,
}

/**
 * Taken from `cast sig`, never worked out by hand.
 *
 * Worth restating because the first draft of this file guessed all five and got
 * all five wrong. A wrong selector here does not revert: `eth_call` to a contract
 * with no such function returns empty, which decodes to zero, which reads exactly
 * like "not allowed, no quota" — a refusal a caller would believe and an operator
 * could never debug.
 */
export const RESOURCE_SELECTORS = {
  quote: '0x75c854c3', // quote(address,bytes32)
  requestAccess: '0x841fb503', // requestAccess(bytes32)
  isGrantReleasable: '0x6c4966fb', // isGrantReleasable(bytes32)
  effectiveLimitOf: '0x193e5741', // effectiveLimitOf(address,bytes32)
  grantOf: '0x9aee26f1', // grantOf(bytes32)
} as const;

export interface ResourceQuote {
  allowed: boolean;
  reason: ResourceRefusal;
  effectiveLimit: number;
  remaining: number;
}

export function explainRefusal(reason: ResourceRefusal): string {
  switch (reason) {
    case ResourceRefusal.None:
      return 'allowed';
    case ResourceRefusal.NoSuchResource:
      return 'no such resource is registered';
    case ResourceRefusal.Retired:
      return 'this resource has been retired and is not issuing new access';
    case ResourceRefusal.NotHumanBacked:
      return 'no verified human is registered behind this agent, so it cannot draw on the '
        + 'commons. Ask your operator to verify.';
    case ResourceRefusal.Barred:
      return 'the operator behind this agent is barred. This is not a quota you can wait '
        + 'out; stop and do not take on further work.';
    case ResourceRefusal.BelowMinimumAssurance:
      return 'this resource needs stronger humanity evidence than is registered for this '
        + 'agent, and no amount of track record substitutes for it.';
    case ResourceRefusal.QuotaExhausted:
      return "this window's share is used up. It refills next window, and delivering work "
        + 'raises the share.';
  }
}

// --------------------------------------------------------------- agent side

export interface OnchainResourcesOptions {
  read: ChainReader;
  /** Address of the deployed `ResourceRegistry`. */
  registry: string;
}

export interface OnchainResourceView {
  /** Would a request succeed, and if not why? Costs nothing and takes no quota. */
  quote(wallet: string, resourceId: string): Promise<ResourceQuote>;
  /** Calldata for the request itself — this package never signs. */
  requestCalldata(resourceId: string): string;
}

export function createOnchainResourceView(
  options: OnchainResourcesOptions
): OnchainResourceView {
  return {
    async quote(wallet, resourceId) {
      const data =
        RESOURCE_SELECTORS.quote + encodeAddress(wallet) + encodeWord(resourceId);
      const raw = (await options.read({to: options.registry, data})).replace(/^0x/, '');

      // (bool, uint8 enum, uint32, uint32) — four words, statically encoded.
      const word = (i: number): string => raw.slice(i * 64, (i + 1) * 64);
      return {
        allowed: decodeUint(`0x${word(0)}`) !== 0n,
        reason: Number(decodeUint(`0x${word(1)}`)) as ResourceRefusal,
        effectiveLimit: Number(decodeUint(`0x${word(2)}`)),
        remaining: Number(decodeUint(`0x${word(3)}`)),
      };
    },

    requestCalldata(resourceId) {
      return RESOURCE_SELECTORS.requestAccess + encodeWord(resourceId);
    },
  };
}

// ------------------------------------------------------------ provider side

export interface ReleaseCheck {
  releasable: boolean;
  reason: ResourceRefusal;
  explanation: string;
}

export interface CredentialIssuer {
  /** Called only once the chain has said the grant is still releasable. */
  (grant: {grantId: string; resourceId: string; wallet: string}): Promise<string>;
}

export interface ProviderOptions {
  read: ChainReader;
  registry: string;
  issue: CredentialIssuer;
  /** Called on every release decision. Never receives the credential. */
  onRelease?: (record: {grantId: string; released: boolean; reason: ResourceRefusal}) => void;
}

export interface ResourceProvider {
  /** Ask the chain whether this grant may still be honoured. */
  check(grantId: string): Promise<ReleaseCheck>;
  /**
   * Check, and if the chain still says yes, mint and return the credential.
   *
   * Returns null rather than throwing on a refusal, because a provider handling a
   * queue of grants should be able to skip one without unwinding the batch.
   */
  release(
    grantId: string,
    context: {resourceId: string; wallet: string}
  ): Promise<string | null>;
}

export function createResourceProvider(options: ProviderOptions): ResourceProvider {
  async function check(grantId: string): Promise<ReleaseCheck> {
    const data = RESOURCE_SELECTORS.isGrantReleasable + encodeWord(grantId);
    const raw = (await options.read({to: options.registry, data})).replace(/^0x/, '');

    const releasable = decodeUint(`0x${raw.slice(0, 64)}`) !== 0n;
    const reason = Number(decodeUint(`0x${raw.slice(64, 128)}`)) as ResourceRefusal;
    return {releasable, reason, explanation: explainRefusal(reason)};
  }

  return {
    check,

    async release(grantId, context) {
      const verdict = await check(grantId);
      options.onRelease?.({grantId, released: verdict.releasable, reason: verdict.reason});
      if (!verdict.releasable) return null;

      // Minted last, and only here. A refused grant never causes a credential to
      // exist, so there is nothing to revoke afterwards.
      return options.issue({grantId, resourceId: context.resourceId, wallet: context.wallet});
    },
  };
}
