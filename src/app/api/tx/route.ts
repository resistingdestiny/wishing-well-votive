import { NextResponse } from "next/server";
import { z } from "zod";
import { recordTx } from "@/lib/txLog";

export const dynamic = "force-dynamic";

/**
 * Note a transaction the browser just sent.
 *
 * Called after a wallet write has already landed, so this is a record and not a
 * gate: nothing the user did depends on it, and a failure here must never surface
 * as a failure of the thing they actually did.
 *
 * The description is chosen from a fixed set rather than taken from the request.
 * A caller supplying its own prose would be writing directly into a page whose
 * whole purpose is to be trustworthy — the client says which of our operations it
 * performed, and the wording stays ours.
 */
const KNOWN = {
  "wish-opened": {
    track: "votive" as const,
    what: "A wish was opened and funded",
  },
  "wish-topped-up": { track: "votive" as const, what: "A wish was topped up" },
  "wish-redirected": { track: "votive" as const, what: "A wish was redirected" },
  "wish-heartbeat": { track: "votive" as const, what: "The founder signalled they are still here" },
  "wish-escheated": { track: "votive" as const, what: "A dormant wish escheated to its fallback" },
  "share-claimed": { track: "votive" as const, what: "A waiting wish claimed its share" },
  "deferred-claimed": { track: "votive" as const, what: "A deferred payout was collected" },
  "human-attested": {
    track: "world" as const,
    what: "An agent wallet was bound to a verified human",
  },
  "faucet-drawn": {
    track: "votive" as const,
    what: "Somebody drew VOTIVE from the faucet",
  },
  "commons-drawn": {
    track: "world" as const,
    what: "An agent drew shared capital to pay for the job",
  },
  "resource-granted": {
    track: "world" as const,
    what: "A shared resource was granted (credential released off-chain)",
  },
  "resource-access-requested": {
    track: "world" as const,
    what: "An agent claimed its entitlement to a shared resource",
  },
  "aqua-position-opened": {
    track: "aqua" as const,
    what: "A wish offered part of its own principal as a position",
  },
  "aqua-position-closed": {
    track: "aqua" as const,
    what: "A wish closed its position and withdrew the allowance",
  },
  "aqua-position-filled": {
    track: "aqua" as const,
    what: "Somebody took the other side of a wish, and its principal moved",
  },
  "capability-attested": { track: "votive" as const, what: "Capability gate opened" },
  "condition-attested": { track: "votive" as const, what: "Release condition attested" },
  "attempt-begun": { track: "votive" as const, what: "Attempt begun" },
  "wish-fulfilled": { track: "votive" as const, what: "Wish fulfilled — paid out" },
  "conduct-reported": {
    track: "world" as const,
    what: "A conduct report was filed against an operator",
  },
  "bounty-posted": { track: "hedera" as const, what: "A funder escrowed a reward for an agent" },
  "milestone-released": {
    track: "hedera" as const,
    what: "An attested milestone paid the agent",
  },
  "earnings-withdrawn": { track: "hedera" as const, what: "An agent collected its earnings" },
} as const;

const Body = z.object({
  kind: z.enum(Object.keys(KNOWN) as [keyof typeof KNOWN, ...(keyof typeof KNOWN)[]]),
  chain: z.enum(["base-sepolia", "hedera-testnet", "local-fork"]),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  /** Short factual detail — an address, an amount. Length-capped and stripped of
   *  anything that could carry markup into the page. */
  detail: z.string().max(160).optional(),
  contract: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  subject: z.string().max(80).optional(),
});

const clean = (s: string): string => s.replace(/[<>]/g, "").trim();

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }

  const { kind, chain, txHash, detail, contract, subject } = parsed.data;
  const known = KNOWN[kind];

  await recordTx({
    track: known.track,
    chain,
    txHash,
    what: known.what,
    detail: clean(detail ?? ""),
    ...(contract ? { contract } : {}),
    ...(subject ? { subject: clean(subject) } : {}),
  });

  return NextResponse.json({ ok: true });
}
