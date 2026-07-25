import { NextResponse } from "next/server";
import { z } from "zod";
import { enforceRateLimit } from "@/lib/rateLimit";
import { parseStory } from "@/core/schema/parser";
import {
  toOnchainSchema,
  StorySchemaZ,
  parseResolverCondition,
  RESOLVER_IDS,
  type ParsedStory,
} from "@/core/schema/story";
import { resolveClient } from "@/core/llm/client";
import { ModelRegistry } from "@/core/models/registry";
import path from "node:path";

const BodySchema = z.object({

  prose: z.string().min(10).max(2_000),
  wisher: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

function mockParse(prose: string, wisher: string): ParsedStory {
  const wantsDistribute = /distribut|share|everyone|all wishers/i.test(prose);
  const wantsAction = /\baction\b|\bdo\b|write|build|send/i.test(prose);
  const kind = wantsDistribute
    ? "distribute-to-active"
    : wantsAction
      ? "offchain-action"
      : "return-on-condition";
  return StorySchemaZ.parse({
    kind,
    wisher,
    capability: {
      summary: `Mock capability for: ${prose.slice(0, 60)}`,
      eval: {
        type: "qa",
        question: "What is 2+2?",
        expected: "4",
        matcher: "exact",
      },
    },
    condition: {
      summary: "Trivially true (mock parse)",
      canonical: "always-true",
    },
    amendPolicy: { amendAfterDays: 365, escheatAfterDays: 1825 },
    actionBudgetWei: "0",
  });
}

export async function POST(req: Request) {

  const limited = enforceRateLimit(req, "parse-story", 5, 60_000);
  if (limited) return limited;
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  const { prose, wisher } = parsed.data;

  try {
    let story: ParsedStory;
    let provider: string;
    if (process.env.WELL_MOCK_LLM === "1") {
      story = mockParse(prose, wisher);
      provider = "mock-template";
    } else {
      const resolved = await resolveClient();
      if (!resolved) {
        return NextResponse.json(
          { error: "no LLM provider available on this server" },
          { status: 503 },
        );
      }
      const modelsFile =
        process.env.WELL_MODELS_FILE ??
        path.resolve(process.cwd(), "..", "agent", "models.json");
      const model = new ModelRegistry(modelsFile).active()[0];
      if (!model) {
        return NextResponse.json({ error: "no active model" }, { status: 503 });
      }
      const result = await parseStory(
        prose,
        wisher as `0x${string}`,
        resolved.client,
        model.id,
      );
      story = result.story;
      provider = `${resolved.provider}:${model.id}`;
    }

    const onchain = toOnchainSchema(story, prose);

    const rc = parseResolverCondition(story.condition.canonical);
    const kind = !rc
      ? null
      : rc.resolverId === RESOLVER_IDS.blockNumber
        ? "block height"
        : rc.resolverId === RESOLVER_IDS.priceFeed
          ? "price feed"
          : rc.resolverId === RESOLVER_IDS.erc20Received
            ? "ERC-20 received"
            : "resolver";
    return NextResponse.json({
      story,
      provider,
      onchain: { ...onchain, actionBudget: onchain.actionBudget.toString() },
      resolver: rc ? { resolverId: rc.resolverId, params: rc.params, kind } : null,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 });
  }
}
