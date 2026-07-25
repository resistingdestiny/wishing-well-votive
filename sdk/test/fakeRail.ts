import type {Confirmation, HederaRail, Receipt} from '../dist/rail.js';
import {explorerUrl} from '../dist/rail.js';

/** A rail that records what it was asked to do and moves nothing. Everything an
 *  agent test needs, and no credentials. */
export function fakeRail(options: {confirmed?: boolean; auditTopicId?: string} = {}) {
  const transfers: {to: string; tinybars: bigint; memo: string}[] = [];
  const audits: string[] = [];
  let nonce = 0;

  const rail: HederaRail = {
    network: 'testnet',
    accountId: '0.0.1001',
    async transferHbar({to, tinybars, memo}): Promise<Receipt> {
      if (tinybars <= 0n) throw new Error('amount must be positive');
      transfers.push({to, tinybars, memo});
      const transactionId = `0.0.1001@170000000${nonce++}.000000000`;
      return {
        transactionId,
        status: 'SUCCESS',
        tinybars,
        to,
        memo,
        explorerUrl: explorerUrl('testnet', transactionId),
      };
    },
    async confirm(transactionId): Promise<Confirmation> {
      const confirmed = options.confirmed !== false;
      return {
        transactionId,
        consensusAt: confirmed ? '1700000000.000000000' : null,
        result: confirmed ? 'SUCCESS' : 'TIMEOUT',
        confirmed,
      };
    },
    ...(options.auditTopicId
      ? {
          async audit(message: string) {
            audits.push(message);
            return {topicId: options.auditTopicId!, sequenceNumber: audits.length};
          },
        }
      : {}),
  };

  return {rail, transfers, audits};
}
