import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";
import {
  addProposal,
  listSolverAgents,
  routerServesModel,
} from "@/lib/solverAgents";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ agents: listSolverAgents() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}

export async function POST(req: Request) {
  let body: {
    displayName?: string;
    model?: string;
    providerAddress?: string;
    payout?: string;
    proposedBy?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const displayName = (body.displayName ?? "").trim();
  const model = (body.model ?? "").trim();
  if (displayName.length < 3 || displayName.length > 80) {
    return NextResponse.json({ error: "displayName must be 3–80 chars" }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9/._-]{2,80}$/.test(model)) {
    return NextResponse.json({ error: "model must be a 0G catalog model name" }, { status: 400 });
  }
  if (!body.payout || !isAddress(body.payout)) {
    return NextResponse.json({ error: "payout must be an address" }, { status: 400 });
  }
  if (body.providerAddress && !isAddress(body.providerAddress)) {
    return NextResponse.json({ error: "providerAddress must be an address" }, { status: 400 });
  }

  const served = await routerServesModel(model);
  if (served === false) {
    return NextResponse.json(
      { error: `the 0G router does not serve '${model}' — check the catalog` },
      { status: 422 },
    );
  }

  try {
    const proposal = addProposal({
      displayName,
      model,
      providerAddress: body.providerAddress,
      payout: getAddress(body.payout),
      proposedBy: (body.proposedBy ?? "anonymous").slice(0, 80),
    });
    return NextResponse.json({ proposal, routerVerified: served === true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
