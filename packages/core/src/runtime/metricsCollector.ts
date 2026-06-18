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
// ============================================================================
// Metric Types
// ============================================================================

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

// ============================================================================
// Default bucket boundaries for histograms (in milliseconds)
// ============================================================================

const LATENCY_BUCKETS_MS = [10, 50, 100, 500, 1000, 3000, 5000, 10000, 30000];

const TOKEN_BUCKETS = [100, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000];

// ============================================================================
// MetricsCollector
// ============================================================================

export class MetricsCollector {
  private counters = new Map<string, CounterMetric>();
  private gauges = new Map<string, GaugeMetric>();
  private histograms = new Map<string, HistogramMetric>();
  private readonly maxUniqueMetrics = 1000;

  private enforceCap(map: Map<string, unknown>): void {
    if (map.size < this.maxUniqueMetrics) return;
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }

  // ── Counters ──

  incrementCounter(name: string, help: string, value = 1, labels: MetricLabel[] = []): void {
    const key = this.key(name, labels);
    let metric = this.counters.get(key);
    if (!metric) {
      this.enforceCap(this.counters);
      metric = { type: 'counter', name, help, total: 0, labels };
      this.counters.set(key, metric);
    }
    metric.total += value;
  }

  getCounter(name: string, labels: MetricLabel[] = []): number {
    if (labels.length === 0) {
      // No labels → exact key lookup
      return this.counters.get(name)?.total ?? 0;
    }
    // Partial label matching: sum across all counters with matching name
    // where all provided labels match (extra stored labels are ignored).
    let total = 0;
    for (const [key, metric] of this.counters) {
      if (this.extractName(key) !== name) continue;
      const allMatch = labels.every((reqLabel) =>
        metric.labels.some(
          (storedLabel) =>
            storedLabel.name === reqLabel.name && storedLabel.value === reqLabel.value,
        ),
      );
      if (allMatch) total += metric.total;
    }
    return total;
  }

  /**
   * Sum a counter across all label combinations.
   * Useful when the dashboard needs the total regardless of label variants.
   */
  getCounterTotal(name: string): number {
    let total = 0;
    for (const [key, metric] of this.counters) {
      if (this.extractName(key) === name) {
        total += metric.total;
      }
    }
    return total;
  }

  // ── Gauges ──

  setGauge(name: string, help: string, value: number, labels: MetricLabel[] = []): void {
    const key = this.key(name, labels);
    if (!this.gauges.has(key)) {
      this.enforceCap(this.gauges);
    }
    this.gauges.set(key, { type: 'gauge', name, help, value, labels });
  }

  getGauge(name: string, labels: MetricLabel[] = []): number {
    return this.gauges.get(this.key(name, labels))?.value ?? 0;
  }

  // ── Histograms ──

  recordHistogram(
    name: string,
    help: string,
    value: number,
    buckets: number[],
    labels: MetricLabel[] = [],
  ): void {
    const key = this.key(name, labels);
    let metric = this.histograms.get(key);
    if (!metric) {
      this.enforceCap(this.histograms);
      metric = {
        type: 'histogram',
        name,
        help,
        buckets,
        counts: new Array(buckets.length + 1).fill(0),
        sum: 0,
        count: 0,
        labels,
      };
      this.histograms.set(key, metric);
    }
    metric.sum += value;
    metric.count++;
    // Place in bucket
    let placed = false;
    for (let i = 0; i < buckets.length; i++) {
      if (value <= buckets[i]) {
        metric.counts[i]++;
        placed = true;
        break;
      }
    }
    if (!placed) metric.counts[buckets.length]++;
  }

  // ── Convenience: record tool execution metrics ──

