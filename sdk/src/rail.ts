/**
 * The Hedera surface a skill needs, and nothing more.
 *
 * Declared as an interface rather than reached for directly so that an agent can
 * be tested without credentials, a network, or a wallet holding real value. The
 * real implementation loads `@hashgraph/sdk` lazily — an optional peer dependency
 * — so importing this package costs nothing until an agent actually goes to pay
 * somebody.
 */

/** A payment that happened, in a form worth keeping. */
export interface Receipt {
  /** Hedera transaction id, e.g. `0.0.1234@1700000000.000000000`. */
  transactionId: string;
  status: string;
  /** Tinybars actually moved. Hedera denominates HBAR at 8 decimals. */
  tinybars: bigint;
  to: string;
  memo: string;
  /** Where a human can go and look at it. */
  explorerUrl: string;
}

/** Confirmation read back from the mirror node, rather than taken on trust from
 *  the node that accepted the transaction. */
export interface Confirmation {
  transactionId: string;
  consensusAt: string | null;
  result: string;
  confirmed: boolean;
}

export interface HederaRail {
  readonly network: 'testnet' | 'mainnet' | 'previewnet';
  readonly accountId: string;
  transferHbar(args: {to: string; tinybars: bigint; memo: string}): Promise<Receipt>;
  /** Ask the mirror node whether a transaction really reached consensus. */
  confirm(transactionId: string): Promise<Confirmation>;
  /** Optional: append a payment record to a Hedera Consensus Service topic, so
   *  the trail is ordered and readable by anybody, not just by us. */
  audit?(message: string): Promise<{topicId: string; sequenceNumber?: number}>;
}

export const ACCOUNT_ID = /^\d+\.\d+\.\d+$/;

export const HBAR_DECIMALS = 8n;
const TINYBARS_PER_HBAR = 100_000_000n;

export function hbarToTinybars(hbar: number): bigint {
  if (!Number.isFinite(hbar) || hbar <= 0) throw new Error(`not a positive amount: ${hbar}`);
  // Via a fixed-point string so a fractional HBAR never rounds through a float.
  const [whole = '0', frac = ''] = hbar.toFixed(8).split('.');
  return BigInt(whole) * TINYBARS_PER_HBAR + BigInt(frac.padEnd(8, '0'));
}

