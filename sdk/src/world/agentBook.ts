/**
 * Who is behind an agent, according to AgentBook.
 *
 * AgentKit resolves an agent's wallet address to an anonymous human identifier,
 * with the property everything else here depends on: the same person always
 * resolves to the same identifier, however many agent wallets they register, and
 * the identifier reveals nothing about them. That lookup always happens against
 * World Chain, whichever chain the agent itself operates on.
 *
 * This module is the boundary. `@worldcoin/agentkit-core` is an optional peer
 * dependency, imported lazily, so an agent can be developed and tested against a
 * fake lookup with no RPC, no World Chain access and no credentials — and the
 * package still type-checks without it installed.
 */

/** The one question we ask AgentBook. */
export interface HumanLookup {
  /** The anonymous human identifier for `address`, or null if nobody is behind it. */
  lookupHuman(address: string): Promise<string | null>;
}

export interface AgentBookOptions {
  /** World Chain RPC. Defaults to the chain's public endpoint. */
  rpcUrl?: string;
  /** Override the AgentBook deployment. Defaults to the canonical one. */
  contractAddress?: `0x${string}`;
}

/** The slice of `@worldcoin/agentkit-core` this module uses. Declared locally so
 *  the package compiles without the dependency present. */
interface AgentkitCore {
  createAgentBookVerifier(options?: AgentBookOptions): HumanLookup;
}

/**
 * The real AgentBook lookup, over AgentKit.
 *
 * @throws if `@worldcoin/agentkit-core` is not installed. That is deliberate: the
 *         alternative is silently answering "nobody is behind this agent", which
 *         reads identically to a genuine negative and would quietly turn a
 *         misconfigured deployment into one that admits nothing.
 */
export async function createAgentBook(options: AgentBookOptions = {}): Promise<HumanLookup> {
  const specifier = '@worldcoin/agentkit-core';
  const core = (await import(specifier).catch(() => {
    throw new Error(
      'createAgentBook needs @worldcoin/agentkit-core installed. Install it, or pass a fake '
        + 'lookup when running an agent without World Chain access.'
    );
  })) as unknown as AgentkitCore;

  return core.createAgentBookVerifier(options);
}

// ------------------------------------------------------ on-chain representation

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * The identifier as our registry stores it: exactly 32 bytes.
 *
 * AgentBook hands back a string whose shape is its own business — it may already
 * be a 32-byte hex word, or it may be an opaque token. Our on-chain registry keys
 * on `bytes32`, so something has to bridge the two, and that something must be a
 * *function*: the same human has to map to the same word every time, on every
 * machine, forever, or their standing and any bar against them silently detaches
 * from them.
 *
 * A 32-byte hex identifier passes through unchanged, lowercased so two spellings
 * of one identifier cannot become two humans. Anything else is hashed. Hashing is
 * one-way, which is the right direction here: nothing about the person should be
 * recoverable from what we store, and we never need to go back.
 */
export function humanIdToBytes32(humanId: string): `0x${string}` {
  const trimmed = humanId.trim();
  if (trimmed === '') throw new Error('empty human identifier');
  if (HEX32.test(trimmed)) return trimmed.toLowerCase() as `0x${string}`;
  return keccak256Utf8(trimmed);
}

/**
 * keccak-256 of a UTF-8 string.
 *
 * Implemented here rather than pulled from a hashing library because this package
 * has no runtime dependencies by design, and an agent runtime should not need a
 * web3 stack to work out which human it is acting for. The digest has to match
 * Solidity's `keccak256` exactly, so this is the Keccak-f[1600] permutation with
 * the original 0x01 padding — not SHA3-256, which differs only in the pad byte and
 * would produce a different identifier for every human.
 */
export function keccak256Utf8(input: string): `0x${string}` {
  return `0x${keccak256(new TextEncoder().encode(input))}`;
}

/** The 24 round constants, full 64-bit. Truncating these to 32 bits still produces
 *  a plausible-looking digest that matches nothing — which is how the first draft
 *  of this file passed review by eye and failed every reference vector. */
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];
const MASK = (1n << 64n) - 1n;

const rotl = (x: bigint, n: number): bigint =>
  n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK;

function keccakF(state: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // Theta
    const c = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5) state[x + y] = state[x + y]! ^ d;
    }

    // Rho and pi
    const b = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y]!, ROT[x + 5 * y]!);
      }
    }

    // Chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        state[x + y] = b[x + y]! ^ (~b[((x + 1) % 5) + y]! & b[((x + 2) % 5) + y]!) & MASK;
      }
    }

    // Iota
    state[0] = state[0]! ^ RC[round]!;
  }
}

function keccak256(message: Uint8Array): string {
  const RATE = 136; // 1088 bits, the rate for keccak-256
  const state = new Array<bigint>(25).fill(0n);

  // Pad with 0x01 … 0x80 — Keccak's original padding, not SHA-3's 0x06.
  const padded = new Uint8Array(Math.ceil((message.length + 1) / RATE) * RATE);
  padded.set(message);
  padded[message.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;

  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let byte = 7; byte >= 0; byte--) {
        lane = (lane << 8n) | BigInt(padded[offset + i * 8 + byte]!);
      }
      state[i] = state[i]! ^ lane;
    }
    keccakF(state);
  }

  let out = '';
  for (let i = 0; i < 4; i++) {
    const lane = state[i]!;
    for (let byte = 0; byte < 8; byte++) {
      out += Number((lane >> BigInt(8 * byte)) & 0xffn)
        .toString(16)
        .padStart(2, '0');
    }
  }
  return out;
}
