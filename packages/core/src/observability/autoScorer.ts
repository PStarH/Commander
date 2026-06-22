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
import { type EvalScorer, type EvalTarget, type EvalScore } from './evalScorer';

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
  /**
   * Whether the judge actually scored this trace. Mirror of
   * EvalScore.graded — `graded: false` means the scorer skipped the
   * judge call (typically because the dataset case had missing
   * `expected`). Aggregations MUST filter on `r.graded !== false`
   * before averaging so missing-expected cases don't drag the
   * baseline down over time. Always set; never undefined.
   */
  graded: boolean;
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

const DEFAULT_CONFIG: AutoScorerConfig = {
  enabled: false,
  rubricId: 'default-quality',
  sampleRate: 0.1,
  salt: 'commander-default-auto-scorer-salt',
  synchronous: false,
  maxResults: 500,
};

export class AutoScorer {
  private config: AutoScorerConfig;
  private readonly scorer: EvalScorer;
  private readonly results: AutoScoreResult[] = [];
  /** Pending scoring promises (best-effort tracking for graceful shutdown). */
  private readonly inflight: Set<Promise<void>> = new Set();

  constructor(scorer: EvalScorer, config?: Partial<AutoScorerConfig>) {
    this.scorer = scorer;
    this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  }

  /** Update the configuration. Clamps sampleRate to [0, 1]. */
  configure(config: Partial<AutoScorerConfig>): AutoScorerConfig {
    const next: AutoScorerConfig = { ...this.config, ...config };
    if (!Number.isFinite(next.sampleRate)) next.sampleRate = 0;
    next.sampleRate = Math.max(0, Math.min(1, next.sampleRate));
    this.config = next;
    return this.config;
  }

  /** Read-only snapshot of the current configuration. */
  getConfig(): AutoScorerConfig {
    return { ...this.config };
  }

  /**
   * Deterministically decide whether a trace is in-sample. Hash of
   * `${salt}:${traceId}` modulo 1 — same traceId always lands in
   * the same bucket regardless of process restarts.
   */
  isInSample(traceId: string): boolean {
    if (!this.config.enabled) return false;
    if (this.config.sampleRate >= 1) return true;
    if (this.config.sampleRate <= 0) return false;
    const h = djb2(`${this.config.salt}:${traceId}`);
    return h < this.config.sampleRate;
  }

  /**
   * Score a completed trace. Returns the result (or undefined when
   * disabled / out of sample / filtered out). Safe to call from
   * the recorder's hot path — never throws.
   */
  async scoreTrace(trace: ExecutionTrace): Promise<AutoScoreResult | undefined> {
    if (!this.config.enabled) return undefined;
    if (!this.isInSample(trace.traceId)) return undefined;
    if (!this.matchesFilters(trace)) return undefined;

    const target = traceToTarget(trace);
    const scoringPromise = this.scorer
      .score(target, this.config.rubricId)
      .then((es: EvalScore): AutoScoreResult => {
        const summary = summarizeTrace(trace);
        const result: AutoScoreResult = {
          traceId: trace.traceId,
          runId: trace.runId,
          rubricId: this.config.rubricId,
          score: es.score,
          reasoning: es.reasoning,
          totalTokens: summary.totalTokens + es.judgeTokens.total,
          judgeDurationMs: es.judgeDurationMs,
          error: es.error,
          scoredAt: new Date().toISOString(),
          // Back-compat: legacy EvalScore had graded undefined → true.
          graded: es.graded !== false,
          traceSummary: summary,
        };
        this.remember(result);
        return result;
      });
    if (this.config.synchronous) {
      return await scoringPromise;
    }
    // Fire-and-forget. Track the promise so graceful shutdown can await it.
    const tracked = scoringPromise.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(tracked);
    tracked.finally(() => this.inflight.delete(tracked));
    return undefined; // caller doesn't get the result synchronously
  }

  /** Wait for all in-flight scoring to complete. */
  async drain(): Promise<void> {
    await Promise.allSettled(Array.from(this.inflight));
  }

  /** Recent scored results, newest first. */
  getResults(limit = 50): AutoScoreResult[] {
    const out: AutoScoreResult[] = [];
    for (let i = this.results.length - 1; i >= 0 && out.length < limit; i--) {
      out.push(this.results[i]!);
    }
    return out;
  }

