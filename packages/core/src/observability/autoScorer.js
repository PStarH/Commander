"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutoScorer = void 0;
const DEFAULT_CONFIG = {
    enabled: false,
    rubricId: 'default-quality',
    sampleRate: 0.1,
    salt: 'commander-default-auto-scorer-salt',
    synchronous: false,
    maxResults: 500,
};
class AutoScorer {
    constructor(scorer, config) {
        this.results = [];
        /** Pending scoring promises (best-effort tracking for graceful shutdown). */
        this.inflight = new Set();
        this.scorer = scorer;
        this.config = { ...DEFAULT_CONFIG, ...(config !== null && config !== void 0 ? config : {}) };
    }
    /** Update the configuration. Clamps sampleRate to [0, 1]. */
    configure(config) {
        const next = { ...this.config, ...config };
        if (!Number.isFinite(next.sampleRate))
            next.sampleRate = 0;
        next.sampleRate = Math.max(0, Math.min(1, next.sampleRate));
        this.config = next;
        return this.config;
    }
    /** Read-only snapshot of the current configuration. */
    getConfig() {
        return { ...this.config };
    }
    /**
     * Deterministically decide whether a trace is in-sample. Hash of
     * `${salt}:${traceId}` modulo 1 — same traceId always lands in
     * the same bucket regardless of process restarts.
     */
    isInSample(traceId) {
        if (!this.config.enabled)
            return false;
        if (this.config.sampleRate >= 1)
            return true;
        if (this.config.sampleRate <= 0)
            return false;
        const h = djb2(`${this.config.salt}:${traceId}`);
        return h < this.config.sampleRate;
    }
    /**
     * Score a completed trace. Returns the result (or undefined when
     * disabled / out of sample / filtered out). Safe to call from
     * the recorder's hot path — never throws.
     */
    async scoreTrace(trace) {
        if (!this.config.enabled)
            return undefined;
        if (!this.isInSample(trace.traceId))
            return undefined;
        if (!this.matchesFilters(trace))
            return undefined;
        const target = traceToTarget(trace);
        const scoringPromise = this.scorer
            .score(target, this.config.rubricId)
            .then((es) => {
            const summary = summarizeTrace(trace);
            const result = {
                traceId: trace.traceId,
                runId: trace.runId,
                rubricId: this.config.rubricId,
                score: es.score,
                reasoning: es.reasoning,
                totalTokens: summary.totalTokens + es.judgeTokens.total,
                judgeDurationMs: es.judgeDurationMs,
                error: es.error,
                scoredAt: new Date().toISOString(),
                traceSummary: summary,
            };
            this.remember(result);
            return result;
        });
        if (this.config.synchronous) {
            return await scoringPromise;
        }
        // Fire-and-forget. Track the promise so graceful shutdown can await it.
        const tracked = scoringPromise.then(() => undefined, () => undefined);
        this.inflight.add(tracked);
        tracked.finally(() => this.inflight.delete(tracked));
        return undefined; // caller doesn't get the result synchronously
    }
    /** Wait for all in-flight scoring to complete. */
    async drain() {
        await Promise.allSettled(Array.from(this.inflight));
    }
    /** Recent scored results, newest first. */
    getResults(limit = 50) {
        const out = [];
        for (let i = this.results.length - 1; i >= 0 && out.length < limit; i--) {
            out.push(this.results[i]);
        }
        return out;
    }
    /** Drop all stored results. Useful for tests + privacy. */
    clearResults() {
        this.results.length = 0;
    }
    /** Count of stored results. */
    size() {
        return this.results.length;
    }
    // ────────── private ──────────
    matchesFilters(trace) {
        var _a;
        const f = this.config.filters;
        if (!f)
            return true;
        if (f.tenantId && (!trace.tenantId || !f.tenantId.includes(trace.tenantId)))
            return false;
        const totalTokens = trace.events.reduce((s, e) => { var _a, _b; return s + ((_b = (_a = e.data.tokenUsage) === null || _a === void 0 ? void 0 : _a.totalTokens) !== null && _b !== void 0 ? _b : 0); }, 0);
        if (f.minTokens !== undefined && totalTokens < f.minTokens)
            return false;
        if (f.errorsOnly) {
            const hasErrors = trace.events.some((e) => e.type === 'error');
            if (!hasErrors)
                return false;
        }
        if (f.model || f.taskCategory) {
            // Pull the model + taskCategory off the first LLM call.
            const firstLlm = trace.events.find((e) => e.type === 'llm_call');
            if (!firstLlm)
                return false;
            const model = (_a = firstLlm.data.modelInfo) === null || _a === void 0 ? void 0 : _a.model;
            const taskCat = firstLlm.data.taskCategory;
            if (f.model && (!model || !f.model.includes(model)))
                return false;
            if (f.taskCategory && (!taskCat || !f.taskCategory.includes(taskCat)))
                return false;
        }
        return true;
    }
    remember(result) {
        var _a;
        const cap = (_a = this.config.maxResults) !== null && _a !== void 0 ? _a : 500;
        if (this.results.length >= cap) {
            // Evict the oldest FIFO.
            this.results.shift();
        }
        this.results.push(result);
    }
}
exports.AutoScorer = AutoScorer;
// ────────── helpers ──────────
function traceToTarget(trace) {
    var _a, _b, _c, _d, _e, _f;
    // Pull a representative input/output from the trace.
    //  - input: the goal from any context-bearing event (state_change / llm_call)
    //  - output: the last llm_call response content
    //  - toolsCalled: unique tool names
    //  - tokens: total
    //  - durationMs: total
    //  - costUsd: not tracked here (caller can compute from events if needed)
    const toolsCalled = Array.from(new Set(trace.events
        .filter((e) => e.type === 'tool_execution')
        .map((e) => { var _a; return String((_a = e.data.input) !== null && _a !== void 0 ? _a : ''); })));
    const input = (_d = (_b = (_a = trace.events.find((e) => e.type === 'state_change')) === null || _a === void 0 ? void 0 : _a.data.input) !== null && _b !== void 0 ? _b : (_c = trace.events[0]) === null || _c === void 0 ? void 0 : _c.data.input) !== null && _d !== void 0 ? _d : { goal: '<unknown>' };
    const lastLlm = trace.events.filter((e) => e.type === 'llm_call');
    const output = lastLlm.length > 0 ? ((_f = (_e = lastLlm[lastLlm.length - 1]) === null || _e === void 0 ? void 0 : _e.data.output) !== null && _f !== void 0 ? _f : '') : '';
    return {
        input,
        output,
        toolsCalled,
        durationMs: trace.summary.totalDurationMs,
        tokens: trace.summary.totalTokens,
        metadata: { traceId: trace.traceId, runId: trace.runId, agentId: trace.agentId },
    };
}
function summarizeTrace(trace) {
    var _a, _b, _c;
    const firstLlm = trace.events.find((e) => e.type === 'llm_call');
    return {
        agentId: trace.agentId,
        model: (_a = firstLlm === null || firstLlm === void 0 ? void 0 : firstLlm.data.modelInfo) === null || _a === void 0 ? void 0 : _a.model,
        provider: (_b = firstLlm === null || firstLlm === void 0 ? void 0 : firstLlm.data.modelInfo) === null || _b === void 0 ? void 0 : _b.provider,
        taskCategory: (_c = firstLlm === null || firstLlm === void 0 ? void 0 : firstLlm.data) === null || _c === void 0 ? void 0 : _c.taskCategory,
        tenantId: trace.tenantId,
        durationMs: trace.summary.totalDurationMs,
        totalTokens: trace.summary.totalTokens,
        hasErrors: trace.events.some((e) => e.type === 'error'),
    };
}
/** djb2 → [0, 1) deterministic float. Same as samplingPolicy.ts. */
function djb2(input) {
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
    }
    return ((hash >>> 0) % 1000000) / 1000000;
}
