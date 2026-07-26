/**
 * The join between the on-chain registry and the agent's resource toolbelt.
 *
 * `createOnchainResourceView` speaks the registry's language: `quote` and a lump
 * of calldata, because this package never signs. `VotiveAgentConfig.resources`
 * wants something else entirely — `catalogue`, `request`, `survey`, and a request
 * that comes back holding an actual credential. Nothing bridged the two, which is
 * why `votive_request_resource` has never once reached `ResourceRegistry` in this
 * repo. This is that bridge.
 *
 * Three seams the caller has to fill, and each one is a seam because it is
 * genuinely somebody else's job:
 *
 *   - **`submit`** broadcasts `requestAccess` and reports the grant id. This
 *     package holds no key and will not grow one.
 *   - **`collect`** asks the provider for the credential. The registry stores a
 *     `termsHash` and a quota and deliberately never stores the secret, so the
 *     only place a credential can come from is the provider, off chain.
 *   - **`catalogue`** supplies the descriptions. `resourceOf` returns a provider,
 *     a limit, a tier and a hash — not a name. Inventing a name from the id would
 *     be inventing a fact.
 *
 * The order is load-bearing: quote, then submit, then collect. The credential is
 * fetched last, so a request the registry refused never causes one to exist.
 */
import {
  type OnchainResourceView,
  type ResourceQuote,
  ResourceRefusal,
  createOnchainResourceView,
  explainRefusal,
} from './onchainResources.js';
import type {AccessDecision, RefusalReason, ResourceCommons} from './resourceCommons.js';
import type {ChainReader, StandingView} from './standing.js';

/** What a resource is, in words. The registry stores none of this. */
export interface OnchainResourceEntry {
  /** The `bytes32` id the registry keys on. */
  id: string;
  /** What it is, in words an operator would recognise. */
  description: string;
  /** The registry's `baseLimit`, restated for display. Read `resourceOf` if you
   *  need the authoritative number — this one is a label, not a rule. */
  baseLimit: number;
}

export interface OnchainCommonsOptions {
  read: ChainReader;
  /** Address of the deployed `ResourceRegistry`. */
  registry: string;
  /** Descriptions for the ids this agent may ask about. */
  catalogue: OnchainResourceEntry[];
  /** Reads who is behind a wallet, so a grant can report the human it was
   *  metered against. The registry meters per human, not per wallet, and a
   *  decision that could not name the human would be reporting a quota without
   *  saying whose it was. */
  standing: StandingView;
  /**
   * Broadcasts `requestAccess(resourceId)` and returns the grant id the registry
   * assigned. Yours to implement: this package never signs.
   *
   * The grant id is emitted in `AccessGranted(grantId, resourceId, humanId,
   * wallet, expiresAt)` and returned by the call itself.
   */
  submit: (request: {
    resourceId: string;
    /** The registry address. */
    to: string;
    /** `requestAccess(bytes32)`, already encoded. */
    data: string;
  }) => Promise<{grantId: string}>;
  /**
   * Collects the credential for a grant the chain has already issued.
   *
   * Normally an HTTPS call to the provider, which will re-check
   * `isGrantReleasable` before it hands anything over — see
   * `createResourceProvider` for the other end of this conversation.
   */
  collect: (grant: {grantId: string; resourceId: string; wallet: string}) => Promise<string>;
  /** Called on every decision. Never receives the credential. */
  onDecision?: (record: {
    at: number;
    resourceId: string;
    wallet: string;
    granted: boolean;
    refusal: ResourceRefusal;
    grantId?: string;
  }) => void;
}

/** A survey answer carrying the registry's own refusal rather than a coarsening
 *  of it. */
export interface OnchainSurveyEntry {
  resourceId: string;
  available: boolean;
  refusal: ResourceRefusal;
  explanation: string;
  effectiveLimit: number;
  remaining: number;
}

export type OnchainAccessOutcome =
  | {
      granted: true;
      resourceId: string;
      humanId: string;
      grantId: string;
      /** The credential. Hand it to the agent; do not log it. */
      credential: string;
      effectiveLimit: number;
      remaining: number;
    }
  | {
      granted: false;
      resourceId: string;
      refusal: ResourceRefusal;
      explanation: string;
      /**
       * Set when the grant was issued and the credential could not be collected.
       *
       * That distinction matters and is easy to lose: the quota is spent either
       * way, so a caller that treated this as an ordinary refusal and retried
       * would pay twice for one grant. Retry the collection with this id.
       */
      grantId?: string;
    };

export interface OnchainResourceCommons extends ResourceCommons {
  /** The registry's answer, unrounded. Free, and consumes no quota. */
  quote(wallet: string, resourceId: string): Promise<ResourceQuote>;
  /** Like `survey`, but keeps the registry's seven refusals instead of the five
   *  the in-process commons defines. */
  surveyOnchain(wallet: string): Promise<OnchainSurveyEntry[]>;
  /** Like `request`, but reports the grant id and the precise refusal. */
  requestOnchain(wallet: string, resourceId: string): Promise<OnchainAccessOutcome>;
}

/**
 * The registry distinguishes seven refusals; `RefusalReason` in the in-process
 * commons has five, and is not this slice's file to widen.
 *
 * `Retired` is the one with no exact partner. It is bucketed with
 * `no-such-resource` because that is what a retired resource is to an agent
 * asking now — the registry refuses new grants for it. Nothing renders the coarse
 * code: `explanation` carries `explainRefusal`'s own sentence, which says
 * "retired" in as many words, and `surveyOnchain` returns the enum itself.
 */
