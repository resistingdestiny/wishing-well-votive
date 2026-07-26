import { StorySchemaZ, type ParsedStory } from "./story.js";

/**
 * The deterministic parse used when `WELL_MOCK_LLM=1`: the same prose always
 * yields the same schema, so anything derived from it — capability ids, story
 * hashes, eval specs — is reproducible across processes and across time.
 *
 * Shared here because two routes need the identical mapping: `/api/parse-story`
 * when a wish is composed, and `/api/solve` when a wish's stored schema turns
 * out to be missing (a registration that half-landed) and has to be regenerated
 * from the prose the chain has already committed to.
 */
export function mockParse(prose: string, wisher: string): ParsedStory {
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
