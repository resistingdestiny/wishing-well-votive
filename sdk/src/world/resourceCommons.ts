/**
 * The commons that is not money.
 *
 * `CommonsPool` shares capital: an agent draws value and spends it. But most of
 * what an agent actually needs to finish a wish is not value — it is *access*. A
 * key for a paid corpus. A seat on a compute cluster. A search quota. A licensed
 * dataset. Those cannot go on-chain: the credential has to stay secret, and the
 * quota is enforced by whoever owns the resource, not by a contract.
 *
 * So this is the other half. The same identity and standing decide both, and they
 * have to, because otherwise an operator barred from spending money would simply
 * carry on using the expensive API instead.
 *
 * What lives on-chain: who the human is, whether they are barred, and what their
 * standing is worth. What lives here: which resources exist, what each one costs
 * in quota, and the secret an agent is handed once it has been granted access.
 * The secret is never written down anywhere a chain can see it.
 */
import type {StandingLimiter} from './rateLimit.js';
import type {StandingView} from './standing.js';

/** A shared thing that is not money. */
export interface SharedResource {
  /** Stable id an agent asks for. */
  id: string;
  /** What it is, in words an operator would recognise. */
  description: string;
  /**
   * Uses per window an operator at parity standing may have. Scaled by standing
   * at request time — this is a baseline, not a cap.
   */
  baseLimit: number;
  /**
   * Weakest assurance tier allowed near this resource at all, regardless of
   * standing. Some resources are expensive enough, or sensitive enough, that a
   * device signal should not reach them however good the track record.
   */
  minAssurance?: number;
  /**
   * Produces the thing the agent is actually given — an API key, a signed URL, a
   * session token. Called only after a grant, and its result is never logged.
   *
   * A function rather than a stored string so a deployment can mint short-lived
   * credentials per grant instead of handing out one long-lived secret that
   * cannot be withdrawn from a barred operator.
   */
  issue: (grant: GrantContext) => Promise<string>;
}

export interface GrantContext {
  resourceId: string;
  /** The anonymous identifier of the human being granted access. */
  humanId: string;
  /** The agent wallet that asked. */
  wallet: string;
  /** Uses already taken this window, before this one. */
  usedBefore: number;
}

export type RefusalReason =
  | 'no-such-resource'
  | 'not-human-backed'
  | 'barred'
  | 'below-minimum-assurance'
  | 'quota-exhausted';

export type AccessDecision =
  | {
      granted: true;
      resourceId: string;
      humanId: string;
      /** The credential. Hand it to the agent; do not log it. */
      credential: string;
      /** What the operator's standing earned them this window. */
      effectiveLimit: number;
      remaining: number;
    }
  | {
      granted: false;
      resourceId: string;
      reason: RefusalReason;
      /** A sentence an operator can act on, rather than a bare code. */
      explanation: string;
    };

export interface ResourceCommonsOptions {
  standing: StandingView;
  /** The usage counter — normally `createStandingRateLimit`, which is where the
   *  standing scaling and the bar check live. Typed as the richer interface
   *  because a grant has to report how much is actually left, and a boolean
   *  cannot say. */
  limiter: StandingLimiter;
  resources: SharedResource[];
  /** Called on every decision, granted or not. Receives no credential. */
  onDecision?: (record: AccessRecord) => void;
}

/** An audit line. Deliberately carries no credential and no wallet-to-person
 *  link beyond the anonymous identifier the protocol already uses. */
export interface AccessRecord {
  at: number;
  resourceId: string;
  humanId: string | null;
  wallet: string;
  granted: boolean;
  reason?: RefusalReason;
}

export interface ResourceCommons {
  /** Every resource an agent could ask for, without saying who may have them. */
  catalogue(): {id: string; description: string; baseLimit: number}[];
  /** Ask for access to one resource, as one agent wallet. */
  request(wallet: string, resourceId: string): Promise<AccessDecision>;
  /** What this wallet's operator could ask for right now, and why not otherwise.
   *  Lets an agent plan without burning quota discovering it has none. */
  survey(wallet: string): Promise<{resourceId: string; available: boolean; reason?: RefusalReason}[]>;
}