function coarsen(refusal: ResourceRefusal): RefusalReason {
  switch (refusal) {
    case ResourceRefusal.NotHumanBacked:
      return 'not-human-backed';
    case ResourceRefusal.Barred:
      return 'barred';
    case ResourceRefusal.BelowMinimumAssurance:
      return 'below-minimum-assurance';
    case ResourceRefusal.QuotaExhausted:
      return 'quota-exhausted';
    case ResourceRefusal.NoSuchResource:
    case ResourceRefusal.Retired:
    case ResourceRefusal.None:
      return 'no-such-resource';
  }
}

export function createOnchainResourceCommons(
  options: OnchainCommonsOptions
): OnchainResourceCommons {
  const view: OnchainResourceView = createOnchainResourceView({
    read: options.read,
    registry: options.registry,
  });
  const known = new Set(options.catalogue.map((entry) => entry.id.toLowerCase()));
  const note = (record: Parameters<NonNullable<OnchainCommonsOptions['onDecision']>>[0]): void =>
    options.onDecision?.(record);

  async function requestOnchain(
    wallet: string,
    resourceId: string
  ): Promise<OnchainAccessOutcome> {
    if (!known.has(resourceId.toLowerCase())) {
      // Refused here rather than on chain. The registry would answer
      // `NoSuchResource` for an id it has never seen, but it would also answer it
      // for one it knows and this agent was never told about — and a caller
      // guessing ids is a caller that should be stopped before it spends gas.
      const explanation = 'no such resource is in this agent’s catalogue';
      note({at: now(), resourceId, wallet, granted: false, refusal: ResourceRefusal.NoSuchResource});
      return {granted: false, resourceId, refusal: ResourceRefusal.NoSuchResource, explanation};
    }

    const quote = await view.quote(wallet, resourceId);
    if (!quote.allowed) {
      note({at: now(), resourceId, wallet, granted: false, refusal: quote.reason});
      return {
        granted: false,
        resourceId,
        refusal: quote.reason,
        explanation: explainRefusal(quote.reason),
      };
    }

    // Allowed implies backed — the registry refuses `NotHumanBacked` before it
    // gets as far as quota — so this lookup is for the *name* of the human, not
    // for permission. Refusing on a null here would be refusing on our own
    // inability to read, which is a different thing and says so.
    const snapshot = await options.standing.snapshot(wallet);
    if (!snapshot.humanId) {
      note({at: now(), resourceId, wallet, granted: false, refusal: ResourceRefusal.NotHumanBacked});
      return {
        granted: false,
        resourceId,
        refusal: ResourceRefusal.NotHumanBacked,
        explanation:
          'the registry says this wallet is entitled but the backing registry did not '
          + 'return a human for it. Nothing was requested; this is a disagreement between '
          + 'two reads, not a refusal.',
      };
    }

    const {grantId} = await options.submit({
      resourceId,
      to: options.registry,
      data: view.requestCalldata(resourceId),
    });

    let credential: string;
    try {
      credential = await options.collect({grantId, resourceId, wallet});
    } catch (error) {
      // The quota is spent: `requestAccess` incremented it and there is no
      // function that gives it back. Saying so, with the id, is the difference
      // between a caller retrying the collection and a caller buying a second
      // grant it already owns.
      note({at: now(), resourceId, wallet, granted: false, refusal: ResourceRefusal.None, grantId});
      return {
        granted: false,
        resourceId,
        refusal: ResourceRefusal.None,
        grantId,
        explanation:
          `the grant was issued (${grantId}) but the provider did not release a credential: `
          + `${error instanceof Error ? error.message : String(error)}. The quota for this `
          + 'window is already spent — retry the collection with this grant id rather '
          + 'than requesting again.',
      };
    }

    note({at: now(), resourceId, wallet, granted: true, refusal: ResourceRefusal.None, grantId});
    return {
      granted: true,
      resourceId,
      humanId: snapshot.humanId,
      grantId,
      credential,
      effectiveLimit: quote.effectiveLimit,
      // `quote.remaining` was read before the request, so this grant is spent too.
      remaining: Math.max(0, quote.remaining - 1),
    };
  }

  async function surveyOnchain(wallet: string): Promise<OnchainSurveyEntry[]> {
    // `quote` is a view call, so surveying costs nothing and takes no quota — an
    // agent planning its work must not spend the very thing it is asking about.
    return Promise.all(
      options.catalogue.map(async (entry) => {
        const quote = await view.quote(wallet, entry.id);
        return {
          resourceId: entry.id,
          available: quote.allowed,
          refusal: quote.reason,
          explanation: explainRefusal(quote.reason),
          effectiveLimit: quote.effectiveLimit,
          remaining: quote.remaining,
        };
      })
    );
  }

  return {
    quote: (wallet, resourceId) => view.quote(wallet, resourceId),
    requestOnchain,
    surveyOnchain,

    catalogue() {
      return options.catalogue.map((entry) => ({
        id: entry.id,
        description: entry.description,
        baseLimit: entry.baseLimit,
      }));
    },

    async request(wallet, resourceId): Promise<AccessDecision> {
      const outcome = await requestOnchain(wallet, resourceId);
      if (outcome.granted) {
        return {
          granted: true,
          resourceId: outcome.resourceId,
          humanId: outcome.humanId,
          credential: outcome.credential,
          effectiveLimit: outcome.effectiveLimit,
          remaining: outcome.remaining,
        };
      }
      return {
        granted: false,
        resourceId: outcome.resourceId,
        reason: coarsen(outcome.refusal),
        explanation: outcome.explanation,
      };
    },

    async survey(wallet) {
      const entries = await surveyOnchain(wallet);
      return entries.map((entry) =>
        entry.available
          ? {resourceId: entry.resourceId, available: true}
          : {resourceId: entry.resourceId, available: false, reason: coarsen(entry.refusal)}
      );
    },
  };
}

const now = (): number => Math.floor(Date.now() / 1000);
