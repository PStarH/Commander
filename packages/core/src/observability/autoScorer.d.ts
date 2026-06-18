/**
 * P-obs-3: AutoScorer — production eval hook.
 *
 * Wires the EvalScorer into the live trace recorder so a fraction
 * of completed traces are auto-scored against a rubric. The scored
 * results are stored for HTTP retrieval (`/api/v1/observability/auto-score`).
 *
 * Design:
 *  - Sampling is deterministic (hash of traceId) so a trace is
 *    always either in-sample or out-of-sample, regardless of
 *    process restarts.
 *  - Async by default: scoring happens in the background so the
 *    run that produced the trace isn't blocked. A `firehose` mode
 *    blocks the recorder (only for tests / debug).
 *  - The hook is a `TraceHook` (beforeLLMCall / afterLLMCall / etc.
 *    aren't a fit here — we need post-completion). Commander's
 *    recorder exposes a `recordEvent` we can wrap; the integration
 *    is one line.
 *  - Filters narrow which traces get scored (taskCategory, model,
 *    tenantId). All filters must match (AND).
 *
 * Public API:
 *  - configure(config) — enable / disable / change settings
 *  - getConfig() — read current settings
 *  - getResults(limit) — recent scored results
 *  - clearResults() — purge the result buffer
 *  - isInSample(traceId) — true if the trace would be scored (used
 *    by the integration to avoid scheduling useless work)
 */
import type { ExecutionTrace } from '../runtime/types';
import { type EvalScorer } from './evalScorer';
export interface AutoScorerConfig {
    /** Master switch. When false, no scoring happens. */
    enabled: boolean;
    /** Rubric id to apply. Must be registered with the EvalScorer. */
    rubricId: string;
    /** Sample rate in [0, 1]. 1.0 = score every trace. Default 0.1. */
    sampleRate: number;
    /** Deterministic salt. Two AutoScorers with different salts see different samples. */
    salt: string;
    /** When true, score synchronously and block the recorder. Default false (fire-and-forget). */
    synchronous: boolean;
    /** Optional filters. A trace must match ALL filters to be scored. */
    filters?: {
        /** Only score traces whose taskCategory matches one of these. */
        taskCategory?: string[];
        /** Only score traces whose model matches one of these. */
        model?: string[];
        /** Only score traces from one of these tenants. */
        tenantId?: string[];
        /** Only score traces with ≥ this many tokens. */
        minTokens?: number;
        /** Only score traces with errors. Default false (score both). */
        errorsOnly?: boolean;
    };
    /** Max results to keep in memory. Older results evicted FIFO. */
    maxResults?: number;
}
export interface AutoScoreResult {
    /** traceId of the scored trace. */
    traceId: string;
    /** runId of the scored trace. */
    runId: string;
    /** Rubric id used. */
    rubricId: string;
    /** The judge's score. */
    score: number;
    /** Judge's reasoning. */
    reasoning: string;
    /** Total tokens (LLM + judge). */
    totalTokens: number;
    /** Wall-clock judge duration. */
    judgeDurationMs: number;
    /** Optional error string. */
    error?: string;
    /** When the score was recorded. */
    scoredAt: string;
    /** Trace summary metadata for filtering / display. */
    traceSummary: {
        agentId: string;
        model?: string;
        provider?: string;
        taskCategory?: string;
        tenantId?: string;
        durationMs: number;
        totalTokens: number;
        hasErrors: boolean;
    };
}
export declare class AutoScorer {
    private config;
    private readonly scorer;
    private readonly results;
    /** Pending scoring promises (best-effort tracking for graceful shutdown). */
    private readonly inflight;
    constructor(scorer: EvalScorer, config?: Partial<AutoScorerConfig>);
    /** Update the configuration. Clamps sampleRate to [0, 1]. */
    configure(config: Partial<AutoScorerConfig>): AutoScorerConfig;
    /** Read-only snapshot of the current configuration. */
    getConfig(): AutoScorerConfig;
    /**
     * Deterministically decide whether a trace is in-sample. Hash of
     * `${salt}:${traceId}` modulo 1 — same traceId always lands in
     * the same bucket regardless of process restarts.
     */
    isInSample(traceId: string): boolean;
    /**
     * Score a completed trace. Returns the result (or undefined when
     * disabled / out of sample / filtered out). Safe to call from
     * the recorder's hot path — never throws.
     */
    scoreTrace(trace: ExecutionTrace): Promise<AutoScoreResult | undefined>;
    /** Wait for all in-flight scoring to complete. */
    drain(): Promise<void>;
    /** Recent scored results, newest first. */
    getResults(limit?: number): AutoScoreResult[];
    /** Drop all stored results. Useful for tests + privacy. */
    clearResults(): void;
    /** Count of stored results. */
    size(): number;
    private matchesFilters;
    private remember;
}
//# sourceMappingURL=autoScorer.d.ts.map