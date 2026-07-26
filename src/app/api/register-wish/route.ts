import { NextResponse } from "next/server";
import { z } from "zod";
import { getAddress } from "viem";
import { prisma } from "@/lib/db";
import { agentDataDir } from "@/lib/ingest";
import { chainConfig, publicClient, factoryAbi, readCell } from "@/lib/chain";
import {
  storyHash as computeStoryHash,
  capabilityId as computeCapabilityId,
  conditionHash as computeConditionHash,
  StorySchemaZ,
} from "@/core/schema/story";
import { CapabilityStore } from "@/core/sweep/capabilityStore";
import { ConditionStore } from "@/core/conditions/store";
import { StoryStore } from "@/core/story/storyStore";

const BodySchema = z.object({
  cell: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  prose: z.string().min(10).max(10_000),
  wisher: z.string().regex(/^0x[0-9a-fA-F]{40}$/),

  fullStory: z.string().max(40_000).optional(),

  parsed: StorySchemaZ.optional(),
});

export async function POST(req: Request) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  const { prose, wisher, fullStory } = parsed.data;
  const cell = getAddress(parsed.data.cell);
  const { factory } = chainConfig();
  if (!factory) {
    return NextResponse.json({ error: "factory not configured" }, { status: 503 });
  }

  const isCell = (await publicClient().readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "isVotive",
    args: [cell],
  })) as boolean;
  if (!isCell) {
    return NextResponse.json({ error: "unknown cell" }, { status: 404 });
  }

  const view = await readCell(cell);
  if (view.storyHash !== computeStoryHash(prose)) {
    return NextResponse.json(
      { error: "prose does not match the cell's on-chain story hash" },
      { status: 422 },
    );
  }
  if (view.wisher.toLowerCase() !== wisher.toLowerCase()) {
    return NextResponse.json({ error: "wisher mismatch" }, { status: 422 });
  }

  const story = parsed.data.parsed;
  const dataDir = agentDataDir();
  let capabilitySummary = "";
  let conditionSummary = "";
  if (story) {
    if (computeCapabilityId(story.capability.eval) === view.capabilityId) {
      new CapabilityStore(dataDir).add(story.capability.summary, story.capability.eval);
      capabilitySummary = story.capability.summary;
    }
    if (computeConditionHash(story.condition.canonical) === view.conditionHash) {
      new ConditionStore(dataDir).add(story.condition.summary, story.condition.canonical);
      conditionSummary = story.condition.summary;
    }
  }

  const fullStoryText = fullStory?.trim() || prose;
  new StoryStore(dataDir).add(cell, fullStoryText);

  await prisma.story.upsert({
    where: { cell },
    // Backfilling is safe here where a blind overwrite would not be: everything
    // in this update was verified against the cell's own on-chain commitments
    // above (the prose against `storyHash`, the wisher against the cell), so a
    // re-register can only ever restore the one story this cell was opened
    // with — which is exactly what a registration that half-landed needs.
    update: {
      prose,
      fullStory: fullStory?.trim() || null,
      ...(story ? { parsed: story as object } : {}),
    },
    create: {
      cell,
      wisher: view.wisher,
      prose,
      fullStory: fullStory?.trim() || null,
      parsed: (story ?? {}) as object,
      capabilityId: view.capabilityId,
      conditionHash: view.conditionHash,
      storyHash: view.storyHash,
    },
  });

  return NextResponse.json({
    ok: true,
    cell,
    capabilityRegistered: capabilitySummary !== "",
    conditionRegistered: conditionSummary !== "",
  });
}
