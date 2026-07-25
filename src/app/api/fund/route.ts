import { NextResponse } from "next/server";
import { keccak256, toHex } from "viem";
import { enforceRateLimit } from "@/lib/rateLimit";
import { getRails, railsConfig } from "@/lib/rails";
import { prisma } from "@/lib/db";
import { agentDataDir } from "@/lib/ingest";
import { parseUsdc, formatUsdc } from "@/core/providers/types";
import { storyHash, capabilityId, conditionHash } from "@/core/schema/story";
import { CapabilityStore } from "@/core/sweep/capabilityStore";
import { ConditionStore } from "@/core/conditions/store";

export const dynamic = "force-dynamic";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

const FUND_EVAL = {
  type: "qa" as const,
  question: "What is 6 * 7?",
  expected: "42",
  matcher: "exact" as const,
};
const FUND_CANONICAL = "manual:the wisher confirms before this fiat-funded wish returns";
const FUND_CAP_SUMMARY = "Exact arithmetic (fiat-funded wish)";
const FUND_COND_SUMMARY = "The wisher confirms before the fiat-funded wish returns";

function badRequest(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}

export async function POST(req: Request) {

  const limited = enforceRateLimit(req, "fund", 6, 60_000);
  if (limited) return limited;
  try {
    return await handle(req);
  } catch (e) {

    return NextResponse.json({ error: (e as Error).message, code: "internal" }, { status: 500 });
  }
}

async function handle(req: Request) {
  const avail = railsConfig();
  if (!avail.ok) return NextResponse.json({ error: `funding not configured: ${avail.reason}` }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action;

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const prose = typeof body.prose === "string" ? body.prose.trim() : "";
  const amountUsd = typeof body.amountUsd === "string" || typeof body.amountUsd === "number" ? String(body.amountUsd) : "";
  const method = body.method;

  if (action === "start") {
    if (!email || !email.includes("@")) return badRequest("a valid email is required");
    if (prose.length < 10) return badRequest("tell us your wish (at least 10 characters)");
    if (method !== "bank" && method !== "card") return badRequest("method must be 'bank' or 'card'");
    let amountUsdc: bigint;
    try {
      amountUsdc = parseUsdc(amountUsd);
    } catch {
      return badRequest("enter a dollar amount");
    }
    if (amountUsdc <= 0n) return badRequest("amount must be positive");

    const rails = getRails();
    const wallet = await rails.providers.wallet.getOrCreateWallet({ owner: email, via: "email" });
    if (!wallet.ok) return NextResponse.json({ error: wallet.message, code: wallet.code }, { status: 502 });

    if (method === "bank") {
      const acct = await rails.providers.bankRail.issueVirtualAccount({ owner: email, destination: rails.cfg.custody });
      if (!acct.ok) return NextResponse.json({ error: acct.message, code: acct.code }, { status: 502 });
      return NextResponse.json({
        ok: true,
        method: "bank",
        wallet: wallet.wallet.address,
        amountUsdc: amountUsdc.toString(),
        amountLabel: formatUsdc(amountUsdc),
        account: {
          id: acct.account.id,
          bankName: acct.account.bankName,
          accountNumber: acct.account.accountNumber,
          routingNumber: acct.account.routingNumber,
          reference: acct.account.reference,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      method: "card",
      wallet: wallet.wallet.address,
      amountUsdc: amountUsdc.toString(),
      amountLabel: formatUsdc(amountUsdc),
    });
  }

  if (action === "settle") {
    if (!email || !prose) return badRequest("missing funding context");
    const walletAddr = typeof body.wallet === "string" ? (body.wallet as `0x${string}`) : undefined;
    if (!walletAddr) return badRequest("missing embedded wallet");
    const rails = getRails();

    let amountUsdc: bigint;
    let fundRef: string;
    if (method === "bank") {
      const vaId = typeof body.account === "object" && body.account
        ? (body.account as { id?: string }).id
        : (body.virtualAccountId as string | undefined);
      if (!vaId) return badRequest("missing virtual account id");
      let amt: bigint;
      try {
        amt = parseUsdc(amountUsd);
      } catch {
        return badRequest("enter a dollar amount");
      }
      const externalRef = keccak256(toHex(`fund:${vaId}:${amt}`));
      const recv = await rails.providers.bankRail.receiveTransfer({ virtualAccountId: vaId, amountUsdc: amt, externalRef });
      if (!recv.ok) return NextResponse.json({ error: recv.message, code: recv.code }, { status: 502 });
      const settled = await rails.providers.bankRail.settleTransfer(recv.transfer.id);
      if (!settled.ok) return NextResponse.json({ error: settled.message, code: settled.code }, { status: 502 });
      amountUsdc = settled.transfer.amountUsdc;
      fundRef = recv.transfer.id;
    } else if (method === "card") {
      let amt: bigint;
      try {
        amt = parseUsdc(amountUsd);
      } catch {
        return badRequest("enter a dollar amount");
      }
      const card = typeof body.card === "string" ? { number: body.card } : undefined;
      const session = await rails.providers.onramp.startCheckout({ owner: email, amountUsdc: amt, destination: rails.cfg.custody });
      if (!session.ok) return NextResponse.json({ error: session.message, code: session.code }, { status: 502 });
      const done = await rails.providers.onramp.completeCheckout(session.session.id, card ? { card } : undefined);
      if (!done.ok) {

        return NextResponse.json({ error: done.message, code: done.code, declined: true }, { status: 402 });
      }
      amountUsdc = done.session.amountUsdc;
      fundRef = session.session.id;
    } else {
      return badRequest("method must be 'bank' or 'card'");
    }

    const existing = await prisma.story.findFirst({
      where: { parsed: { path: ["fundRef"], equals: fundRef } },
    });
    if (existing?.cell) {
      return NextResponse.json({ ok: true, cell: existing.cell, amountUsdc: amountUsdc.toString(), replay: true });
    }

    new CapabilityStore(agentDataDir()).add(FUND_CAP_SUMMARY, FUND_EVAL);
    new ConditionStore(agentDataDir()).add(FUND_COND_SUMMARY, FUND_CANONICAL);
    const capId = capabilityId(FUND_EVAL);
    const condHash = conditionHash(FUND_CANONICAL);
    const cell = await rails.createFundedUsdcWish({
      schema: {
        kind: 0,
        guardian: ZERO,
        beneficiary: walletAddr,
        capabilityId: capId,
        conditionHash: condHash,
        storyHash: storyHash(prose),
        actionBudget: 0n,
        isSealed: false,
        fallbackBeneficiary: ZERO,
        beneficiariesRoot: ("0x" + "0".repeat(64)) as `0x${string}`,
      },
      amountUsdc,
    });

    await prisma.story.create({
      data: {
        cell,
        wisher: rails.cfg.executor.address,
        prose,
        parsed: {
          kind: "return-on-condition",
          denom: "USDC",
          fundedVia: method,
          fundRef,
          amountUsdc: amountUsdc.toString(),
          ownerWallet: walletAddr,
          amendPolicy: { amendableAfterDays: 365, escheatAfterDays: 1825 },
        },
        capabilityId: capId,
        conditionHash: condHash,
        storyHash: storyHash(prose),
      },
    });

    return NextResponse.json({
      ok: true,
      cell,
      amountUsdc: amountUsdc.toString(),
      amountLabel: formatUsdc(amountUsdc),
      ownerWallet: walletAddr,
    });
  }

  return badRequest("unknown action");
}
