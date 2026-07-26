/**
 * The open work, as a list an agent can act on without a browser.
 *
 * This endpoint exists because of a specific failure. Submitting a solution needs
 * a rail address, a bounty id and the wish the bounty is escrowed against, and
 * until now the only way to learn those three was to read them off a page and
 * type them into a form. An agent cannot do that, so "an agent submits its own
 * work" was not actually possible however good the rest of the plumbing was.
 *
 * **Everything here is read from the chain, not from a database.** A bounty is
 * on-chain state; a cached copy could say a bounty is open after it closed, and an
 * agent would spend real work on it. `bountyCount` and `bountyOf` are asked every
 * time.
 *
 * **A read that fails says so.** Per rail, either the bounties or a `degraded`
 * string — never an empty list, which an agent would read as "there is no work"
 * and stand down. That distinction is the same one `ReadFailure` makes on screen.
 *
 * No authentication. Which bounties are open is public on chain already, and
 * requiring a key to read it would only mean an agent has to authenticate to
 * discover whether it is worth authenticating.
 */
import { NextResponse } from "next/server";
import { bountyCount, bountyOf } from "@/lib/chainReads";
import type { TxChain } from "@/lib/txLog";

export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
} as const;

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * How many bounties back we look.
 *
 * Each one is a separate `eth_call`, so an unbounded walk over a rail with a
 * thousand bounties is a request that times out and tells an agent nothing. The
 * newest are the ones with work left in them, and the cap is reported in the
 * response so a truncated list never reads as a complete one.
 */
const WINDOW = 60;

interface RailSpec {
  label: string;
  address: `0x${string}`;
  chain: TxChain;
}

/**
 * One row, or an honest gap where a row should be.
 *
 * A union rather than an optional-everything object, and stated explicitly so
 * `flatMap` does not infer the element type from whichever branch it meets first.
 * A bounty that could not be read is reported as itself — dropping it would shrink
 * the list silently, and filling it with zeroes would describe a bounty with no
 * money in it, which is a different and wrong claim.
 */
type BountyRow =
  | { bountyId: number; degraded: string }
  | {
      bountyId: number;
      wish: `0x${string}`;
      funder: `0x${string}`;
      remainingWei: string;
      totalWei: string;
      paidWei: string;
      closed: boolean;
      claimedBy: `0x${string}` | null;
      claimExpiresAt: number;
      capabilityId: `0x${string}`;
      taskHash: `0x${string}`;
      openToSolutions: boolean;
    };

function rails(): RailSpec[] {
  const out: RailSpec[] = [];
  const base = process.env.NEXT_PUBLIC_WELL_BOUNTY_RAIL;
  const hedera = process.env.NEXT_PUBLIC_HEDERA_BOUNTY_RAIL;
  if (base && /^0x[0-9a-fA-F]{40}$/.test(base)) {
    out.push({ label: "AgentBountyRail (Base Sepolia)", address: base as `0x${string}`, chain: "base-sepolia" });
  }
  if (hedera && /^0x[0-9a-fA-F]{40}$/.test(hedera)) {
    out.push({ label: "AgentBountyRail (Hedera testnet)", address: hedera as `0x${string}`, chain: "hedera-testnet" });
  }
  return out;
}

const ZERO = "0x0000000000000000000000000000000000000000";

export async function GET(req: Request) {
  const wanted = new URL(req.url).searchParams.get("wish")?.toLowerCase();
  const specs = rails();

  if (specs.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        rails: [],
        because:
          "no bounty rail is configured on this deployment (NEXT_PUBLIC_WELL_BOUNTY_RAIL / NEXT_PUBLIC_HEDERA_BOUNTY_RAIL)",
      },
      { status: 503, headers: CORS },
    );
  }

  const out = await Promise.all(
    specs.map(async (spec) => {
      const count = await bountyCount(spec.address, spec.chain);
      if (!count.ok) {
        return { rail: spec.address, label: spec.label, chain: spec.chain, degraded: count.degraded };
      }

      // Ids are 1-based: `postBounty` assigns `id = ++bountyCount`, and `bountyOf`
      // reverts `NoSuchBounty` for 0. Walking from 0 both burned a call on an id
      // that always reverts and stopped one short of the newest bounty — which is
      // the one most likely to still have work in it.
      const total = count.value;
      const from = Math.max(1, total - WINDOW + 1);
      const ids = Array.from({ length: Math.max(0, total - from + 1) }, (_, i) => from + i);

      const read = await Promise.all(ids.map((id) => bountyOf(spec.address, id, spec.chain)));

      const bounties = ids.flatMap<BountyRow>((id, i) => {
        const r = read[i]!;
        if (!r.ok) {
          // One unreadable bounty must not delete the readable ones, and must not
          // be silently dropped either.
          return [{ bountyId: id, degraded: r.degraded }];
        }
        const b = r.value;
        const remaining = b.total - b.paid;
        if (wanted && b.votive.toLowerCase() !== wanted) return [];
        return [
          {
            bountyId: id,
            wish: b.votive,
            funder: b.funder,
            /** The wei still escrowed. A solution can only ever release from this. */
            remainingWei: remaining.toString(),
            totalWei: b.total.toString(),
            paidWei: b.paid.toString(),
            closed: b.closed,
            /** Whether some agent already holds the exclusive claim. */
            claimedBy: b.agent === ZERO ? null : b.agent,
            claimExpiresAt: b.claimExpiresAt,
            capabilityId: b.capabilityId,
            taskHash: b.taskHash,
            /**
             * Whether a solution posted against this bounty could be settled at
             * all. `POST /api/submissions` refuses a closed or fully-paid bounty,
             * so this is the same judgement, made before the agent writes a claim.
             */
            openToSolutions: !b.closed && remaining > 0n,
          },
        ];
      });

      return { rail: spec.address, label: spec.label, chain: spec.chain, bountyCount: total, window: WINDOW, bounties };
    }),
  );

  return NextResponse.json(
    {
      ok: true,
      /** Everything below is read live from the chain at request time. */
      readAt: new Date().toISOString(),
      note:
        `The newest ${WINDOW} bounties per rail. Post a solution with POST /api/submissions ` +
        `(kind: "solution") naming the rail, the bountyId and the wish from a row here.`,
      rails: out,
    },
    { headers: CORS },
  );
}
