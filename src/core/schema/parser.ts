import { z } from "zod";
import type { LlmClient } from "../llm/client.js";
import { StorySchemaZ, type ParsedStory } from "./story.js";

const SYSTEM = `You convert a user's natural-language wish story into a strict JSON StorySchema for the Wishing Well protocol. Output ONLY a JSON object, no prose, no code fences.

Schema:
{
  "kind": "return-on-condition" | "distribute-to-active" | "offchain-action",
  "wisher": "0x…",                        // the wisher's address, given in the request
  "guardian": "0x…",                      // optional; only if the story names one
  "beneficiary": "0x…",                   // optional; return-on-condition payout target if not the wisher
  "capability": {
    "summary": "what an AI model must be able to do before attempting this wish",
    "eval": {                              // an executable check, choose ONE shape:
      {"type":"qa","question":"…","expected":"…","matcher":"exact"|"contains"|"numeric-tolerance","tolerance":0.01}
      | {"type":"json-task","instruction":"…","requiredFields":{"field":"string"|"number"|"boolean"},"expectedValues":{"field":…}}
      | {"type":"multi-step","steps":[{"question":"…","expected":"…","matcher":"…"}, …]}
      | {"type":"agentic","sandbox":"accounts","instruction":"…","initial":{"A":100},"target":{"A":0,"C":100},"maxTurns":8}  // tool-use, graded on terminal state
      | {"type":"judged","task":"…","rubric":"what a passing answer must satisfy","threshold":0.7}  // subjective: LLM judge + adversarial verifier
    }
  },
  "condition": {
    "summary": "when the wish should resolve, in plain words",
    "canonical": "machine-readable one-line condition string"
  },
  "amendPolicy": {"amendAfterDays": 365, "escheatAfterDays": 1825},
  "actionBudgetWei": "0"                   // offchain-action only, else "0"
}

Rules: choose the simplest kind that honours the story; prefer an objectively-gradable kind (qa/json-task/multi-step/agentic) and use "judged" only for genuinely subjective capabilities; if the story is impossible to schematise, output {"error":"<one sentence why>"}.`;

export class StoryParseError extends Error {}

export interface ParseResult {
  story: ParsedStory;
  raw: string;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) throw new StoryParseError("no JSON object in reply");
  return JSON.parse(trimmed.slice(start, end + 1));
}

/**
 * Parse story prose into a validated StorySchema via an LLM, with one retry
 * that feeds validation errors back to the model. Deterministic under
 * MockLlmClient in tests.
 */
export async function parseStory(
  prose: string,
  wisher: `0x${string}`,
  client: LlmClient,
  model: string,
): Promise<ParseResult> {
  const prompt = `Wisher address: ${wisher}\n\nStory:\n${prose}`;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.complete({
      model,
      system: SYSTEM,
      prompt: attempt === 0 ? prompt : `${prompt}\n\nYour previous output failed validation: ${lastError}\nOutput corrected JSON only.`,
      maxTokens: 2_000,
    });
    let candidate: unknown;
    try {
      candidate = extractJson(res.text);
    } catch (e) {
      lastError = (e as Error).message;
      continue;
    }
    if (
      candidate &&
      typeof candidate === "object" &&
      "error" in (candidate as Record<string, unknown>)
    ) {
      throw new StoryParseError(
        `model declined: ${(candidate as Record<string, string>).error}`,
      );
    }
    const parsed = StorySchemaZ.safeParse(candidate);
    if (parsed.success) {
      if (parsed.data.wisher.toLowerCase() !== wisher.toLowerCase()) {
        lastError = "wisher field must equal the provided wisher address";
        continue;
      }
      return { story: parsed.data, raw: res.text };
    }
    lastError = parsed.error.issues
      .map((i: z.ZodIssue) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
  }
  throw new StoryParseError(`could not parse story after retry: ${lastError}`);
}