export function createResourceCommons(options: ResourceCommonsOptions): ResourceCommons {
  const byId = new Map(options.resources.map((r) => [r.id, r]));

  const explain = (reason: RefusalReason, resource?: SharedResource): string => {
    switch (reason) {
      case 'no-such-resource':
        return 'no such resource is shared here';
      case 'not-human-backed':
        return 'no verified human is registered behind this agent, so it cannot draw on '
          + 'the commons. Ask your operator to verify.';
      case 'barred':
        return 'the operator behind this agent is barred. This is not a quota you can wait '
          + 'out; stop and do not take on further work.';
      case 'below-minimum-assurance':
        return `this resource needs assurance tier ${resource?.minAssurance ?? 0} or better, `
          + 'and the humanity evidence behind this agent is weaker than that.';
      case 'quota-exhausted':
        return 'this window\'s share is used up. It refills next window, and delivering '
          + 'work raises the share.';
    }
  };

  async function decide(
    wallet: string,
    resource: SharedResource
  ): Promise<{humanId: string; usedBefore: number; effectiveLimit: number} | RefusalReason> {
    const snapshot = await options.standing.snapshot(wallet);

    // Unbacked and barred are different facts and deserve different sentences.
    if (!snapshot.humanId) return 'not-human-backed';
    if (snapshot.barred) return 'barred';
    if (resource.minAssurance !== undefined && snapshot.assurance < resource.minAssurance) {
      return 'below-minimum-assurance';
    }

    // The limiter carries the standing scaling and rechecks the bar itself, so a
    // human barred between the snapshot above and this line is still refused.
    const decision = await options.limiter.tryUse(
      resource.id,
      snapshot.humanId,
      resource.baseLimit
    );
    if (!decision.allowed) {
      return decision.reason === 'barred' ? 'barred' : 'quota-exhausted';
    }

    return {
      humanId: snapshot.humanId,
      usedBefore: decision.used,
      effectiveLimit: decision.effectiveLimit,
    };
  }

  return {
    catalogue() {
      return options.resources.map((r) => ({
        id: r.id,
        description: r.description,
        baseLimit: r.baseLimit,
      }));
    },

    async request(wallet, resourceId) {
      const resource = byId.get(resourceId);
      if (!resource) {
        options.onDecision?.({
          at: Math.floor(Date.now() / 1000),
          resourceId,
          humanId: null,
          wallet,
          granted: false,
          reason: 'no-such-resource',
        });
        return {
          granted: false,
          resourceId,
          reason: 'no-such-resource',
          explanation: explain('no-such-resource'),
        };
      }

      const outcome = await decide(wallet, resource);

      if (typeof outcome === 'string') {
        options.onDecision?.({
          at: Math.floor(Date.now() / 1000),
          resourceId,
          humanId: null,
          wallet,
          granted: false,
          reason: outcome,
        });
        return {
          granted: false,
          resourceId,
          reason: outcome,
          explanation: explain(outcome, resource),
        };
      }

      // The credential is minted last, only once everything has said yes, so a
      // refused request never causes one to exist.
      const credential = await resource.issue({
        resourceId,
        humanId: outcome.humanId,
        wallet,
        usedBefore: outcome.usedBefore,
      });

      options.onDecision?.({
        at: Math.floor(Date.now() / 1000),
        resourceId,
        humanId: outcome.humanId,
        wallet,
        granted: true,
      });

      return {
        granted: true,
        resourceId,
        humanId: outcome.humanId,
        credential,
        effectiveLimit: outcome.effectiveLimit,
        // `usedBefore` is the count before this grant, so this one is spent too.
        remaining: Math.max(0, outcome.effectiveLimit - outcome.usedBefore - 1),
      };
    },

    async survey(wallet) {
      const snapshot = await options.standing.snapshot(wallet);

      // Answered from the snapshot alone. Surveying must not consume quota, or an
      // agent planning its work would spend the very thing it is asking about.
      return options.resources.map((resource) => {
        if (!snapshot.humanId) {
          return {resourceId: resource.id, available: false, reason: 'not-human-backed' as const};
        }
        if (snapshot.barred) {
          return {resourceId: resource.id, available: false, reason: 'barred' as const};
        }
        if (resource.minAssurance !== undefined && snapshot.assurance < resource.minAssurance) {
          return {
            resourceId: resource.id,
            available: false,
            reason: 'below-minimum-assurance' as const,
          };
        }
        return {resourceId: resource.id, available: true};
      });
    },
  };
}
