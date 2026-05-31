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
    return this.counters.get(this.key(name, labels))?.total ?? 0;
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

  recordHistogram(name: string, help: string, value: number, buckets: number[], labels: MetricLabel[] = []): void {
    const key = this.key(name, labels);
    let metric = this.histograms.get(key);
    if (!metric) {
      this.enforceCap(this.histograms);
      metric = {
        type: 'histogram', name, help, buckets,
        counts: new Array(buckets.length + 1).fill(0),
        sum: 0, count: 0, labels,
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
    this.recordHistogram('tool_duration_ms', 'Tool execution duration in ms', durationMs, LATENCY_BUCKETS_MS, labels);
  }

  recordLLMCall(model: string, provider: string, tokens: number, durationMs: number, error?: string, tenantId?: string): void {
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
    this.recordHistogram('llm_duration_ms', 'LLM call duration in ms', durationMs, LATENCY_BUCKETS_MS, labels);
    this.recordHistogram('llm_tokens_per_call', 'Tokens per LLM call', tokens, TOKEN_BUCKETS, labels);
  }

  recordError(errorClass: string, tenantId?: string): void {
    const labels: MetricLabel[] = [{ name: 'class', value: errorClass }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('errors_total', 'Total errors by class', 1, labels);
  }

  recordRunComplete(status: string, durationMs: number, toolCount: number, tenantId?: string): void {
    const labels: MetricLabel[] = [{ name: 'status', value: status }];
    if (tenantId) labels.push({ name: 'tenant', value: tenantId });
    this.incrementCounter('runs_total', 'Total runs by status', 1, labels);
    this.recordHistogram('run_duration_ms', 'Run duration in ms', durationMs, LATENCY_BUCKETS_MS, labels);
    this.recordHistogram('run_tool_count', 'Tools per run', toolCount, [1, 5, 10, 20, 50, 100], labels);
  }

  // ── Export ──

  /** Export metrics as OpenMetrics (Prometheus-compatible) text format */
  exportOpenMetrics(): string {
    const lines: string[] = [];
    // Help header
    lines.push('# HELP commander_metrics Built-in Commander metrics');

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
      // Prometheus buckets are cumulative — each bucket includes all lower buckets
      let cumulativeTotal = 0;
      for (let i = 0; i < metric.buckets.length; i++) {
        cumulativeTotal += metric.counts[i];
        const bucketLabels = [...metric.labels, { name: 'le', value: String(metric.buckets[i]) }];
        lines.push(this.formatMetricLine(`${metric.name}_bucket`, cumulativeTotal, bucketLabels));
      }
      const infLabels = [...metric.labels, { name: 'le', value: '+Inf' }];
      lines.push(this.formatMetricLine(`${metric.name}_bucket`, cumulativeTotal + metric.counts[metric.buckets.length], infLabels));
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

  private key(name: string, labels: MetricLabel[]): string {
    if (labels.length === 0) return name;
    const labelStr = labels.map(l => `${l.name}=${l.value}`).join(',');
    return `${name}{${labelStr}}`;
  }

  private extractName(key: string): string {
    return key.split('{')[0];
  }

  private formatMetricLine(name: string, value: number, labels: MetricLabel[]): string {
    if (labels.length === 0) return `${name} ${value}`;
    const labelStr = labels.map(l => `${l.name}="${l.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`).join(',');
    return `${name}{${labelStr}} ${value}`;
  }
}

import { createTenantAwareSingleton } from './tenantAwareSingleton';

const metricsSingleton = createTenantAwareSingleton(() => new MetricsCollector());

/** Get the global MetricsCollector (single-tenant) or tenant-scoped (multi-tenant). */
export function getMetricsCollector(): MetricsCollector {
  return metricsSingleton.get();
}

/** Reset the metrics collector singleton (for test isolation). */
export function resetMetricsCollector(): void {
  metricsSingleton.reset();
}
