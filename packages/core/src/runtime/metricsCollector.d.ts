/**
 * MetricsCollector — Structured production metrics with OpenMetrics export.
 *
 * Collects counters, gauges, and histograms. Exports to:
 * 1. OpenMetrics text format (Prometheus-compatible)
 * 2. JSON line format (file logging)
 *
 * Integrates with ExecutionTraceRecorder and AgentRuntime for
 * zero-instrumentation metric collection.
 */
export type MetricType = 'counter' | 'gauge' | 'histogram';
export interface MetricLabel {
    name: string;
    value: string;
}
export interface MetricSample {
    value: number;
    timestamp: number;
    labels: MetricLabel[];
}
export interface CounterMetric {
    type: 'counter';
    name: string;
    help: string;
    total: number;
    labels: MetricLabel[];
}
export interface GaugeMetric {
    type: 'gauge';
    name: string;
    help: string;
    value: number;
    labels: MetricLabel[];
}
export interface HistogramMetric {
    type: 'histogram';
    name: string;
    help: string;
    buckets: number[];
    counts: number[];
    sum: number;
    count: number;
    labels: MetricLabel[];
}
export type Metric = CounterMetric | GaugeMetric | HistogramMetric;
export declare class MetricsCollector {
    private counters;
    private gauges;
    private histograms;
    private readonly maxUniqueMetrics;
    private enforceCap;
    incrementCounter(name: string, help: string, value?: number, labels?: MetricLabel[]): void;
    getCounter(name: string, labels?: MetricLabel[]): number;
    /**
     * Sum a counter across all label combinations.
     * Useful when the dashboard needs the total regardless of label variants.
     */
    getCounterTotal(name: string): number;
    setGauge(name: string, help: string, value: number, labels?: MetricLabel[]): void;
    getGauge(name: string, labels?: MetricLabel[]): number;
    recordHistogram(name: string, help: string, value: number, buckets: number[], labels?: MetricLabel[]): void;
    recordToolCall(toolName: string, durationMs: number, error?: string, tenantId?: string): void;
    recordLLMCall(model: string, provider: string, tokens: number, durationMs: number, error?: string, tenantId?: string): void;
    recordError(errorClass: string, tenantId?: string): void;
    recordRunComplete(status: string, durationMs: number, toolCount: number, tenantId?: string): void;
    /**
     * Tier 4.2: Record per-step latency with a step_type label. Used by the
     * agentRuntime step loop to track which pipeline phases are slow.
     *
     * stepType: 'planning' | 'tool_execution' | 'verification' | 'reflexion' |
     *           'compensation' | 'cascade_escalation'
     */
    recordStepLatency(stepType: string, durationMs: number, tenantId?: string): void;
    recordCostByFailureMode(mode: string, costUsd: number, tenantId?: string): void;
    /** Export metrics as OpenMetrics (Prometheus-compatible) text format */
    exportOpenMetrics(): string;
    /** Export metrics with GenAI OpenTelemetry semantic convention names */
    exportOpenTelemetry(): string;
    /** Shared exporter: formats all counters, gauges, and histograms as OpenMetrics text */
    private formatMetrics;
    /** Export metrics as JSON lines */
    exportJSONLines(): string;
    /** Reset all metrics */
    reset(): void;
    /** Get all metric names for inspection */
    listMetricNames(): string[];
    recordCircuitTransition(from: string, to: string, provider: string, tenantId?: string): void;
    recordCompensation(toolName: string, outcome: 'success' | 'failed' | 'exhausted', tenantId?: string): void;
    recordVerificationResult(confidence: number, passed: boolean, signalCount: number, signalSources: string[], tenantId?: string): void;
    recordCascadeEscalation(from: string, to: string, reason: string, tenantId?: string): void;
    recordCascadeAttempt(attempt: number, modelId: string, passed: boolean, tenantId?: string): void;
    recordCascadeCostSaved(costUsd: number, tenantId?: string): void;
    /** Return a JSON-serialisable snapshot of all metrics (counters, gauges, histograms). */
    getMetricsSnapshot(): {
        counters: CounterMetric[];
        gauges: GaugeMetric[];
        histograms: HistogramMetric[];
    };
    recordTopoChoice(topology: string, taskType: string, tenantId?: string): void;
    recordSubAgentOutcome(agentId: string, status: 'success' | 'failed' | 'partial' | 'interrupted', depth: number, tenantId?: string): void;
    recordHookFailure(hook: string, pluginName: string, tenantId?: string): void;
    recordDLQEntry(category: string, tenantId?: string): void;
    recordIntentEscalation(fromStage: string, toStage: string, reason: string, tenantId?: string): void;
    recordCheckpointFlush(reason: string, tenantId?: string): void;
    recordPartialRun(tenantId?: string): void;
    recordSemanticCacheEvent(outcome: 'hit' | 'miss' | 'store' | 'embedding_error', costSavedUsd?: number, tenantId?: string): void;
    recordSingleFlightEvent(outcome: 'hit' | 'miss' | 'eviction', tenantId?: string): void;
    recordGeminiCacheEvent(outcome: 'hit' | 'create' | 'evict' | 'error', tenantId?: string): void;
    recordToolCacheEvent(outcome: 'hit' | 'miss' | 'store', tenantId?: string): void;
    /** Record a skill extraction (successful or not) */
    recordSkillExtraction(outcome: 'extracted' | 'updated' | 'rejected', category?: string, tenantId?: string): void;
    /** Record whether a skills recall was a hit or miss */
    recordSkillRecallHit(hit: boolean, tenantId?: string): void;
    /** Track total experience count in MetaLearner */
    recordMetaLearnerExperienceCount(count: number, tenantId?: string): void;
    /** Track number of active regression alerts */
    recordRegressionActiveCount(count: number, tenantId?: string): void;
    /** Record prediction verification accuracy */
    recordPredictionVerdict(netImpact: 'positive' | 'negative', tenantId?: string): void;
    private key;
    private extractName;
    /**
     * Record whether the system-prompt prefix was identical to the prior
     * call's prefix (cache hit) or differed (cache miss). Pair this with
     * `setPromptPrefixCacheKey` so the cumulative cache key is observable
     * and the hit rate is computable.
     */
    /**
     * Record provider-reported prompt cache savings. Converts cache reads
     * into dollar figures using the CostModel.
     *
     * @param tokens - TokenUsage with cacheReadTokens set
     * @param provider - e.g. 'anthropic', 'openai'
     * @param model - e.g. 'claude-3-5-sonnet'
     * @param tenantId - optional tenant label
     */
    recordPromptCacheSavings(tokens: {
        promptTokens: number;
        cacheReadTokens?: number;
    }, provider: string, model: string, tenantId?: string): void;
    recordPromptPrefixCache(hit: boolean, tenantId?: string): void;
    /**
     * Track the SHA-256 hash of the most recent stable system-prompt
     * prefix as a numeric gauge. The hash is converted to a 32-bit integer
     * to avoid Prometheus label-cardinality explosion (full hex keys as
     * labels would be unbounded).
     */
    setPromptPrefixCacheKey(key: string, tenantId?: string): void;
    private formatMetricLine;
    private eventLoopLagTimer;
    private eventLoopLagMs;
    startEventLoopLagMonitor(intervalMs?: number): void;
    stopEventLoopLagMonitor(): void;
    getEventLoopLagMs(): number;
    recordCPUWorkerPoolStats(stats: {
        poolSize: number;
        availableWorkers: number;
        queueDepth: number;
        totalExecuted: number;
        totalQueued: number;
    }): void;
}
/** Get the global MetricsCollector (single-tenant) or tenant-scoped (multi-tenant). */
export declare function getMetricsCollector(): MetricsCollector;
/** Reset the metrics collector singleton (for test isolation). */
export declare function resetMetricsCollector(): void;
//# sourceMappingURL=metricsCollector.d.ts.map