export function tinybarsToHbar(tinybars: bigint): string {
  const whole = tinybars / TINYBARS_PER_HBAR;
  const frac = (tinybars % TINYBARS_PER_HBAR).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function explorerUrl(network: string, transactionId: string): string {
  return `https://hashscan.io/${network}/transaction/${encodeURIComponent(transactionId)}`;
}

function mirrorBase(network: string): string {
  return `https://${network}.mirrornode.hedera.com/api/v1`;
}

/** Mirror-node ids use `0.0.x-seconds-nanos`, not the `@` form the SDK returns. */
export function toMirrorId(transactionId: string): string {
  return transactionId.replace('@', '-').replace(/\.(?=\d+$)/, '-');
}

/**
 * The slice of `@hashgraph/sdk` this package actually uses.
 *
 * Declared here rather than imported as types so the package type-checks and
 * builds without the SDK present — it is an optional peer dependency, and an agent
 * running against a fake rail should not have to install it to compile. The
 * runtime import is by a computed specifier for the same reason.
 */
interface HashgraphSdk {
  Client: {
    forMainnet(): SdkClient;
    forTestnet(): SdkClient;
    forPreviewnet(): SdkClient;
  };
  PrivateKey: {
    fromStringECDSA(key: string): unknown;
    fromStringDer(key: string): unknown;
  };
  AccountId: {fromString(id: string): unknown};
  TopicId: {fromString(id: string): unknown};
  Hbar: {fromTinybars(amount: string): SdkHbar};
  TransferTransaction: new () => SdkTransfer;
  TopicMessageSubmitTransaction: new () => SdkTopicSubmit;
}

interface SdkClient {
  setOperator(accountId: unknown, key: unknown): void;
}
interface SdkHbar {
  negated(): SdkHbar;
}
interface SdkSubmitted {
  transactionId: {toString(): string};
  getReceipt(client: SdkClient): Promise<{
    status: {toString(): string};
    topicSequenceNumber?: {toString(): string} | number | null;
  }>;
}
interface SdkTransfer {
  addHbarTransfer(accountId: unknown, amount: SdkHbar): SdkTransfer;
  setTransactionMemo(memo: string): SdkTransfer;
  execute(client: SdkClient): Promise<SdkSubmitted>;
}
interface SdkTopicSubmit {
  setTopicId(topicId: unknown): SdkTopicSubmit;
  setMessage(message: string): SdkTopicSubmit;
  execute(client: SdkClient): Promise<SdkSubmitted>;
}

export interface RailConfig {
  accountId: string;
  /** ECDSA or ED25519 private key, hex or DER. Never logged by this package. */
  privateKey: string;
  network?: 'testnet' | 'mainnet' | 'previewnet';
  auditTopicId?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The real rail, over the official Hedera SDK.
 *
 * `@hashgraph/sdk` is imported dynamically for two reasons: it is a large
 * dependency that an agent running purely against a fake should not have to
 * install, and importing it eagerly would mean this module could not be loaded in
 * an environment without it. So the cost is paid on first payment, not on import.
 */
export async function createHederaRail(config: RailConfig): Promise<HederaRail> {
  const network = config.network ?? 'testnet';
  const fetchImpl = config.fetchImpl ?? fetch;

  const specifier = '@hashgraph/sdk';
  const sdk = (await import(specifier).catch(() => {
    throw new Error(
      'createHederaRail needs @hashgraph/sdk installed. Install it, or pass a fake rail '
        + 'when running an agent without credentials.'
    );
  })) as unknown as HashgraphSdk;

  const client =
    network === 'mainnet'
      ? sdk.Client.forMainnet()
      : network === 'previewnet'
        ? sdk.Client.forPreviewnet()
        : sdk.Client.forTestnet();

  // ECDSA keys are the common case for an account that also has an EVM address,
  // which is exactly the shape an agent working against our contracts will have.
  const key = config.privateKey.startsWith('0x')
    ? sdk.PrivateKey.fromStringECDSA(config.privateKey)
    : sdk.PrivateKey.fromStringDer(config.privateKey);
  client.setOperator(sdk.AccountId.fromString(config.accountId), key);

  async function confirm(transactionId: string): Promise<Confirmation> {
    const url = `${mirrorBase(network)}/transactions/${toMirrorId(transactionId)}`;
    const response = await fetchImpl(url);
    if (!response.ok) {
      return {transactionId, consensusAt: null, result: `mirror ${response.status}`, confirmed: false};
    }
    const body = (await response.json()) as {consensus_timestamp?: string; result?: string};
    return {
      transactionId,
      consensusAt: body.consensus_timestamp ?? null,
      result: body.result ?? 'UNKNOWN',
      confirmed: body.result === 'SUCCESS',
    };
  }

  return {
    network,
    accountId: config.accountId,

    async transferHbar({to, tinybars, memo}) {
      if (!ACCOUNT_ID.test(to)) throw new Error(`not a Hedera account id: ${to}`);
      if (tinybars <= 0n) throw new Error('amount must be positive');

      const amount = sdk.Hbar.fromTinybars(tinybars.toString());
      const tx = new sdk.TransferTransaction()
        .addHbarTransfer(sdk.AccountId.fromString(config.accountId), amount.negated())
        .addHbarTransfer(sdk.AccountId.fromString(to), amount)
        .setTransactionMemo(memo.slice(0, 100));

      const submitted = await tx.execute(client);
      const receipt = await submitted.getReceipt(client);
      const transactionId = submitted.transactionId.toString();

      return {
        transactionId,
        status: receipt.status.toString(),
        tinybars,
        to,
        memo,
        explorerUrl: explorerUrl(network, transactionId),
      };
    },

    confirm,

    ...(config.auditTopicId
      ? {
          async audit(message: string) {
            const submitted = await new sdk.TopicMessageSubmitTransaction()
              .setTopicId(sdk.TopicId.fromString(config.auditTopicId!))
              .setMessage(message)
              .execute(client);
            const receipt = await submitted.getReceipt(client);
            return {
              topicId: config.auditTopicId!,
              ...(receipt.topicSequenceNumber
                ? {sequenceNumber: Number(receipt.topicSequenceNumber)}
                : {}),
            };
          },
        }
      : {}),
  };
}