  /** Drop all stored results. Useful for tests + privacy. */
  clearResults(): void {
    this.results.length = 0;
  }

  /** Count of stored results. */
  size(): number {
    return this.results.length;
  }

  // ────────── private ──────────

  private matchesFilters(trace: ExecutionTrace): boolean {
    const f = this.config.filters;
    if (!f) return true;
    if (f.tenantId && (!trace.tenantId || !f.tenantId.includes(trace.tenantId))) return false;
    const totalTokens = trace.events.reduce((s, e) => s + (e.data.tokenUsage?.totalTokens ?? 0), 0);
    if (f.minTokens !== undefined && totalTokens < f.minTokens) return false;
    if (f.errorsOnly) {
      const hasErrors = trace.events.some((e) => e.type === 'error');
      if (!hasErrors) return false;
    }
    if (f.model || f.taskCategory) {
      // Pull the model + taskCategory off the first LLM call.
      const firstLlm = trace.events.find((e) => e.type === 'llm_call');
      if (!firstLlm) return false;
      const model = firstLlm.data.modelInfo?.model;
      const taskCat = (firstLlm.data as { taskCategory?: string }).taskCategory;
      if (f.model && (!model || !f.model.includes(model))) return false;
      if (f.taskCategory && (!taskCat || !f.taskCategory.includes(taskCat))) return false;
    }
    return true;
  }

  private remember(result: AutoScoreResult): void {
    const cap = this.config.maxResults ?? 500;
    if (this.results.length >= cap) {
      // Evict the oldest FIFO.
      this.results.shift();
    }
    this.results.push(result);
  }
}

// ────────── helpers ──────────

function traceToTarget(trace: ExecutionTrace): EvalTarget {
  // Pull a representative input/output from the trace.
  //  - input: the goal from any context-bearing event (state_change / llm_call)
  //  - output: the last llm_call response content
  //  - toolsCalled: unique tool names
  //  - tokens: total
  //  - durationMs: total
  //  - costUsd: not tracked here (caller can compute from events if needed)
  const toolsCalled = Array.from(
    new Set(
      trace.events
        .filter((e) => e.type === 'tool_execution')
        .map((e) => String(e.data.input ?? '')),
    ),
  );
  const input = trace.events.find((e) => e.type === 'state_change')?.data.input ??
    trace.events[0]?.data.input ?? { goal: '<unknown>' };
  const lastLlm = trace.events.filter((e) => e.type === 'llm_call');
  const output = lastLlm.length > 0 ? (lastLlm[lastLlm.length - 1]?.data.output ?? '') : '';
  return {
    input,
    output,
    // Sentinel: live traces have no dataset-style ground truth. Set a
    // non-empty placeholder so classifyExpected() does not route the
    // auto-score through the empty-expected regression-guard (which is
    // intended for the EvalScore / dataset-case path, not the trace-
    // quality path). The judge prompt sees a clear sentinel header so
    // it knows the assessment is quality, not correctness.
    expected: 'live-trace-quality-evaluation',
    toolsCalled,
    durationMs: trace.summary.totalDurationMs,
    tokens: trace.summary.totalTokens,
    metadata: { traceId: trace.traceId, runId: trace.runId, agentId: trace.agentId },
  };
}

function summarizeTrace(trace: ExecutionTrace): AutoScoreResult['traceSummary'] {
  const firstLlm = trace.events.find((e) => e.type === 'llm_call');
  return {
    agentId: trace.agentId,
    model: firstLlm?.data.modelInfo?.model,
    provider: firstLlm?.data.modelInfo?.provider,
    taskCategory: (firstLlm?.data as { taskCategory?: string } | undefined)?.taskCategory,
    tenantId: trace.tenantId,
    durationMs: trace.summary.totalDurationMs,
    totalTokens: trace.summary.totalTokens,
    hasErrors: trace.events.some((e) => e.type === 'error'),
  };
}

/** djb2 → [0, 1) deterministic float. Same as samplingPolicy.ts. */
function djb2(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) % 1_000_000) / 1_000_000;
}
