/**
 * The identifier AgentBook returns, mapped to the 32-byte word our registry keys on.
 *
 * This must agree, byte for byte and forever, with `humanIdToBytes32` in
 * `sdk/src/world/agentBook.ts`. The same person has to map to the same word on
 * every machine and in every release, or their standing — and any bar against
 * them — silently detaches from them and they get a clean slate by accident.
 *
 * It is duplicated rather than imported because the application genuinely cannot
 * import the SDK: `@votive/agent-skills` is not a dependency of this package and
 * `pnpm-workspace.yaml` declares no `packages:`, so there is no path from `src/`
 * to `sdk/`. The SDK ships its own keccak-256 to stay dependency-free; here we
 * use viem's, which is already in the tree. `agentBook.test.ts` in the SDK and
 * the parity vector in `e2e/agent-auth.spec.ts` pin the two to the same answers.
 *
 * A 32-byte hex identifier passes through unchanged apart from being lowercased,
 * so two spellings of one identifier cannot become two humans. Anything else is
 * hashed — one-way on purpose, because nothing about the person should be
 * recoverable from what we store and we never need to go back.
 */
import { keccak256, toHex } from "viem";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export function humanIdToBytes32(humanId: string): `0x${string}` {
  const trimmed = humanId.trim();
  if (trimmed === "") throw new Error("empty human identifier");
  if (HEX32.test(trimmed)) return trimmed.toLowerCase() as `0x${string}`;
  return keccak256(toHex(trimmed));
}

export const ZERO_HUMAN_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export function isHumanBacked(humanId: string | null | undefined): boolean {
  return typeof humanId === "string" && HEX32.test(humanId) && humanId !== ZERO_HUMAN_ID;
}
