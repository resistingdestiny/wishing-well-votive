import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const expected = process.env.WELL_CURATOR_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: "curation disabled (no token configured)" }, { status: 503 });
  }
  if (req.headers.get("x-curator-token") !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    cell?: string;
    featured?: boolean;
    curatorNote?: string | null;
  };
  if (!body.cell || !isAddress(body.cell)) {
    return NextResponse.json({ error: "valid cell required" }, { status: 400 });
  }
  const cell = getAddress(body.cell);
  const story = await prisma.story.findUnique({ where: { cell } }).catch(() => null);
  if (!story) {
    return NextResponse.json({ error: "no story for that cell" }, { status: 404 });
  }
  const updated = await prisma.story.update({
    where: { cell },
    data: {
      featured: body.featured ?? story.featured,
      curatorNote: body.curatorNote === undefined ? story.curatorNote : body.curatorNote,
    },
  });
  return NextResponse.json({ ok: true, cell, featured: updated.featured, curatorNote: updated.curatorNote });
}
