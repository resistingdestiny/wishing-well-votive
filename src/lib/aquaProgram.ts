/**
 * Encoding a SwapVM program and an Aqua order, in the browser.
 *
 * The contracts build these with `ProgramBuilder` and `MakerTraitsLib`, which
 * resolve opcodes by scanning a table of function pointers. A client cannot scan
 * function pointers, so the indices have to be constants here — and a wrong
 * opcode does not fail loudly, it silently runs a different instruction. So they
 * come from `aqua/script/PrintOpcodes.s.sol`, which prints them from the same
 * table the router builds, and a test pins them.
 *
 * The order encoding is the general `MakerTraitsLib.build` collapsed to the one
 * case a votive uses: no hooks, no receiver, Aqua balances instead of a
 * signature. Every hook slice is empty, so all four length indexes are zero, the
 * whole traits word is a single flag, and `data` is just the program. Everything
 * this file leaves out is a feature a votive position does not use — and the
 * simulation guard below is what catches it if that ever stops being true.
 */
import { encodeAbiParameters, encodePacked, type Address, type Hex } from "viem";

/** Positions in the official opcode table. See the note above. */
export const OFFICIAL_OPCODES = {
  /** The constant-product curve that settles the amounts. */
  xycSwapXD: 17,
  /** A salt, so two otherwise identical strategies hash differently. */
  salt: 20,
} as const;

/** Where the votive instructions begin — the official table's length. */
export const VOTIVE_OPCODE_BASE = 33;

/** Offsets from `VOTIVE_OPCODE_BASE`, in the order the router registers them. */
export const VOTIVE_OPCODES = {
  onlyCapabilityOpen: 0,
  onlyConditionMet: 1,
  onlyVotiveLive: 2,
  performanceFee: 3,
  onlyHumanBackedFiller: 4,
  onlyFillerInGoodStanding: 5,
  fillerStandingBonus: 6,
} as const;

const strip = (hex: string): string => hex.replace(/^0x/, "");

/** One instruction: `[opcode][argsLength][args]`, which is all a program is. */
export function instruction(opcode: number, args: Hex | ""): Hex {
  const body = args === "" ? "" : strip(args);
  const length = body.length / 2;
  if (length > 255) throw new Error(`instruction args too long: ${length} bytes`);
  return `0x${opcode.toString(16).padStart(2, "0")}${length.toString(16).padStart(2, "0")}${body}`;
}

const concat = (parts: Hex[]): Hex => `0x${parts.map(strip).join("")}`;

export interface VotiveProgramOptions {
  votive: Address;
  attestations: Address;
  capabilityId: Hex;
  conditionHash: Hex;
  /** The fee threshold. Always the votive's own principal — see the note in
   *  `ShipVotivePosition`: a caller-supplied threshold could show a fee charged
   *  on money that was never a gain. */
  principal: bigint;
  /** Protocol fee on the surplus, on SwapVM's 1e9 == 100% scale. */
  performanceBps: number;
  treasury: Address;
  /** Optional filler rules. Omitting them leaves the position open to anyone. */
  humanRegistry?: Address;
  standingLedger?: Address;
  minAssurance?: number;
  minStandingBps?: number;
  bonusBps?: number;
  /** Makes two otherwise identical strategies distinct. */
  salt: bigint;
}

/**
 * The program a votive ships.
 *
 * Order is not cosmetic. The gates run before the curve so a refused fill costs
 * nothing to compute, and the fee instruction brackets the curve because it needs
 * the settled amounts to know what the surplus was.
 */
export function buildVotiveProgram(options: VotiveProgramOptions): Hex {
  const b = VOTIVE_OPCODE_BASE;
  const parts: Hex[] = [
    // Is this wish still live?
    instruction(b + VOTIVE_OPCODES.onlyVotiveLive, encodePacked(["address"], [options.votive])),
    // Has the frontier reached the job it waits on?
    instruction(
      b + VOTIVE_OPCODES.onlyCapabilityOpen,
      encodePacked(["address", "bytes32"], [options.attestations, options.capabilityId]),
    ),
    // And has this particular wish come true?
    instruction(
      b + VOTIVE_OPCODES.onlyConditionMet,
      encodePacked(
        ["address", "address", "bytes32"],
        [options.attestations, options.votive, options.conditionHash],
      ),
    ),
  ];

  if (options.humanRegistry) {
    parts.push(
      instruction(
        b + VOTIVE_OPCODES.onlyHumanBackedFiller,
        encodePacked(["address", "uint8"], [options.humanRegistry, options.minAssurance ?? 0]),
      ),
    );
  }
  if (options.humanRegistry && options.standingLedger) {
    parts.push(
      instruction(
        b + VOTIVE_OPCODES.onlyFillerInGoodStanding,
        encodePacked(
          ["address", "address", "uint32"],
          [options.humanRegistry, options.standingLedger, options.minStandingBps ?? 0],
        ),
      ),
    );
    if (options.bonusBps) {
      parts.push(
        instruction(
          b + VOTIVE_OPCODES.fillerStandingBonus,
          encodePacked(
            ["address", "address", "uint32"],
            [options.humanRegistry, options.standingLedger, options.bonusBps],
          ),
        ),
      );
    }
  }

  parts.push(
    // The fee brackets the curve: it runs the rest of the program, then takes a
    // share of whatever came back above the principal.
    instruction(
      b + VOTIVE_OPCODES.performanceFee,
      encodePacked(
        ["bytes32", "uint32", "address"],
        [
          `0x${options.principal.toString(16).padStart(64, "0")}` as Hex,
          options.performanceBps,
          options.treasury,
        ],
      ),
    ),
    instruction(OFFICIAL_OPCODES.xycSwapXD, ""),
    instruction(
      OFFICIAL_OPCODES.salt,
      `0x${options.salt.toString(16).padStart(64, "0")}` as Hex,
    ),
  );

  return concat(parts);
}

/**
 * `MakerTraitsLib.build`, for the one shape a votive uses.
 *
 * With no hooks and no receiver every length index is zero, so the traits word is
 * a single flag and `data` is the program unadorned. Writing the general case
 * would be more code and more surface for a silent mistake, and a votive that
 * needed a hook would be a different contract.
 */
const USE_AQUA_INSTEAD_OF_SIGNATURE = 1n << 254n;

export interface AquaOrder {
  maker: Address;
  traits: bigint;
  data: Hex;
}

export function buildVotiveOrder(maker: Address, program: Hex): AquaOrder {
  return { maker, traits: USE_AQUA_INSTEAD_OF_SIGNATURE, data: program };
}

/** The order as `abi.encode(Order)`, which is what `shipToAqua` takes. */
export function encodeStrategy(order: AquaOrder): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "maker", type: "address" },
          { name: "traits", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    [order],
  );
}
