import type { EvalSpec } from "../schema/story.js";
import type { LlmClient } from "../llm/client.js";
import { AccountsSandbox, parseAction } from "./sandbox.js";

export interface EvalResult {
  pass: boolean;

  score: number;

  transcript: {
    prompt: string;
    answer: string;
    expected: string;
    pass: boolean;
  }[];
  inputTokens: number;
  outputTokens: number;
}

export interface CompiledEval {
  spec: EvalSpec;
  run(client: LlmClient, model: string, maxTokensPerCall: number): Promise<EvalResult>;
}

function gradeText(
  answer: string,
  expected: string,
  matcher: "exact" | "contains" | "numeric-tolerance",
  tolerance?: number,
): boolean {
  const a = answer.trim();
  switch (matcher) {
    case "exact":
      return a === expected.trim();
    case "contains":
      return a.toLowerCase().includes(expected.trim().toLowerCase());
    case "numeric-tolerance": {
      const nums = a.match(/-?\d+(?:\.\d+)?/g);
      if (!nums || nums.length === 0) return false;
      const want = Number(expected);
      const tol = tolerance ?? 0;
      return nums.some((n) => Math.abs(Number(n) - want) <= tol);
    }
  }
}

const ANSWER_SYSTEM =
  "Answer the question. Reply with the answer only — no explanation, no punctuation beyond the answer itself.";

function parseScore(text: string): number {
  const m = text.match(/-?\d+(?:\.\d+)?/);
  if (!m) return 0;
  let n = Number(m[0]);
  if (n > 1) n = n / 100;
  return Math.max(0, Math.min(1, n));
}

export function compileEval(spec: EvalSpec): CompiledEval {
  return {
    spec,
    async run(client, model, maxTokensPerCall) {
      const transcript: EvalResult["transcript"] = [];
      let inputTokens = 0;
      let outputTokens = 0;

      const ask = async (prompt: string, system?: string) => {
        const res = await client.complete({
          model,
          system,
          prompt,
          maxTokens: maxTokensPerCall,
        });
        inputTokens += res.inputTokens;
        outputTokens += res.outputTokens;
        return res.text;
      };

      if (spec.type === "qa") {
        const answer = await ask(spec.question, ANSWER_SYSTEM);
        const pass = gradeText(answer, spec.expected, spec.matcher, spec.tolerance);
        transcript.push({ prompt: spec.question, answer, expected: spec.expected, pass });
      } else if (spec.type === "json-task") {
        const answer = await ask(
          spec.instruction,
          "Reply with a single JSON object only. No prose, no code fences.",
        );
        let pass = false;
        let parsed: Record<string, unknown> | undefined;
        try {
          const start = answer.indexOf("{");
          const end = answer.lastIndexOf("}");
          parsed = JSON.parse(answer.slice(start, end + 1)) as Record<string, unknown>;
          pass = Object.entries(spec.requiredFields).every(
            ([field, type]) => typeof parsed?.[field] === type,
          );
          if (pass && spec.expectedValues) {
            pass = Object.entries(spec.expectedValues).every(
              ([field, want]) => parsed?.[field] === want,
            );
          }
        } catch {
          pass = false;
        }
        transcript.push({
          prompt: spec.instruction,
          answer,
          expected: JSON.stringify({
            requiredFields: spec.requiredFields,
            expectedValues: spec.expectedValues ?? {},
          }),
          pass,
        });
      } else if (spec.type === "multi-step") {
        for (const step of spec.steps) {
          const answer = await ask(step.question, ANSWER_SYSTEM);
          const pass = gradeText(answer, step.expected, step.matcher, step.tolerance);
          transcript.push({ prompt: step.question, answer, expected: step.expected, pass });
        }
      } else if (spec.type === "agentic") {

        const sb = new AccountsSandbox(spec.initial);
        const sys =
          "You operate an accounts ledger. Each turn reply with EXACTLY one JSON action " +
          'and nothing else:\n{"tool":"transfer","from":"A","to":"B","amount":N}  or  ' +
          '{"tool":"done"} once the target is reached.\nRules: no account may go negative; ' +
          "amount must be > 0.";
        for (let turn = 0; turn < spec.maxTurns; turn++) {
          const prompt =
            `${spec.instruction}\nCurrent balances: ${sb.state()}\n` +
            `Target: ${JSON.stringify(spec.target)}\nReply with one JSON action.`;
          const answer = await ask(prompt, sys);
          const action = parseAction(answer);
          let obs: string;
          if (!action) obs = "no valid action parsed";
          else if (action.tool === "done") obs = "done";
          else {
            const r = sb.apply(action);
            obs = r.error ? `error: ${r.error}` : `ok: ${r.observation}`;
          }
          transcript.push({
            prompt,
            answer,
            expected: `reach ${JSON.stringify(spec.target)} — ${obs}`,
            pass: sb.meets(spec.target),
          });
          if (!action || action.tool === "done" || sb.meets(spec.target)) break;
        }
        return {
          pass: sb.meets(spec.target) && sb.conserved(),
          score: sb.progress(spec.target),
          transcript,
          inputTokens,
          outputTokens,
        };
      } else if (spec.type === "judged") {

        const answer = await ask(spec.task, "Complete the task. Be concise and specific.");
        const judgeRaw = await ask(
          `Task: ${spec.task}\nRubric (what a passing answer must satisfy): ${spec.rubric}\n\n` +
            `Candidate answer:\n${answer}\n\nScore how well the answer satisfies the rubric ` +
            `from 0.0 to 1.0. Reply with ONLY the number.`,
          "You are a strict grader. Output only a decimal between 0 and 1.",
        );
        const score = parseScore(judgeRaw);
        const judgePass = score >= spec.threshold;
        const verifierRaw = await ask(
          `Task: ${spec.task}\nRubric: ${spec.rubric}\nCandidate answer:\n${answer}\n\n` +
            `A grader called this a ${judgePass ? "PASS" : "FAIL"}. Try to REFUTE that verdict ` +
            `with a concrete flaw. If you cannot, reply UPHOLD. One word: REFUTE or UPHOLD.`,
          "You are an adversarial verifier. Default to REFUTE unless the verdict is clearly right.",
        );
        const upheld = !/refute/i.test(verifierRaw);
        const pass = judgePass && upheld;
        transcript.push({ prompt: spec.task, answer, expected: `judge≥${spec.threshold} & verifier upholds`, pass });
        transcript.push({ prompt: "[judge]", answer: judgeRaw.trim(), expected: `score ≥ ${spec.threshold}`, pass: judgePass });
        transcript.push({
          prompt: "[adversarial verifier]",
          answer: verifierRaw.trim(),
          expected: judgePass && !upheld ? "UPHOLD (disagreement ⇒ needs human)" : "UPHOLD",
          pass: upheld,
        });
        return { pass, score, transcript, inputTokens, outputTokens };
      }

      const passed = transcript.filter((t) => t.pass).length;
      const score = transcript.length === 0 ? 0 : passed / transcript.length;
      return {
        pass: passed === transcript.length && transcript.length > 0,
        score,
        transcript,
        inputTokens,
        outputTokens,
      };
    },
  };
}
