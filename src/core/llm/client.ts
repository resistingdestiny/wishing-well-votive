import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

export interface LlmRequest {
  model: string;
  system?: string;
  prompt: string;
  maxTokens: number;
}

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  provider: string;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Direct Anthropic Messages API via fetch. Requires ANTHROPIC_API_KEY. */
export class AnthropicApiClient implements LlmClient {
  constructor(private readonly apiKey: string) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: "user", content: req.prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`anthropic api ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      content: { type: string; text?: string }[];
      usage: { input_tokens: number; output_tokens: number };
    };
    const text = body.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    return {
      text,
      inputTokens: body.usage.input_tokens,
      outputTokens: body.usage.output_tokens,
      provider: "anthropic-api",
    };
  }
}

/**
 * Claude Code CLI as an LLM transport (`claude -p`). Uses the operator's
 * existing authenticated session — no separate API key. Token usage comes from
 * the CLI's JSON envelope.
 */
export class ClaudeCliClient implements LlmClient {
  constructor(private readonly bin: string = "claude") {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const args = [
      "-p",
      req.prompt,
      "--model",
      req.model,
      "--output-format",
      "json",
      "--max-turns",
      "1",
    ];
    if (req.system) args.push("--append-system-prompt", req.system);
    const { stdout } = await execFileAsync(this.bin, args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 300_000,
    });
    const body = JSON.parse(stdout) as {
      result?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      text: body.result ?? "",
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      provider: "claude-cli",
    };
  }
}

/** Injectable fetch so the adapter is unit-testable without a network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

/**
 * OpenAI-compatible Chat Completions adapter (`POST {baseUrl}/chat/completions`,
 * `Authorization: Bearer <key>`). One adapter covers most non-Anthropic fleets —
 * OpenAI, xAI, DeepSeek, Together, local vLLM/Ollama gateways — since they all
 * speak this schema. `provider` is labelled from the base-URL host so the run log
 * and cost ledger attribute spend to the right vendor. Using it needs a real key
 * (a gate); the adapter itself is pure and tested against an injected fetch.
 */
export class OpenAiCompatibleClient implements LlmClient {
  private readonly base: string;
  readonly provider: string;
  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    provider?: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.provider = provider ?? providerFromUrl(baseUrl);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      { role: "user", content: req.prompt },
    ];
    const res = await this.fetchImpl(`${this.base}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        messages,
      }),
    });
    if (!res.ok) {
      throw new Error(`openai-compatible api ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
      provider: this.provider,
    };
  }
}

/** Best-effort provider label from a base URL host (openai / xai / deepseek / …). */
export function providerFromUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;
    const m = host.match(/(?:^|\.)(openai|anthropic|x|xai|deepseek|mistral|together|groq|google|googleapis)(?:\.|$)/);
    if (m) return m[1] === "x" ? "xai" : m[1]!;
    const parts = host.split(".").filter((p) => p && p !== "api" && p !== "www");
    return parts[0] ?? "openai-compatible";
  } catch {
    return "openai-compatible";
  }
}

export interface MockRule {
  /** Substring matched against the prompt. First matching rule wins. */
  match: string;
  respond?: string;
  /**
   * Cycle through these responses on successive matches of this rule — models a
   * flaky model whose answer varies run to run, so pass@k gating can be tested.
   * Takes precedence over `respond`.
   */
  sequence?: string[];
}

/**
 * Deterministic mock for tests and dry runs. Scripted rules first; otherwise
 * replies with a stable hash-derived string so runs are reproducible. A rule
 * with `sequence` cycles its responses per match, deterministically flaky.
 */
export class MockLlmClient implements LlmClient {
  public calls: LlmRequest[] = [];
  private readonly seqCounters = new Map<string, number>();
  constructor(private readonly rules: MockRule[] = []) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const rule = this.rules.find((r) => req.prompt.includes(r.match));
    let text: string;
    if (rule?.sequence && rule.sequence.length > 0) {
      const n = this.seqCounters.get(rule.match) ?? 0;
      text = rule.sequence[n % rule.sequence.length]!;
      this.seqCounters.set(rule.match, n + 1);
    } else {
      text =
        rule?.respond ??
        `mock:${crypto.createHash("sha256").update(req.prompt).digest("hex").slice(0, 16)}`;
    }
    return {
      text,
      inputTokens: Math.ceil(req.prompt.length / 4),
      outputTokens: Math.ceil(text.length / 4),
      provider: "mock",
    };
  }
}

/**
 * Provider resolution: real API key first, then the local Claude CLI, else the
 * caller must inject a mock explicitly (sweeps refuse to silently mock).
 */
export async function resolveClient(env: NodeJS.ProcessEnv = process.env): Promise<{
  client: LlmClient;
  provider: string;
} | null> {
  if (env.ANTHROPIC_API_KEY) {
    return { client: new AnthropicApiClient(env.ANTHROPIC_API_KEY), provider: "anthropic-api" };
  }
  if (env.WELL_OPENAI_BASE_URL && env.WELL_OPENAI_API_KEY) {
    const client = new OpenAiCompatibleClient(
      env.WELL_OPENAI_BASE_URL,
      env.WELL_OPENAI_API_KEY,
      env.WELL_OPENAI_PROVIDER,
    );
    return { client, provider: client.provider };
  }
  try {
    await execFileAsync("claude", ["--version"], { timeout: 10_000 });
    return { client: new ClaudeCliClient(), provider: "claude-cli" };
  } catch {
    return null;
  }
}
