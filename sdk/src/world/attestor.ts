/**
 * Mirroring AgentBook onto the chain the protocol runs on.
 *
 * This is the join between the two halves. AgentKit knows who is behind an agent,
 * on World Chain. The contracts that meter the commons and hold the bar live
 * wherever the protocol was deployed, and cannot reach across to ask. So an
 * attestor resolves the first and writes it to the second.
 *
 * The attestor is the one trusted party in the design, and its trust is bounded on
 * purpose: it can say *who* is behind a wallet, and nothing else. It cannot bar
 * anybody, cannot record an outcome, cannot move a coin, and cannot raise an
 * allowance except by telling the truth about a tier. Those are separate keys on
 * separate contracts, which is what keeps a compromised attestor a bad day rather
 * than a catastrophe.
 */
import {type HumanLookup, humanIdToBytes32} from './agentBook.js';
import {standingCalldata} from './standing.js';

/** How strongly the humanity claim is evidenced. Mirrors `AssuranceTiers`. */
export enum AssuranceTier {
  None = 0,
  Device = 1,
  Selfie = 2,
  Orb = 3,
}

export interface AttestationPlan {
  wallet: string;
  /** The identifier as AgentBook returned it. Never written on-chain directly. */
  humanId: string;
  /** The identifier as the registry stores it. */
  humanIdOnChain: `0x${string}`;
  assurance: AssuranceTier;
  evidenceHash: `0x${string}`;
  /** Ready to send to the `HumanBackingRegistry`. */
  calldata: string;
}

export interface PlanOptions {
  book: HumanLookup;
  /** The tier to record. AgentBook establishes that a unique human is behind the
   *  wallet; how strongly that was evidenced is a separate signal the caller
   *  supplies, and it must not be inferred from the lookup succeeding. */
  assurance: AssuranceTier;
  /** Hash committing to the off-chain verification record. */
  evidenceHash: `0x${string}`;
}

/**
 * Work out what to write for `wallet`, or null if nobody is behind it.
 *
 * Returns a plan rather than sending anything. Whoever holds the attestor key
 * decides when to broadcast, and can see exactly what would be written first —
 * this package never quietly signs on somebody's behalf.
 */
export async function planAttestation(
  wallet: string,
  options: PlanOptions
): Promise<AttestationPlan | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error(`not an address: ${wallet}`);
  if (options.assurance === AssuranceTier.None) {
    // Recording "no evidence" as an attestation would create a backed wallet with
    // a zero-weight allowance, which reads as verified everywhere it is displayed
    // and draws nothing. Refusing is clearer than a record that means neither.
    throw new Error('assurance None is not an attestation; revoke instead');
  }

  const humanId = await options.book.lookupHuman(wallet);
  if (humanId === null || humanId.trim() === '') return null;

  const humanIdOnChain = humanIdToBytes32(humanId);
  return {
    wallet,
    humanId,
    humanIdOnChain,
    assurance: options.assurance,
    evidenceHash: options.evidenceHash,
    calldata: standingCalldata.attest(
      wallet,
      humanIdOnChain,
      options.assurance,
      options.evidenceHash
    ),
  };
}

/**
 * Plan attestations for several wallets at once.
 *
 * Wallets AgentBook does not recognise are returned separately rather than
 * dropped, because "we looked and nobody is there" is the answer an operator most
 * needs to see — silently returning a shorter list than was asked about is how a
 * verification run appears to succeed while quietly doing nothing.
 */
export async function planAttestations(
  wallets: string[],
  options: PlanOptions
): Promise<{planned: AttestationPlan[]; unbacked: string[]}> {
  const planned: AttestationPlan[] = [];
  const unbacked: string[] = [];

  for (const wallet of wallets) {
    const plan = await planAttestation(wallet, options);
    if (plan) planned.push(plan);
    else unbacked.push(wallet);
  }

  return {planned, unbacked};
}
