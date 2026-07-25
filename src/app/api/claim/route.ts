import { NextResponse } from "next/server";
import { formatEther, isAddress } from "viem";
import { getRails, railsConfig } from "@/lib/rails";
import { resolveClaimToken } from "@/lib/claims";
import { cellNumber } from "@/lib/chain";
import { formatUsdc } from "@/core/providers/types";
import type { PayoutElection } from "@/core/claims/claimService";

export const dynamic = "force-dynamic";

const USD_PER_ETH = 2000n;

function usdLabel(slice: bigint, assetIsNative: boolean): string {
  if (!assetIsNative) return formatUsdc(slice);

  return formatUsdc((slice * USD_PER_ETH * 1_000_000n) / 10n ** 18n);
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });
  const target = await resolveClaimToken(token);
  if (!target) return NextResponse.json({ error: "no live claim for this invitation" }, { status: 404 });

  const alreadyClaimed = target.view.claimClaimed >= target.view.claimTotal || target.slice === 0n;
  const number = await cellNumber(target.cell).catch(() => 0);
  return NextResponse.json({
    ok: true,
    token,
    cell: target.cell,
    wishNumber: number,
    fullName: target.fullName,
    relationship: target.relationship,
    assetSymbol: target.assetIsNative ? "ETH" : target.view.assetSymbol,
    assetIsNative: target.assetIsNative,
    sliceNativeLabel: target.assetIsNative
      ? `${formatEther(target.slice)} ETH`
      : formatUsdc(target.slice),
    sliceUsdLabel: usdLabel(target.slice, target.assetIsNative),
    claimDeadline: target.view.claimDeadline.toString(),
    alreadyClaimed,
  });
}

export async function POST(req: Request) {
  try {
    return await handlePost(req);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, code: "internal" }, { status: 500 });
  }
}

async function handlePost(req: Request) {
  const avail = railsConfig();
  if (!avail.ok) return NextResponse.json({ error: `claims not configured: ${avail.reason}` }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action;
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });

  const guardian = action === "guardian-approve";
  if (guardian) {
    const expected = process.env.WELL_CURATOR_TOKEN;
    if (!expected) return NextResponse.json({ error: "guardian review disabled" }, { status: 503 });
    if (req.headers.get("x-curator-token") !== expected) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else if (action !== "claim") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  const target = await resolveClaimToken(token);
  if (!target) return NextResponse.json({ error: "no live claim for this invitation" }, { status: 404 });

  const claimant = body.claimant as { fullName?: string; dateOfBirth?: string } | undefined;
  if (!claimant?.fullName || !claimant?.dateOfBirth) {
    return NextResponse.json({ error: "your full name and date of birth are required" }, { status: 400 });
  }
  const subject = typeof body.subject === "string" && body.subject.trim() ? body.subject.trim() : claimant.fullName;

  const payoutIn = body.payout as
    | { rail?: string; walletAddr?: string; bank?: Record<string, string> }
    | undefined;
  let payout: PayoutElection;
  if (payoutIn?.rail === "wallet") {
    if (!payoutIn.walletAddr || !isAddress(payoutIn.walletAddr)) {
      return NextResponse.json({ error: "a valid wallet address is required" }, { status: 400 });
    }
    payout = { rail: "wallet", walletAddr: payoutIn.walletAddr as `0x${string}` };
  } else if (payoutIn?.rail === "bank") {
    const b = payoutIn.bank ?? {};
    if (!b.holderName || !b.accountNumber || !b.country) {
      return NextResponse.json({ error: "bank holder name, account number and country are required" }, { status: 400 });
    }
    payout = {
      rail: "bank",
      bank: {
        holderName: b.holderName,
        accountNumber: b.accountNumber,
        routingNumber: b.routingNumber,
        bankName: b.bankName,
        country: b.country.toUpperCase(),
      },
    };
  } else {
    return NextResponse.json({ error: "elect a payout: wallet or bank" }, { status: 400 });
  }

  const rails = getRails();
  const result = await rails.claim.processIdentityClaim({
    cell: target.cell,
    beneficiaries: target.beneficiaries,
    index: target.index,
    claimant: { fullName: claimant.fullName, dateOfBirth: claimant.dateOfBirth },
    subject,
    payout,
    slice: target.slice,
    assetIsNative: target.assetIsNative,
    guardianOverride: guardian,
  });

  if (!result.ok) {

    const status = result.code === "sanctioned" ? 403 : result.code === "descriptor_mismatch" ? 422 : 400;
    return NextResponse.json({ error: result.message, code: result.code, needsHuman: result.needsHuman }, { status });
  }

  return NextResponse.json({
    ok: true,
    matched: result.matched,
    needsGuardian: result.needsGuardian,
    kycStatus: result.kycStatus,
    txRef: result.txRef,
    payoutRef: result.payoutRef,
    usdcOut: result.usdcOut?.toString(),
    usdcOutLabel: result.usdcOut !== undefined ? formatUsdc(result.usdcOut) : undefined,
    payoutRail: payout.rail,
  });
}
