/**
 * Reading an operator's standing off the chain, and writing the calls that change
 * it.
 *
 * Everything here is expressed against a minimal `ChainReader` rather than a web3
 * client, for the same reason the payment rail is: an agent runtime should not need
 * a dependency the size of an EVM stack to ask whether it is allowed to spend. Any
 * `eth_call`-shaped function satisfies it, including the one an agent's existing
 * wallet library already has.
 */

/** Anything that can perform an `eth_call` and return hex. */
export type ChainReader = (request: {to: string; data: string}) => Promise<string>;

export interface StandingAddresses {
  /** `HumanBackingRegistry` */
  registry: string;
  /** `StandingLedger` */
  ledger: string;
  /** `CommonsPool` — optional, only needed for allowance questions. */
  commons?: string;
}

// ------------------------------------------------------------------- encoding

/**
 * Selectors, verified against `cast sig` rather than worked out by hand.
 *
 * A previous hand-encoded selector in this package was wrong by one nibble and
 * would have read the wrong storage slot silently — a call that returns zero
 * rather than reverting, which reads exactly like "no allowance". Every entry here
 * is pinned by a test for that reason.
 */
export const SELECTORS = {
  isBarred: '0x673c804f', // isBarred(bytes32)
  multiplierBpsOf: '0x7b195175', // multiplierBpsOf(bytes32)
  humanOf: '0xb64664c4', // humanOf(address)
  assuranceOf: '0x8d972249', // assuranceOf(address)
  ceilingOf: '0xc0e33e9c', // ceilingOf(address)
  remainingOf: '0xfa19fde7', // remainingOf(address)
  isPermitted: '0x3fd8cc4e', // isPermitted(address)
  draw: '0xb702a879', // draw(uint256,address)
  attest: '0x9bdcc9a4', // attest(address,bytes32,uint8,bytes32)
  reportConduct: '0xf09969db', // reportConduct(bytes32,uint8,uint8,bytes32)
  currentEpoch: '0x76671808', // currentEpoch()
} as const;

const pad = (hex: string): string => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

export const encodeAddress = (address: string): string => pad(address);
export const encodeWord = (word: string): string => pad(word);
export const encodeUint = (value: bigint): string => pad(value.toString(16));

export function decodeUint(hex: string): bigint {
  const body = hex.replace(/^0x/, '');
  return body === '' ? 0n : BigInt(`0x${body}`);
}

export function decodeBool(hex: string): boolean {
  return decodeUint(hex) !== 0n;
}

export function decodeWord(hex: string): `0x${string}` {
  const body = hex.replace(/^0x/, '').padStart(64, '0');
  return `0x${body.slice(-64)}` as `0x${string}`;
}

// --------------------------------------------------------------------- reading

/** What the protocol currently thinks of an operator. */
export interface StandingSnapshot {
  /** The anonymous human identifier, or null when the wallet is unbacked. */
  humanId: `0x${string}` | null;
  assurance: number;
  barred: boolean;
  /** Basis points against the base allowance. 10_000 is parity, 0 while barred. */
  multiplierBps: bigint;
  /** Present when a commons address was configured. */
  ceiling?: bigint;
  remaining?: bigint;
}

export interface StandingView {
  snapshot(wallet: string): Promise<StandingSnapshot>;
  isBarred(humanId: string): Promise<boolean>;
  multiplierBps(humanId: string): Promise<bigint>;
}

const ZERO_WORD = `0x${'0'.repeat(64)}`;

export function createStandingView(
  read: ChainReader,
  addresses: StandingAddresses
): StandingView {
  const call = async (to: string, data: string): Promise<string> => read({to, data});

  async function isBarred(humanId: string): Promise<boolean> {
    return decodeBool(
      await call(addresses.ledger, `${SELECTORS.isBarred}${encodeWord(humanId)}`)
    );
  }

  async function multiplierBps(humanId: string): Promise<bigint> {
    return decodeUint(
      await call(addresses.ledger, `${SELECTORS.multiplierBpsOf}${encodeWord(humanId)}`)
    );
  }

  return {
    isBarred,
    multiplierBps,

    async snapshot(wallet) {
      const humanWord = decodeWord(
        await call(addresses.registry, `${SELECTORS.humanOf}${encodeAddress(wallet)}`)
      );
      if (humanWord === ZERO_WORD) {
        // An unbacked wallet is not barred — it simply is not anybody. Reporting
        // it as barred would conflate "we have never met you" with "you did
        // something", and those deserve different messages to an operator.
        return {humanId: null, assurance: 0, barred: false, multiplierBps: 0n};
      }

      const assurance = Number(
        decodeUint(
          await call(addresses.registry, `${SELECTORS.assuranceOf}${encodeAddress(wallet)}`)
        )
      );
      const [barred, multiplier] = await Promise.all([
        isBarred(humanWord),
        multiplierBps(humanWord),
      ]);

      const snapshot: StandingSnapshot = {
        humanId: humanWord,
        assurance,
        barred,
        multiplierBps: multiplier,
      };

      if (addresses.commons) {
        const [ceiling, remaining] = await Promise.all([
          call(addresses.commons, `${SELECTORS.ceilingOf}${encodeAddress(wallet)}`),
          call(addresses.commons, `${SELECTORS.remainingOf}${encodeAddress(wallet)}`),
        ]);
        snapshot.ceiling = decodeUint(ceiling);
        snapshot.remaining = decodeUint(remaining);
      }

      return snapshot;
    },
  };
}

// --------------------------------------------------------------------- writing

/** Calldata for the calls that change standing, for a caller that holds the key. */
export const standingCalldata = {
  /** `attest(address,bytes32,uint8,bytes32)` — the attestor mirroring AgentBook. */
  attest(wallet: string, humanId: string, assurance: number, evidenceHash: string): string {
    return (
      SELECTORS.attest
      + encodeAddress(wallet)
      + encodeWord(humanId)
      + encodeUint(BigInt(assurance))
      + encodeWord(evidenceHash)
    );
  },

  /** `reportConduct(bytes32,uint8,uint8,bytes32)` — a reviewer filing a report. */
  reportConduct(
    humanId: string,
    category: number,
    severity: number,
    evidenceHash: string
  ): string {
    return (
      SELECTORS.reportConduct
      + encodeWord(humanId)
      + encodeUint(BigInt(category))
      + encodeUint(BigInt(severity))
      + encodeWord(evidenceHash)
    );
  },

  /** `draw(uint256,address)` — an agent spending from the commons. */
  draw(amount: bigint, payee: string): string {
    return SELECTORS.draw + encodeUint(amount) + encodeAddress(payee);
  },
} as const;
