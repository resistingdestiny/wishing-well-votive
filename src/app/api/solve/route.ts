import { NextResponse } from "next/server";
import { z } from "zod";
import { getAddress } from "viem";
import path from "node:path";
import { enforceRateLimit } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { StorySchemaZ, type EvalSpec } from "@/core/schema/story";
import { mockParse } from "@/core/schema/mockParse";
import { compileEval } from "@/core/evals/harness";
import {
  resolveClient,
  MockLlmClient,
  type LlmClient,
  type MockRule,
} from "@/core/llm/client";
import { StrategyStore } from "@/core/agents/strategyStore";
import { ModelRegistry } from "@/core/models/registry";
import { agentDataDir } from "@/lib/ingest";

export const dynamic = "force-dynamic";

/**
 * Run a registered agent against a wish's capability eval — the read-only compute
 * half of "Solve this wish". This endpoint never touches the chain: it only asks
 * whether the picked agent can demonstrably do what the wish is waiting for. If it
 * passes, the browser (holding the operator key) does the on-chain settlement
 * itself; the server has no signing authority here by design.
 */

const BodySchema = z.object({
  votive: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

/** Who does the solving. `baseModel` is the model string the harness is run with. */
interface SolvingAgent {
  id: string;
  displayName: string;
  baseModel: string;
}

/**
 * Pick the agent that attempts the wish.
 *
 * A proposed-and-approved strategy agent is preferred — it is a named operator
 * somebody put forward and the board signed off on, which is the intended solver.
 * Approval carries no timestamp, so "most recently approved" means the last such
 * entry in the store's own append order. Absent any approved strategy, we fall
 * back to whatever frontier model the registry currently lists as active, so a
 * fresh deployment with no strategies can still demonstrate the flow.
 */
function pickAgent(): SolvingAgent | null {
  const approved = new StrategyStore(agentDataDir())
    .list()
    .filter((a) => a.status === "approved");
  const agent = approved[approved.length - 1];
  if (agent) {
    return { id: agent.id, displayName: agent.displayName, baseModel: agent.baseModel };
  }

  const modelsFile =
    process.env.WELL_MODELS_FILE ??
    path.resolve(process.cwd(), "..", "agent", "models.json");
  const model = new ModelRegistry(modelsFile).active()[0];
  if (model) {
    // A plain model is both the identity and the base it runs on.
    return { id: model.id, displayName: model.displayName, baseModel: model.id };
  }
  return null;
}

/**
 * Turn an eval spec into mock rules that answer it correctly.
 *
 * Only used under `WELL_MOCK_LLM=1`. A bare MockLlmClient replies with a stable
 * hash string, which fails every eval — fine for parser fixtures, useless for a
 * demo whose whole point is watching a *capable* agent clear the gate and settle.
 * So in mock mode we stand in a model that has the capability: it is told the
 * right answers, exactly as a genuinely capable frontier model would produce them.
 * The PASS is therefore not evidence of capability in mock mode, only of the
 * plumbing — which is what a mock is for.
 */
function mockRulesForEval(spec: EvalSpec): MockRule[] {
  switch (spec.type) {
    case "qa":
      return [{ match: spec.question, respond: spec.expected }];
    case "multi-step":
      return spec.steps.map((s) => ({ match: s.question, respond: s.expected }));
    case "json-task": {
      const obj: Record<string, unknown> = {};
      for (const [field, type] of Object.entries(spec.requiredFields)) {
        obj[field] =
          spec.expectedValues?.[field] ??
          (type === "number" ? 0 : type === "boolean" ? true : "ok");
      }
      return [{ match: spec.instruction, respond: JSON.stringify(obj) }];
    }
    case "judged":
      // Order matters: the judge and verifier prompts both embed the task, and
      // the mock takes the first matching rule, so these must precede the task.
      return [
        { match: "Score how well the answer satisfies", respond: "1.0" },
        { match: "Try to REFUTE that verdict", respond: "UPHOLD" },
        { match: spec.task, respond: "A complete, specific answer to the task." },
      ];
    case "agentic":
      // The sandbox grades terminal ledger state, not a string, so there is no
      // single "right answer" to script. Left unseeded; a demo uses a text eval.
      return [];
  }
}

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "solve", 10, 60_000);
  if (limited) return limited;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  const votive = getAddress(parsed.data.votive);

  try {
    // The ParsedStory (with its `capability.eval`) is written per-cell by
    // /api/register-wish. StoryStore keeps only the wisher's prose; the
    // executable schema lives in the story row, keyed by the checksummed cell —
    // with a lowercase fallback, matching how the wish page itself reads it.
    const row = await prisma.story
      .findUnique({ where: { cell: votive } })
      .catch(() =>
        prisma.story.findUnique({ where: { cell: votive.toLowerCase() } }).catch(() => null),
      );
    if (!row) {
      return NextResponse.json({ error: "no story recorded for this wish" }, { status: 404 });
    }
    let story = StorySchemaZ.safeParse(row.parsed);
    if (!story.success && process.env.WELL_MOCK_LLM === "1" && row.prose) {
      // A registration that half-landed: the prose is here (and was verified
      // against the cell's own story hash when it was stored) but the parsed
      // schema is not. Under the mock parser the mapping is deterministic, so
      // regenerate it from the prose rather than refusing — and backfill the
      // row so the next caller doesn't repeat the work.
      try {
        const regenerated = mockParse(row.prose, row.wisher);
        story = StorySchemaZ.safeParse(regenerated);
        if (story.success) {
          await prisma.story
            .update({ where: { cell: row.cell ?? votive }, data: { parsed: regenerated as object } })
            .catch(() => {});
        }
      } catch {
        // fall through to the 404 below
      }
    }
    if (!story.success) {
      return NextResponse.json({ error: "no story recorded for this wish" }, { status: 404 });
    }
    const spec = story.data.capability.eval;
    const capabilitySummary = story.data.capability.summary;

    const agent = pickAgent();
    if (!agent) {
      return NextResponse.json({ error: "no solving agent is registered" }, { status: 503 });
    }

    // resolveClient() picks a real provider (API key, then a local CLI). In mock
    // mode we hand the harness a MockLlmClient seeded to answer this eval, since
    // resolveClient has no provider to reach on a dry-run box.
    let client: LlmClient;
    if (process.env.WELL_MOCK_LLM === "1") {
      client = new MockLlmClient(mockRulesForEval(spec));
    } else {
      const resolved = await resolveClient();
      if (!resolved) {
        return NextResponse.json(
          { error: "no LLM provider available on this server" },
          { status: 503 },
        );
      }
      client = resolved.client;
    }

    const maxTokens = Number(process.env.WELL_PER_RUN_MAX_TOKENS ?? 2_000);
    const result = await compileEval(spec).run(client, agent.baseModel, maxTokens);

    // The harness records one transcript row per graded turn. The first row is
    // the representative question/answer/expected for every spec shape; the
    // overall verdict is `result.pass` (e.g. all turns passed, or judge+verifier
    // agreed), which is what gates the on-chain settlement in the browser.
    const first = result.transcript[0];
    return NextResponse.json({
      ok: true,
      agent,
      question: first?.prompt ?? "",
      answer: first?.answer ?? "",
      expected: first?.expected ?? "",
      passed: result.pass,
      capabilitySummary,
    });
  } catch {
    // Never leak a stack or a provider message to the browser.
    return NextResponse.json({ error: "the eval could not be run" }, { status: 500 });
  }
}
