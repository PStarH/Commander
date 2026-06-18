/**
 * P-obs-3: LLM-as-judge eval scorer (Braintrust-style).
 *
 * Takes a rubric (prompt template + score range + judge model) and a
 * "target" (a trace summary, a single output string, or a
 * {input, output, expected} tuple) and returns a numeric score via
 * a judge LLM. The judge LLM is the same `LLMProvider` interface
 * Commander already uses for agent execution — no new dependency.
 *
 * Design notes:
 *  - The judge prompt is a small templated string. We inject the
 *    target's fields as JSON blocks so the judge can reason about
 *    them. No fancy tool-use, no agent loop, no retries — this is
 *    a single-shot LLM call.
 *  - The judge response MUST be JSON in the shape
 *    `{ "score": <number>, "reasoning": "<string>" }`. We
 *    robustly parse the response (the LLM sometimes wraps the
 *    JSON in markdown code fences) and fall back to a score of 0
 *    with a synthetic reasoning if parsing fails.
 *  - The score is clamped to the rubric's range. Out-of-range
 *    scores are clamped, not rejected.
 *  - We never throw on judge failure — the caller (experiment
 *    runner, auto-scorer) gets back a result with `error` set.
 *    The eval pipeline is best-effort: a judge outage must not
 *    break the run.
 */

import type { LLMRequest, LLMResponse } from '@commander/core';

/** A rubric describes HOW to score something. */
export interface EvalRubric {
  id: string;
  name: string;
  description?: string;
  /**
   * Prompt template sent to the judge. Placeholders:
   *   {{input}}    — the input the agent saw
   *   {{output}}   — the agent's final output
   *   {{expected}} — the expected output (if provided)
   *   {{tools}}    — JSON array of tool names called
   *   {{durationMs}} — total run duration in ms
   *   {{costUsd}}  — total run cost in USD
   *   {{tokens}}   — total tokens used
   */
  promptTemplate: string;
  /** Inclusive score range. Default [0, 1]. */
  scoreRange?: { min: number; max: number };
  /** Judge model identifier (e.g. 'gpt-4o-mini'). Defaults to 'gpt-4o-mini'. */
  judgeModel?: string;
  /** Human-readable criteria (informational; not sent to the LLM). */
  criteria?: string[];
  /** When the rubric was created. */
  createdAt?: string;
}

export interface EvalTarget {
  /** What the agent was asked to do. */
  input: unknown;
  /** What the agent produced. */
  output: unknown;
  /** What the dataset expected (optional). */
  expected?: unknown;
  /** Tool names the agent called (informational). */
  toolsCalled?: string[];
  /** Total run duration in ms. */
  durationMs?: number;
  /** Total run cost in USD. */
  costUsd?: number;
  /** Total tokens used. */
  tokens?: number;
  /** Free-form metadata (e.g. runId, traceId). */
  metadata?: Record<string, unknown>;
}

export interface EvalScore {
  /** Numeric score, clamped to the rubric's range. */
  score: number;
  /** Judge's reasoning. Empty if the judge call failed. */
  reasoning: string;
  /** Judge model that produced the score. */
  judgeModel: string;
  /** Tokens consumed by the judge call. */
  judgeTokens: { input: number; output: number; total: number };
  /** Wall-clock time the judge took. */
  judgeDurationMs: number;
  /** Optional error string if the judge call or parse failed. */
  error?: string;
}

export interface EvalScorerConfig {
  /** Default rubric to use when no rubric is supplied. */
  defaultRubric?: EvalRubric;
  /** Default judge model when no rubric-specific model is set. */
  defaultJudgeModel?: string;
  /** Max tokens the judge may consume. Default 500. */
  maxJudgeTokens?: number;
  /** Optional temperature. Default 0 (deterministic). */
  temperature?: number;
  /** Timeout for the judge call in ms. Default 30000. */
  timeoutMs?: number;
}

/** Minimal LLM-call abstraction the scorer needs. Avoids a hard dep on AgentRuntime. */
export interface JudgeProvider {
  /** Provider name (e.g. 'openai', 'anthropic'). */
  name: string;
  /** Issue a chat call. */
  call(request: LLMRequest): Promise<LLMResponse>;
}

const DEFAULT_RUBRIC: EvalRubric = {
  id: 'default-quality',
  name: 'Default Quality',
  description: 'Generic correctness + completeness rubric.',
  promptTemplate: `You are an evaluation judge. Score the agent's output against the expected output on a scale of 0.0 to 1.0.

INPUT:
{{input}}

OUTPUT:
{{output}}

EXPECTED:
{{expected}}

TOOLS CALLED:
{{tools}}

DURATION_MS: {{durationMs}}
COST_USD: {{costUsd}}
TOKENS: {{tokens}}

Respond with ONLY a JSON object in this exact shape (no markdown, no extra text):
{"score": <number between 0.0 and 1.0>, "reasoning": "<one short sentence explaining the score>"}`,
  scoreRange: { min: 0, max: 1 },
  judgeModel: 'gpt-4o-mini',
  criteria: ['correctness', 'completeness', 'no_hallucination'],
};
export class EvalScorer {
  private readonly defaultRubric: EvalRubric;
  private readonly defaultJudgeModel: string;
  private readonly maxJudgeTokens: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  /** Registry of named rubrics, looked up by id. */
  private readonly rubrics: Map<string, EvalRubric> = new Map();

