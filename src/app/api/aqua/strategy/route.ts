import { NextResponse } from "next/server";
import { z } from "zod";
import { encodeAbiParameters, getAddress, keccak256, parseAbi, type Hex } from "viem";
import { prisma } from "@/lib/db";
import { publicClient } from "@/lib/chain";

/**
 * Where a shipped position's program bytes live between being shipped and being
 * filled.
 *
 * Aqua keys a strategy on the *hash* of its order, so the chain never stores the
 * program itself. That is fine for the founder, who built it — and fatal for
 * everybody else, who cannot reconstruct an order they never saw and therefore
 * cannot take the other side of it. A position nobody can rebuild is a position
 * nobody can fill, which is the same as no position at all.
 *
 * So the bytes are kept here. **This endpoint is a convenience and never an
 * authority.** Both sides check against the chain:
 *
 *   - writing, we re-hash the submitted order and refuse it unless it equals the
 *     votive's own `strategyHash()`. A caller cannot park an order here that the
 *     votive never shipped.
 *   - reading, the client hashes again before it signs anything, so even a row
 *     written by some other route has to match the chain to be used.
 *
 * The database is a cache of something the chain already committed to. If it is
 * wrong, filling fails closed rather than putting a bad order in front of
 * somebody.
 */

const votiveAbi = parseAbi([
  "function strategyHash() view returns (bytes32)",
  "function quoteToken() view returns (address)",
  "function token() view returns (address)",
]);

const HEX = /^0x[0-9a-fA-F]*$/;

const BodySchema = z.object({
  votive: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  program: z.string().regex(HEX).max(20_000),
  aqua: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  router: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  tokenA: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  tokenB: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  shippedTx: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
});

/** The order as Aqua hashes it: `abi.encode(Order)` of maker, traits, program. */
function encodeOrder(maker: `0x${string}`, program: Hex): Hex {
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
    [{ maker, traits: 1n << 254n, data: program }],
  );
}

export async function POST(req: Request) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  const votive = getAddress(parsed.data.votive);
  const program = parsed.data.program as Hex;

  // The check that makes this safe to write to. Anyone may call this endpoint,
  // so the only thing standing between it and a poisoned row is the chain's own
  // answer about what this votive actually shipped.
  let onChain: Hex;
  try {
    onChain = (await publicClient().readContract({
      address: votive,
      abi: votiveAbi,
      functionName: "strategyHash",
    })) as Hex;
  } catch {
    return NextResponse.json(
      { error: "could not read the votive's strategy hash" },
      { status: 502 },
    );
  }

  const computed = keccak256(encodeOrder(votive, program));
  if (computed.toLowerCase() !== onChain.toLowerCase()) {
    return NextResponse.json(
      {
        error:
          "this program does not hash to the strategy this votive shipped",
        expected: onChain,
        got: computed,
      },
      { status: 409 },
    );
  }

  const row = {
    strategyHash: onChain,
    aqua: getAddress(parsed.data.aqua),
    router: getAddress(parsed.data.router),
    maker: votive,
    tokenA: getAddress(parsed.data.tokenA),
    tokenB: getAddress(parsed.data.tokenB),
    program,
    ...(parsed.data.shippedTx ? { shippedTx: parsed.data.shippedTx } : {}),
  };

  try {
    await prisma.aquaStrategy.upsert({
      where: { votive },
      create: { votive, ...row },
      update: row,
    });
  } catch (e) {
    // Loudly. A swallowed write here means the position looks shipped and is
    // quietly unfillable by anybody but the founder, which is the exact failure
    // this endpoint exists to prevent.
    if (process.env.NODE_ENV !== "production") console.error("aqua/strategy", e);
    return NextResponse.json({ error: "could not record the strategy" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, strategyHash: onChain });
}

export async function GET(req: Request) {
  const votiveParam = new URL(req.url).searchParams.get("votive");
  if (!votiveParam || !/^0x[0-9a-fA-F]{40}$/.test(votiveParam)) {
    return NextResponse.json({ error: "votive required" }, { status: 400 });
  }
  const votive = getAddress(votiveParam);

  const row = await prisma.aquaStrategy
    .findUnique({ where: { votive } })
    .catch(() => null);
  if (!row?.program) {
    return NextResponse.json({ error: "no recorded program for this wish" }, { status: 404 });
  }

  return NextResponse.json({
    votive,
    program: row.program,
    strategyHash: row.strategyHash,
    router: row.router,
    aqua: row.aqua,
    tokenA: row.tokenA,
    tokenB: row.tokenB,
    shippedTx: row.shippedTx,
  });
}