  recordToolCall(toolName: string, durationMs: number, error?: string, tenantId?: string): void {
    const labels: MetricLabel[] = [{ name: 'tool', value: toolName }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    if (error) {
      this.incrementCounter('tool_errors_total', 'Total tool errors', 1, labels);
    } else {
      this.incrementCounter('tool_success_total', 'Total tool successes', 1, labels);
    }
    this.recordHistogram(
      'tool_duration_ms',
      'Tool execution duration in ms',
      durationMs,
      LATENCY_BUCKETS_MS,
      labels,
    );
    // OTel GenAI semantic convention aliases
    this.incrementCounter('gen_ai.tool.call.count', 'OTel: tool call count', 1, labels);
    this.recordHistogram(
      'gen_ai.tool.call.duration',
      'OTel: tool call duration in ms',
      durationMs,
      LATENCY_BUCKETS_MS,
      labels,
    );
  }

  recordLLMCall(
    model: string,
    provider: string,
    tokens: number,
    durationMs: number,
    error?: string,
    tenantId?: string,
  ): void {
    const labels: MetricLabel[] = [
      { name: 'model', value: model },
      { name: 'provider', value: provider },
    ];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    if (error) {
      this.incrementCounter('llm_errors_total', 'Total LLM errors', 1, labels);
    } else {
      this.incrementCounter('llm_success_total', 'Total LLM successes', 1, labels);
    }
    this.incrementCounter('llm_tokens_total', 'Total LLM tokens consumed', tokens, labels);
    this.recordHistogram(
      'llm_duration_ms',
      'LLM call duration in ms',
      durationMs,
      LATENCY_BUCKETS_MS,
      labels,
    );
    this.recordHistogram(
      'llm_tokens_per_call',
      'Tokens per LLM call',
      tokens,
      TOKEN_BUCKETS,
      labels,
    );
    // OTel GenAI semantic convention aliases
    const otelLabels: MetricLabel[] = [
      { name: 'gen_ai.provider.name', value: provider },
      { name: 'gen_ai.request.model', value: model },
      { name: 'gen_ai.system', value: provider },
      { name: 'error', value: error ? 'true' : 'false' },
    ];
    if (tenantId) otelLabels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('gen_ai.client.request.count', 'OTel: LLM request count', 1, otelLabels);
    this.incrementCounter('gen_ai.client.token.usage', 'OTel: token usage', tokens, otelLabels);
    this.recordHistogram(
      'gen_ai.client.operation.duration',
      'OTel: LLM operation duration in ms',
      durationMs,
      LATENCY_BUCKETS_MS,
      otelLabels,
    );
  }

  recordError(errorClass: string, tenantId?: string): void {
    const labels: MetricLabel[] = [{ name: 'class', value: errorClass }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('errors_total', 'Total errors by class', 1, labels);
  }

  recordRunComplete(
    status: string,
    durationMs: number,
    toolCount: number,
    tenantId?: string,
  ): void {
    const labels: MetricLabel[] = [{ name: 'status', value: status }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('runs_total', 'Total runs by status', 1, labels);
    this.recordHistogram(
      'run_duration_ms',
      'Run duration in ms',
      durationMs,
      LATENCY_BUCKETS_MS,
      labels,
    );
    this.recordHistogram(
      'run_tool_count',
      'Tools per run',
      toolCount,
      [1, 5, 10, 20, 50, 100],
      labels,
    );
    // OTel GenAI workflow alias
    this.recordHistogram(
      'gen_ai.workflow.duration',
      'OTel: workflow duration in ms',
      durationMs,
      LATENCY_BUCKETS_MS,
      labels,
    );
  }

  /**
   * Tier 4.2: Record per-step latency with a step_type label. Used by the
   * agentRuntime step loop to track which pipeline phases are slow.
   *
   * stepType: 'planning' | 'tool_execution' | 'verification' | 'reflexion' |
   *           'compensation' | 'cascade_escalation'
   */
  recordStepLatency(stepType: string, durationMs: number, tenantId?: string): void {
    const labels: MetricLabel[] = [{ name: 'step_type', value: stepType }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.recordHistogram(
      'step_latency_ms',
      'Per-step latency in ms (Tier 4.2)',
      durationMs,
      LATENCY_BUCKETS_MS,
      labels,
    );
  }

  recordCostByFailureMode(mode: string, costUsd: number, tenantId?: string): void {
    const labels: MetricLabel[] = [{ name: 'failure_mode', value: mode }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter(
      'cost_by_failure_mode_usd',
      'Cost attributed to failure mode (USD)',
      costUsd,
      labels,
    );
  }

  // ── Export ──

  /** Export metrics as OpenMetrics (Prometheus-compatible) text format */
  exportOpenMetrics(): string {
    return this.formatMetrics('# HELP commander_metrics Built-in Commander metrics');
  }

  /** Export metrics with GenAI OpenTelemetry semantic convention names */
  exportOpenTelemetry(): string {
    return this.formatMetrics(
      '# HELP commander_metrics Built-in Commander metrics (OTel GenAI conventions)',
    );
  }

  /** Shared exporter: formats all counters, gauges, and histograms as OpenMetrics text */
  private formatMetrics(header: string): string {
    const lines: string[] = [];
    lines.push(header);

    for (const metric of this.counters.values()) {
      lines.push(`# TYPE ${metric.name} counter`);
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(this.formatMetricLine(metric.name, metric.total, metric.labels));
    }
    for (const metric of this.gauges.values()) {
      lines.push(`# TYPE ${metric.name} gauge`);
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(this.formatMetricLine(metric.name, metric.value, metric.labels));
    }
    for (const metric of this.histograms.values()) {
      lines.push(`# TYPE ${metric.name} histogram`);
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      let cumulativeTotal = 0;
      for (let i = 0; i < metric.buckets.length; i++) {
        cumulativeTotal += metric.counts[i];
        const bucketLabels = [...metric.labels, { name: 'le', value: String(metric.buckets[i]) }];
        lines.push(this.formatMetricLine(`${metric.name}_bucket`, cumulativeTotal, bucketLabels));
      }
      const infLabels = [...metric.labels, { name: 'le', value: '+Inf' }];
      lines.push(
        this.formatMetricLine(
          `${metric.name}_bucket`,
          cumulativeTotal + metric.counts[metric.buckets.length],
          infLabels,
        ),
      );
      lines.push(this.formatMetricLine(`${metric.name}_sum`, metric.sum, metric.labels));
      lines.push(this.formatMetricLine(`${metric.name}_count`, metric.count, metric.labels));
    }
    lines.push('# EOF');
    return lines.join('\n') + '\n';
  }

  /** Export metrics as JSON lines */
  exportJSONLines(): string {
    const lines: string[] = [];
    const now = Date.now();
    for (const metric of this.counters.values()) {
      lines.push(JSON.stringify({ timestamp: now, ...metric }));
    }
    for (const metric of this.gauges.values()) {
      lines.push(JSON.stringify({ timestamp: now, ...metric }));
    }
    for (const metric of this.histograms.values()) {
      lines.push(JSON.stringify({ timestamp: now, ...metric }));
    }
    return lines.join('\n');
  }

  /** Reset all metrics */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  /** Get all metric names for inspection */
  listMetricNames(): string[] {
    const names = new Set<string>();
    for (const k of this.counters.keys()) names.add(this.extractName(k));
    for (const k of this.gauges.keys()) names.add(this.extractName(k));
    for (const k of this.histograms.keys()) names.add(this.extractName(k));
    return Array.from(names).sort();
  }

  // ── Observability Gap Methods (P0–P2) ──

  recordCircuitTransition(from: string, to: string, provider: string, tenantId?: string): void {
    const labels: MetricLabel[] = [
      { name: 'from', value: from },
      { name: 'to', value: to },
      { name: 'provider', value: provider },
    ];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter(
      'circuit_transitions_total',
      'Circuit breaker state transitions',
      1,
      labels,
    );
  }

  recordCompensation(
    toolName: string,
    outcome: 'success' | 'failed' | 'exhausted',
    tenantId?: string,
  ): void {
    const labels: MetricLabel[] = [
      { name: 'tool', value: toolName },
      { name: 'outcome', value: outcome },
    ];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('compensation_total', 'Compensation action outcomes', 1, labels);
  }

  recordVerificationResult(
    confidence: number,
    passed: boolean,
    signalCount: number,
    signalSources: string[],
    tenantId?: string,
  ): void {
    const labels: MetricLabel[] = [
      { name: 'passed', value: passed ? 'true' : 'false' },
      { name: 'signal_count', value: signalCount.toString() },
    ];
    if (signalSources.length > 0)
      labels.push({ name: 'sources', value: signalSources.slice(0, 3).join(',') });
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter(
      'verification_results_total',
      'Verification pipeline outcomes',
      1,
      labels,
    );
    this.recordHistogram(
      'verification_confidence',
      'Verification confidence score',
      confidence,
      [0, 0.3, 0.5, 0.7, 0.9, 1.0],
      labels,
    );
  }

  recordCascadeEscalation(from: string, to: string, reason: string, tenantId?: string): void {
    const labels: MetricLabel[] = [
      { name: 'from', value: from },
      { name: 'to', value: to },
      { name: 'reason', value: reason },
    ];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('cascade_escalations_total', 'Model cascade escalations', 1, labels);
  }

  recordCascadeAttempt(attempt: number, modelId: string, passed: boolean, tenantId?: string): void {
    const labels: MetricLabel[] = [
      { name: 'attempt', value: String(attempt) },
      { name: 'model', value: modelId },
      { name: 'passed', value: String(passed) },
    ];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('cascade_attempts_total', 'Model cascade attempts', 1, labels);
  }

  recordCascadeCostSaved(costUsd: number, tenantId?: string): void {
    const labels: MetricLabel[] = [];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('cascade_cost_saved_usd', 'Cost saved via cascade', costUsd, labels);
  }

  /** Return a JSON-serialisable snapshot of all metrics (counters, gauges, histograms). */
  getMetricsSnapshot(): {
    counters: CounterMetric[];
    gauges: GaugeMetric[];
    histograms: HistogramMetric[];
  } {
    return {
      counters: Array.from(this.counters.values()),
      gauges: Array.from(this.gauges.values()),
      histograms: Array.from(this.histograms.values()),
    };
  }

  recordTopoChoice(topology: string, taskType: string, tenantId?: string): void {
    const labels: MetricLabel[] = [
      { name: 'topology', value: topology },
      { name: 'task_type', value: taskType },
    ];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('topology_choices_total', 'Orchestration topology selections', 1, labels);
  }

  recordSubAgentOutcome(
    agentId: string,
    status: 'success' | 'failed' | 'partial' | 'interrupted',
    depth: number,
    tenantId?: string,
  ): void {
    const labels: MetricLabel[] = [
      { name: 'agent', value: agentId },
      { name: 'status', value: status },
      { name: 'depth', value: depth.toString() },
    ];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('sub_agent_outcomes_total', 'Sub-agent execution outcomes', 1, labels);
  }

  recordHookFailure(hook: string, pluginName: string, tenantId?: string): void {
    const labels: MetricLabel[] = [
      { name: 'hook', value: hook },
      { name: 'plugin', value: pluginName },
    ];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('hook_failures_total', 'Plugin hook failures', 1, labels);
  }

  recordDLQEntry(category: string, tenantId?: string): void {
    const labels: MetricLabel[] = [{ name: 'category', value: category }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('dlq_entries_total', 'Dead letter queue entries by category', 1, labels);
  }

  recordIntentEscalation(
    fromStage: string,
    toStage: string,
    reason: string,
    tenantId?: string,
  ): void {
    const labels: MetricLabel[] = [
      { name: 'from', value: fromStage },
      { name: 'to', value: toStage },
      { name: 'reason', value: reason },
    ];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('intent_escalations_total', 'Intent stage escalations', 1, labels);
  }

  recordCheckpointFlush(reason: string, tenantId?: string): void {
    const labels: MetricLabel[] = [{ name: 'reason', value: reason }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('checkpoint_flushes_total', 'Checkpoint flushes by reason', 1, labels);
  }

  recordPartialRun(tenantId?: string): void {
    const labels: MetricLabel[] = [];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter(
      'partial_runs_total',
      'Runs that ended without terminal state',
      1,
      labels,
    );
  }

  recordSemanticCacheEvent(
    outcome: 'hit' | 'miss' | 'store' | 'embedding_error',
    costSavedUsd: number = 0,
    tenantId?: string,
  ): void {
    const labels: MetricLabel[] = [{ name: 'outcome', value: outcome }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter(
      'semantic_cache_events_total',
      'Semantic cache events by outcome',
      1,
      labels,
    );
    if (outcome === 'hit' && costSavedUsd > 0) {
      this.incrementCounter(
        'semantic_cache_cost_saved_usd_total',
        'Estimated cost saved by semantic cache hits (USD)',
        costSavedUsd,
        labels,
      );
    }
  }

  recordSingleFlightEvent(outcome: 'hit' | 'miss' | 'eviction', tenantId?: string): void {
    const labels: MetricLabel[] = [{ name: 'outcome', value: outcome }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter(
      'single_flight_events_total',
      'Single-flight request dedup events by outcome',
      1,
      labels,
    );
  }

  recordGeminiCacheEvent(outcome: 'hit' | 'create' | 'evict' | 'error', tenantId?: string): void {
    const labels: MetricLabel[] = [{ name: 'outcome', value: outcome }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter(
      'gemini_cache_events_total',
      'Google Gemini cachedContent events by outcome',
      1,
      labels,
    );
  }

  recordToolCacheEvent(outcome: 'hit' | 'miss' | 'store', tenantId?: string): void {
    const labels: MetricLabel[] = [{ name: 'outcome', value: outcome }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter(
      'tool_cache_events_total',
      'Tool result cache events by outcome',
      1,
      labels,
    );
  }

  // ── Experience System Health Metrics ──

  /** Record a skill extraction (successful or not) */
  recordSkillExtraction(
    outcome: 'extracted' | 'updated' | 'rejected',
    category?: string,
    tenantId?: string,
  ): void {
    const labels: MetricLabel[] = [{ name: 'outcome', value: outcome }];
    if (category) labels.push({ name: 'category', value: category });
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter(
      'skill_extraction_total',
      'Skill extraction events by outcome',
      1,
      labels,
    );
  }

  /** Record whether a skills recall was a hit or miss */
  recordSkillRecallHit(hit: boolean, tenantId?: string): void {
    const labels: MetricLabel[] = [{ name: 'outcome', value: hit ? 'hit' : 'miss' }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('skill_recall_total', 'Skill recall attempts (hit|miss)', 1, labels);
  }

  /** Track total experience count in MetaLearner */
  recordMetaLearnerExperienceCount(count: number, tenantId?: string): void {
    const labels: MetricLabel[] = [];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.setGauge(
      'meta_learner_experience_count',
      'Total experiences recorded by MetaLearner',
      count,
      labels,
    );
  }

  /** Track number of active regression alerts */
  recordRegressionActiveCount(count: number, tenantId?: string): void {
    const labels: MetricLabel[] = [];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.setGauge('regression_active_count', 'Active strategy regression alerts', count, labels);
  }

  /** Record prediction verification accuracy */
  recordPredictionVerdict(netImpact: 'positive' | 'negative', tenantId?: string): void {
    const labels: MetricLabel[] = [{ name: 'impact', value: netImpact }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter(
      'prediction_verdict_total',
      'MetaLearner prediction verdicts by impact',
      1,
      labels,
    );
  }

  private key(name: string, labels: MetricLabel[]): string {
    if (labels.length === 0) return name;
    const labelStr = labels.map((l) => `${l.name}=${l.value}`).join(',');
    return `${name}{${labelStr}}`;
  }

  private extractName(key: string): string {
    return key.split('{')[0];
  }

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
  recordPromptCacheSavings(
    tokens: { promptTokens: number; cacheReadTokens?: number },
    provider: string,
    model: string,
    tenantId?: string,
  ): void {
    const cachedTokens = tokens.cacheReadTokens ?? 0;
    if (cachedTokens <= 0) return;
    const inputTokens = tokens.promptTokens;
    const clamped = Math.min(cachedTokens, inputTokens);

    // Look up pricing to compute uncached equivalent and savings
    const pricing = getCostModel().getPricing(provider, model);
    const inputPer1k = pricing.inputPer1k;
    const cachedInputPer1k = pricing.cachedInputPer1k ?? 0;

    const uncachedEquivalent = (clamped / 1000) * inputPer1k;
    const cachedCost = (clamped / 1000) * cachedInputPer1k;
    const dollarsSaved = uncachedEquivalent - cachedCost;

    this.incrementCounter(
      'prompt_cache_tokens_read_total',
      'Tokens served from provider prompt cache',
      clamped,
      [
        { name: 'provider', value: provider },
        ...(tenantId ? [{ name: 'tenant', value: tenantId }] : []),
      ],
    );
    this.incrementCounter(
      'prompt_cache_dollars_uncached_equivalent_total',
      'What uncached tokens would have cost (USD)',
      uncachedEquivalent,
      [
        { name: 'provider', value: provider },
        ...(tenantId ? [{ name: 'tenant', value: tenantId }] : []),
      ],
    );
    this.incrementCounter(
      'prompt_cache_cost_saved_usd_total',
      'Estimated cost saved by provider prompt cache (USD)',
      dollarsSaved,
      [
        { name: 'provider', value: provider },
        ...(tenantId ? [{ name: 'tenant', value: tenantId }] : []),
      ],
    );
  }

  recordPromptPrefixCache(hit: boolean, tenantId?: string): void {
    const labels: MetricLabel[] = [{ name: 'outcome', value: hit ? 'hit' : 'miss' }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter(
      'prompt_prefix_cache_total',
      'System-prompt prefix cache events (hit|miss)',
      1,
      labels,
    );
  }

  /**
   * Track the SHA-256 hash of the most recent stable system-prompt
   * prefix as a numeric gauge. The hash is converted to a 32-bit integer
   * to avoid Prometheus label-cardinality explosion (full hex keys as
   * labels would be unbounded).
   */
  setPromptPrefixCacheKey(key: string, tenantId?: string): void {
    const labels: MetricLabel[] = tenantId ? [{ name: 'tenant', value: tenantId }] : [];
    this.setGauge(
      'prompt_prefix_cache_key',
      'Hash of the most recent stable system-prompt prefix',
      hashToGauge(key),
      labels,
    );
  }

  private formatMetricLine(name: string, value: number, labels: MetricLabel[]): string {
    if (labels.length === 0) return `${name} ${value}`;
    const labelStr = labels
      .map(
        (l) =>
          `${l.name}="${l.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
      )
      .join(',');
    return `${name}{${labelStr}} ${value}`;
  }

  private eventLoopLagTimer: ReturnType<typeof setInterval> | null = null;
  private eventLoopLagMs = 0;

  startEventLoopLagMonitor(intervalMs: number = 1000): void {
    if (this.eventLoopLagTimer) return;

    const measure = () => {
      const start = process.hrtime.bigint();
      setImmediate(() => {
        const lag = Number(process.hrtime.bigint() - start) / 1e6;
        this.eventLoopLagMs = lag;
        this.setGauge('event_loop_lag_ms', 'Event loop lag in milliseconds', lag);
        if (lag > 50) {
          this.recordHistogram(
            'event_loop_lag_high_ms',
            'Event loop lag spikes > 50ms',
            lag,
            [50, 100, 200, 500],
          );
        }
      });
    };

    measure();
    this.eventLoopLagTimer = setInterval(measure, intervalMs);
    if (this.eventLoopLagTimer.unref) this.eventLoopLagTimer.unref();
  }

  stopEventLoopLagMonitor(): void {
    if (this.eventLoopLagTimer) {
      clearInterval(this.eventLoopLagTimer);
      this.eventLoopLagTimer = null;
    }
  }

  getEventLoopLagMs(): number {
    return this.eventLoopLagMs;
  }

  recordCPUWorkerPoolStats(stats: {
    poolSize: number;
    availableWorkers: number;
    queueDepth: number;
    totalExecuted: number;
    totalQueued: number;
  }): void {
    this.setGauge('cpu_worker_pool_size', 'Total workers in pool', stats.poolSize);
    this.setGauge('cpu_worker_pool_available', 'Available idle workers', stats.availableWorkers);
    this.setGauge('cpu_worker_pool_queue_depth', 'Tasks waiting in queue', stats.queueDepth);
    this.incrementCounter(
      'cpu_worker_pool_tasks_executed_total',
      'Total tasks executed by worker pool',
      stats.totalExecuted,
    );
    this.incrementCounter(
      'cpu_worker_pool_tasks_queued_total',
      'Total tasks submitted to pool',
      stats.totalQueued,
    );
  }
}

import { getCostModel } from '../observability/costModel';
import { createTenantAwareSingleton } from './tenantAwareSingleton';

const metricsSingleton = createTenantAwareSingleton(() => new MetricsCollector());

/**
 * Map a 32-char hex cache key to a numeric gauge value. Hash bytes are
 * big-endian 16-bit words; the first 4 bytes produce a 32-bit integer
 * suitable for `setGauge`. Avoids the Prometheus convention of string
 * labels for cache keys (which would explode label cardinality).
 */
function hashToGauge(hexKey: string): number {
  if (hexKey.length < 8) return 0;
  const hi = parseInt(hexKey.slice(0, 4), 16);
  const lo = parseInt(hexKey.slice(4, 8), 16);
  return hi * 0x10000 + lo;
}

/** Get the global MetricsCollector (single-tenant) or tenant-scoped (multi-tenant). */
export function getMetricsCollector(): MetricsCollector {
  return metricsSingleton.get();
}

/** Reset the metrics collector singleton (for test isolation). */
export function resetMetricsCollector(): void {
  metricsSingleton.reset();
}