  constructor(
    /** Provider used for judge calls. May be null in tests/disabled mode. */
    private readonly provider: JudgeProvider | null,
    config: EvalScorerConfig = {},
  ) {
    this.defaultRubric = config.defaultRubric ?? DEFAULT_RUBRIC;
    this.defaultJudgeModel =
      config.defaultJudgeModel ?? this.defaultRubric.judgeModel ?? 'gpt-4o-mini';
    this.maxJudgeTokens = config.maxJudgeTokens ?? 500;
    this.temperature = config.temperature ?? 0;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.rubrics.set(this.defaultRubric.id, this.defaultRubric);
  }

  /** Register a named rubric. */
  registerRubric(rubric: EvalRubric): void {
    this.rubrics.set(rubric.id, rubric);
  }

  /** List all registered rubrics. */
  listRubrics(): EvalRubric[] {
    return Array.from(this.rubrics.values());
  }

  /** Get a rubric by id, falling back to the default. */
  getRubric(id?: string): EvalRubric {
    if (id) {
      const r = this.rubrics.get(id);
      if (r) return r;
    }
    return this.defaultRubric;
  }

  /**
   * Score a target against a rubric. Returns an EvalScore. Never
   * throws — judge failures are returned as `error` on the result.
   */
  async score(target: EvalTarget, rubricId?: string): Promise<EvalScore> {
    const rubric = this.getRubric(rubricId);
    const judgeModel = rubric.judgeModel ?? this.defaultJudgeModel;
    const range = rubric.scoreRange ?? { min: 0, max: 1 };

    if (!this.provider) {
      return {
        score: clamp(0, range.min, range.max),
        reasoning: '',
        judgeModel,
        judgeTokens: { input: 0, output: 0, total: 0 },
        judgeDurationMs: 0,
        error: 'no_provider_configured',
      };
    }

    const prompt = this.renderPrompt(rubric, target);
    const start = Date.now();
    try {
      const response = await this.callJudge(judgeModel, prompt);
      const elapsed = Date.now() - start;
      const tokens = response.usage;
      const parsed = parseJudgeResponse(response.content);
      if (parsed.error) {
        return {
          score: clamp(0, range.min, range.max),
          reasoning: '',
          judgeModel,
          judgeTokens: {
            input: tokens.promptTokens,
            output: tokens.completionTokens,
            total: tokens.totalTokens,
          },
          judgeDurationMs: elapsed,
          error: parsed.error,
        };
      }
      return {
        score: clamp(parsed.score ?? 0, range.min, range.max),
        reasoning: parsed.reasoning ?? '',
        judgeModel,
        judgeTokens: {
          input: tokens.promptTokens,
          output: tokens.completionTokens,
          total: tokens.totalTokens,
        },
        judgeDurationMs: elapsed,
      };
    } catch (err) {
      return {
        score: clamp(0, range.min, range.max),
        reasoning: '',
        judgeModel,
        judgeTokens: { input: 0, output: 0, total: 0 },
        judgeDurationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ────────── private ──────────

  private renderPrompt(rubric: EvalRubric, target: EvalTarget): string {
    return rubric.promptTemplate
      .replace('{{input}}', safeJson(target.input))
      .replace('{{output}}', safeJson(target.output))
      .replace('{{expected}}', safeJson(target.expected))
      .replace('{{tools}}', safeJson(target.toolsCalled ?? []))
      .replace('{{durationMs}}', String(target.durationMs ?? 0))
      .replace('{{costUsd}}', String(target.costUsd ?? 0))
      .replace('{{tokens}}', String(target.tokens ?? 0));
  }

  private async callJudge(model: string, prompt: string): Promise<LLMResponse> {
    const request: LLMRequest = {
      model,
      messages: [
        {
          role: 'system',
          content: 'You are an evaluation judge. Respond with ONLY a JSON object.',
        },
        { role: 'user', content: prompt },
      ],
      maxTokens: this.maxJudgeTokens,
      temperature: this.temperature,
    };
    // Race the judge call against a timeout. A hung judge must not
    // block the experiment runner.
    return await Promise.race([
      this.provider!.call(request),
      new Promise<LLMResponse>((_, reject) => {
        setTimeout(
          () => reject(new Error(`judge_call_timeout_${this.timeoutMs}ms`)),
          this.timeoutMs,
        );
      }),
    ]);
  }
}

/** Clamp a value into [min, max]. */
function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/** JSON.stringify with a fallback for circular references / non-serializable values. */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(
      v,
      (_k, val) => {
        if (typeof val === 'bigint') return val.toString();
        if (typeof val === 'function') return '[function]';
        if (typeof val === 'undefined') return '[undefined]';
        return val;
      },
      2,
    );
  } catch {
    return String(v);
  }
}

interface ParsedJudgeResponse {
  score?: number;
  reasoning?: string;
  error?: string;
}

/**
 * Parse the judge's text response into a numeric score. Tolerant
 * of markdown code fences, leading prose, and trailing text — the
 * LLM doesn't always follow instructions perfectly.
 */
export function parseJudgeResponse(text: string): ParsedJudgeResponse {
  if (!text || typeof text !== 'string') {
    return { error: 'empty_response' };
  }
  // Try the whole string first.
  const direct = tryParseJson(text);
  if (direct) return extractScore(direct);
  // Try to extract the first JSON object from the text.
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    const inside = tryParseJson(match[0]);
    if (inside) return extractScore(inside);
  }
  return { error: 'parse_failed' };
}

function tryParseJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return null;
}

function extractScore(obj: Record<string, unknown>): ParsedJudgeResponse {
  const score = typeof obj['score'] === 'number' ? obj['score'] : Number(obj['score']);
  const reasoning = typeof obj['reasoning'] === 'string' ? obj['reasoning'] : '';
  if (!Number.isFinite(score)) return { error: 'invalid_score' };
  return { score, reasoning };
}
