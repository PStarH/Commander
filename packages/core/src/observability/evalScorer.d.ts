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
import type { LLMRequest, LLMResponse } from '../runtime/types';
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
    scoreRange?: {
        min: number;
        max: number;
    };
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
    judgeTokens: {
        input: number;
        output: number;
        total: number;
    };
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
export declare class EvalScorer {
    /** Provider used for judge calls. May be null in tests/disabled mode. */
    private readonly provider;
    private readonly defaultRubric;
    private readonly defaultJudgeModel;
    private readonly maxJudgeTokens;
    private readonly temperature;
    private readonly timeoutMs;
    /** Registry of named rubrics, looked up by id. */
    private readonly rubrics;
    constructor(
    /** Provider used for judge calls. May be null in tests/disabled mode. */
    provider: JudgeProvider | null, config?: EvalScorerConfig);
    /** Register a named rubric. */
    registerRubric(rubric: EvalRubric): void;
    /** List all registered rubrics. */
    listRubrics(): EvalRubric[];
    /** Get a rubric by id, falling back to the default. */
    getRubric(id?: string): EvalRubric;
    /**
     * Score a target against a rubric. Returns an EvalScore. Never
     * throws — judge failures are returned as `error` on the result.
     */
    score(target: EvalTarget, rubricId?: string): Promise<EvalScore>;
    private renderPrompt;
    private callJudge;
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
export declare function parseJudgeResponse(text: string): ParsedJudgeResponse;
export {};
//# sourceMappingURL=evalScorer.d.ts.map