/**
 * Two skills for an agent that needs to spend money to finish a job.
 *
 * Both take their instruction from a *signed* string rather than from anything a
 * model produced in the moment. That is the whole safety story: an agent may
 * decide *whether* to act, but it can never decide who gets paid or how much,
 * because those came from the wish its founder signed. A model that hallucinates
 * an account id produces a parse failure, not a transfer.
 */
import {ACCOUNT_ID, type HederaRail, type Receipt, hbarToTinybars, tinybarsToHbar} from '../rail.js';

export interface SkillOutcome {
  skill: string;
  ok: boolean;
  summary: string;
  receipt?: Receipt;
  confirmedAt?: string | null;
  audit?: {topicId: string; sequenceNumber?: number};
  error?: string;
}

/** `pay:<accountId>:<hbar>:<memo…>` — memo may itself contain colons. */
export interface PayInstruction {
  to: string;
  tinybars: bigint;
  memo: string;
}

export function parsePayInstruction(instruction: string): PayInstruction {
  const parts = instruction.split(':');
  if (parts[0] !== 'pay') throw new Error('not a pay instruction');
  const [, to, amount, ...rest] = parts;
  if (!to || !ACCOUNT_ID.test(to)) throw new Error(`not a Hedera account id: ${to ?? ''}`);
  if (!amount) throw new Error('missing amount');
  return {to, tinybars: hbarToTinybars(Number(amount)), memo: rest.join(':') || 'votive'};
}

/**
 * Pay somebody, then read the payment back off the mirror node before calling it
 * done. The node that accepted the transaction is not the same thing as consensus,
 * and an agent that reports success on submission will eventually report a success
 * that did not happen.
 */
export async function payHbar(rail: HederaRail, instruction: string): Promise<SkillOutcome> {
  try {
    const {to, tinybars, memo} = parsePayInstruction(instruction);
    const receipt = await rail.transferHbar({to, tinybars, memo});
    const confirmation = await rail.confirm(receipt.transactionId);

    const audit = await rail
      .audit?.(JSON.stringify({kind: 'pay', to, tinybars: tinybars.toString(), tx: receipt.transactionId}))
      .catch(() => undefined);

    return {
      skill: 'hedera-pay',
      ok: confirmation.confirmed,
      summary: confirmation.confirmed
        ? `paid ${tinybarsToHbar(tinybars)} ℏ to ${to} — ${receipt.explorerUrl}`
        : `submitted but not confirmed: ${confirmation.result}`,
      receipt,
      confirmedAt: confirmation.consensusAt,
      ...(audit ? {audit} : {}),
    };
  } catch (error) {
    return {
      skill: 'hedera-pay',
      ok: false,
      summary: 'payment refused before anything moved',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** `buy:<url>:<maxHbar>:<memo…>` */
export interface BuyInstruction {
  url: string;
  capTinybars: bigint;
  memo: string;
}

export function parseBuyInstruction(instruction: string): BuyInstruction {
  if (!instruction.startsWith('buy:')) throw new Error('not a buy instruction');
  const rest = instruction.slice('buy:'.length);
  // The URL contains colons, so split on the *last* two fields instead of the first.
  const match = /^(.*?):([0-9.]+)(?::(.*))?$/.exec(rest);
  if (!match) throw new Error('expected buy:<url>:<maxHbar>[:memo]');
  const [, url, cap, memo] = match;
  if (!url || !/^https?:\/\//.test(url)) throw new Error(`not a url: ${url ?? ''}`);
  return {url, capTinybars: hbarToTinybars(Number(cap)), memo: memo || 'votive'};
}

/** What a service asks for when it answers 402. */
export interface PaymentRequirements {
  payTo: string;
  tinybars: bigint;
}

export function parseRequirements(body: unknown): PaymentRequirements {
  const b = body as {payTo?: unknown; amountHbar?: unknown; amountTinybars?: unknown};
  const payTo = typeof b.payTo === 'string' ? b.payTo : '';
  if (!ACCOUNT_ID.test(payTo)) throw new Error('402 response did not name a Hedera account');
  const tinybars =
    b.amountTinybars !== undefined
      ? BigInt(String(b.amountTinybars))
      : hbarToTinybars(Number(b.amountHbar));
  return {payTo, tinybars};
}

export type FetchLike = (
  url: string,
  init?: {method?: string; headers?: Record<string, string>}
) => Promise<{status: number; json(): Promise<unknown>; text(): Promise<string>}>;

/**
 * Buy one use of a service that prices itself over HTTP 402.
 *
 * Call it, get told what it costs, pay on Hedera, call again with the payment as
 * proof. No account, no API key, no subscription — which is what makes it usable
 * by an agent that did not exist when the service was written.
 *
 * The signed cap is enforced *before* paying. A service that answers 402 asking
 * for more than the founder authorised gets nothing; the agent does not get to
 * decide that the job was worth more than it was told.
 */
export async function x402Buy(
  rail: HederaRail,
  instruction: string,
  fetchImpl: FetchLike
): Promise<SkillOutcome & {body?: string}> {
  try {
    const {url, capTinybars, memo} = parseBuyInstruction(instruction);

    const quoted = await fetchImpl(url);
    if (quoted.status !== 402) {
      // Nothing to pay for: either it is free or it is broken, and either way
      // paying would be wrong.
      return {
        skill: 'hedera-x402',
        ok: quoted.status < 400,
        summary: `no payment required (HTTP ${quoted.status})`,
        body: await quoted.text(),
      };
    }

    const {payTo, tinybars} = parseRequirements(await quoted.json());
    if (tinybars > capTinybars) {
      return {
        skill: 'hedera-x402',
        ok: false,
        summary:
          `service wants ${tinybarsToHbar(tinybars)} ℏ but the signed cap is `
          + `${tinybarsToHbar(capTinybars)} ℏ — not paying`,
        error: 'over the authorised cap',
      };
    }

    const receipt = await rail.transferHbar({to: payTo, tinybars, memo});
    const confirmation = await rail.confirm(receipt.transactionId);

    const delivered = await fetchImpl(url, {
      headers: {'x-payment': receipt.transactionId, 'x-payment-network': `hedera-${rail.network}`},
    });

    const audit = await rail
      .audit?.(JSON.stringify({kind: 'x402', url, tinybars: tinybars.toString(), tx: receipt.transactionId}))
      .catch(() => undefined);

    return {
      skill: 'hedera-x402',
      ok: delivered.status < 400,
      summary:
        `paid ${tinybarsToHbar(tinybars)} ℏ to ${payTo} for one use of ${url} `
        + `(HTTP ${delivered.status}) — ${receipt.explorerUrl}`,
      receipt,
      confirmedAt: confirmation.consensusAt,
      body: await delivered.text(),
      ...(audit ? {audit} : {}),
    };
  } catch (error) {
    return {
      skill: 'hedera-x402',
      ok: false,
      summary: 'purchase refused before anything moved',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
