/**
 * Logging and Monitoring
 * Phase 2: 日志和监控
 *
 * 提供统一的日志记录、指标收集和监控接口
 */

// ========================================
// Log Types
// ========================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  context?: Record<string, unknown>;
  duration?: number; // Operation duration in ms
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface MetricPoint {
  timestamp: string;
  value: number;
  labels: Record<string, string>;
}

export interface Metric {
  name: string;
  type: 'counter' | 'gauge' | 'histogram' | 'timer';
  description: string;
  unit?: string;
  values: MetricPoint[];
}

// ========================================
// Logger
// ========================================

export type LogFormat = 'pretty' | 'json';

export interface LoggerConfig {
  level: LogLevel;
  enableConsole: boolean;
  enableStorage: boolean;
  maxEntries: number;
  prettyPrint: boolean;
  /** Output format — 'pretty' (default) or 'json' (newline-delimited JSON).
   *  When LOGFORMAT=json is set in the environment, the global logger
   *  automatically switches to JSON output. */
  logFormat: LogFormat;
}

const DEFAULT_CONFIG: LoggerConfig = {
  level: 'info',
  enableConsole: true,
  enableStorage: true,
  maxEntries: 10000,
  prettyPrint: true,
  logFormat: 'pretty',
};

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  critical: 4,
};

export class Logger {
  private config: LoggerConfig;
  private entries: LogEntry[] = [];
  private listeners: Array<(entry: LogEntry) => void> = [];

  constructor(config?: Partial<LoggerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Auto-detect LOGFORMAT from environment if not explicitly configured
    if (config?.logFormat === undefined) {
      const envFormat = process.env.LOGFORMAT?.toLowerCase();
      if (envFormat === 'json') {
        this.config.logFormat = 'json';
      }
    }
  }

  /**
   * Set the log level at runtime.
   */
  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  /**
   * Get the current log level.
   */
  getLevel(): LogLevel {
    return this.config.level;
  }

  /**
   * Set the output format at runtime.
   */
  setLogFormat(format: LogFormat): void {
    this.config.logFormat = format;
  }

  /**
   * Get the current output format.
   */
  getLogFormat(): LogFormat {
    return this.config.logFormat;
  }

  /**
   * Log debug message
   */
  debug(component: string, message: string, context?: Record<string, unknown>): void {
    this.log('debug', component, message, context);
  }

  info(component: string, message: string, context?: Record<string, unknown>): void {
    this.log('info', component, message, context);
  }

  warn(component: string, message: string, context?: Record<string, unknown>): void {
    this.log('warn', component, message, context);
  }

  error(
    component: string,
    message: string,
    error?: Error,
    context?: Record<string, unknown>,
  ): void {
    const errorInfo = error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      : undefined;
    this.log('error', component, message, context, errorInfo);
  }

  critical(component: string, message: string, context?: Record<string, unknown>): void {
    this.log('critical', component, message, context);
  }

  private log(
    level: LogLevel,
    component: string,
    message: string,
    context?: Record<string, unknown>,
    error?: LogEntry['error'],
  ): void {
    // Check level threshold
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.config.level]) {
      return;
    }

    const entry: LogEntry = {
      id: this.generateId(),
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      context,
      error,
    };

    // Store entry
    if (this.config.enableStorage) {
      this.entries.push(entry);
      if (this.entries.length > this.config.maxEntries) {
        this.entries.shift();
      }
    }

    // Console output
    if (this.config.enableConsole) {
      this.consoleLog(entry);
    }

    // Notify listeners
    this.listeners.forEach((listener) => listener(entry));
  }

  /**
   * Console output with formatting
   */
  private consoleLog(entry: LogEntry): void {
    if (this.config.logFormat === 'json') {
      const jsonLine = JSON.stringify({
        timestamp: entry.timestamp,
        level: entry.level,
        component: entry.component,
        message: entry.message,
        context: entry.context ?? undefined,
        error: entry.error ?? undefined,
      });
      if (entry.level === 'error' || entry.level === 'critical') {
        console.error(jsonLine);
      } else if (entry.level === 'warn') {
        console.warn(jsonLine);
      } else {
        console.log(jsonLine);
      }
      return;
    }

    const icons: Record<LogLevel, string> = {
      debug: '🔍',
      info: 'ℹ️ ',
      warn: '⚠️ ',
      error: '❌',
      critical: '🚨',
    };

    const levelName = entry.level.toUpperCase().padEnd(8);
    const component = entry.component.padEnd(20);
    const icon = icons[entry.level];

    let output = `${icon} [${levelName}] [${component}] ${entry.message}`;

    if (entry.context) {
      output += ` ${JSON.stringify(entry.context)}`;
    }

    if (entry.error) {
      output += `\n   Error: ${entry.error.message}`;
    }

    if (entry.level === 'error' || entry.level === 'critical') {
      console.error(output);
    } else if (entry.level === 'warn') {
      console.warn(output);
    } else if (this.config.prettyPrint) {
      console.log(output);
    } else {
      console.log(output);
    }
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Add log listener
   */
  private static readonly MAX_LISTENERS = 50;
  onLog(listener: (entry: LogEntry) => void): void {
    if (this.listeners.length >= Logger.MAX_LISTENERS) {
      this.listeners.shift();
    }
    this.listeners.push(listener);
  }

  /**
   * Remove log listener
   */
  offLog(listener: (entry: LogEntry) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  /**
   * Get recent logs
   */
  getRecent(limit: number = 100, level?: LogLevel): LogEntry[] {
    let entries = this.entries;

    if (level) {
      entries = entries.filter((e) => e.level === level);
    }

    return entries.slice(-limit);
  }

  /**
   * Get logs by component
   */
  getByComponent(component: string, limit?: number): LogEntry[] {
    const entries = this.entries.filter((e) => e.component === component);
    return limit ? entries.slice(-limit) : entries;
  }

  /**
   * Get error logs
   */
  getErrors(limit?: number): LogEntry[] {
    const entries = this.entries.filter((e) => e.level === 'error' || e.level === 'critical');
    return limit ? entries.slice(-limit) : entries;
  }

  /**
   * Clear logs
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    byLevel: Record<LogLevel, number>;
    byComponent: Record<string, number>;
    errorRate: number;
  } {
    const byLevel: Record<LogLevel, number> = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
      critical: 0,
    };
    const byComponent: Record<string, number> = {};
    let errorCount = 0;

    for (const entry of this.entries) {
      byLevel[entry.level]++;
      byComponent[entry.component] = (byComponent[entry.component] || 0) + 1;
      if (entry.level === 'error' || entry.level === 'critical') {
        errorCount++;
      }
    }

    return {
      total: this.entries.length,
      byLevel,
      byComponent,
      errorRate: this.entries.length > 0 ? errorCount / this.entries.length : 0,
    };
  }
}

// ========================================
// Metrics Collector
// ========================================

export interface MetricsConfig {
  retentionPeriod: number; // ms
  sampleInterval: number; // ms
}

const DEFAULT_METRICS_CONFIG: MetricsConfig = {
  retentionPeriod: 3600000, // 1 hour
  sampleInterval: 10000, // 10 seconds
};

export class MetricsCollector {
  private config: MetricsConfig;
  private metrics: Map<string, Metric> = new Map();
  private listeners: Array<(name: string, point: MetricPoint) => void> = [];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private runtimeCollector: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(config?: Partial<MetricsConfig>) {
    this.config = { ...DEFAULT_METRICS_CONFIG, ...config };

    // P1: Try to connect to the runtime MetricsCollector for unified metrics.
    // If it's not available (e.g., during early init or tests), fall back to
    // the in-memory time-series store. This preserves backward compatibility
    // while unifying the two collectors.
    try {
      const { getMetricsCollector } = require('./runtime/metricsCollector');
      this.runtimeCollector = getMetricsCollector();
    } catch {
      // Runtime collector not available — use in-memory fallback
    }

    // Cleanup old data periodically — run at half the retention period so stale
    // data is evicted promptly instead of sitting around for up to 2x retention.
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.retentionPeriod / 2);
    this.cleanupTimer.unref();
  }

  dispose(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.metrics.clear();
    this.listeners.length = 0;
  }

  /**
   * Increment counter — delegates to runtime MetricsCollector when available.
   */
  incrementCounter(name: string, value: number = 1, labels: Record<string, string> = {}): void {
    // P1: Delegate to runtime collector (unified path)
    if (this.runtimeCollector) {
      const labelArray = Object.entries(labels).map(([k, v]) => ({ name: k, value: v }));
      this.runtimeCollector.incrementCounter(name, name, value, labelArray);
    }
    // Also record in-memory time-series for backward-compatible query APIs
    this.record('counter', name, value, labels);
  }

  /**
   * Set gauge value — delegates to runtime MetricsCollector when available.
   */
  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    if (this.runtimeCollector) {
      const labelArray = Object.entries(labels).map(([k, v]) => ({ name: k, value: v }));
      this.runtimeCollector.setGauge(name, name, value, labelArray);
    }
    this.record('gauge', name, value, labels);
  }

  /**
   * Record histogram value — delegates to runtime MetricsCollector when available.
   */
  recordHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    if (this.runtimeCollector) {
      const labelArray = Object.entries(labels).map(([k, v]) => ({ name: k, value: v }));
      this.runtimeCollector.recordHistogram(name, name, value, undefined, labelArray);
    }
    this.record('histogram', name, value, labels);
  }

  /**
   * Record timer value — delegates to runtime MetricsCollector when available.
   */
  recordTimer(name: string, durationMs: number, labels: Record<string, string> = {}): void {
    if (this.runtimeCollector) {
      const labelArray = Object.entries(labels).map(([k, v]) => ({ name: k, value: v }));
      this.runtimeCollector.recordHistogram(name, name, durationMs, undefined, labelArray);
    }
    this.record('timer', name, durationMs, labels);
  }

  /**
   * Core record method
   */
  private record(
    type: Metric['type'],
    name: string,
    value: number,
    labels: Record<string, string>,
  ): void {
    let metric = this.metrics.get(name);

    if (!metric) {
      metric = {
        name,
        type,
        description: '',
        values: [],
        unit: type === 'timer' || type === 'histogram' ? 'ms' : 'count',
      };
      this.metrics.set(name, metric);
    }

    const point: MetricPoint = {
      timestamp: new Date().toISOString(),
      value,
      labels,
    };

    metric.values.push(point);
    // Cap per-metric values to prevent unbounded growth within retention window
    if (metric.values.length > 5000) {
      metric.values = metric.values.slice(-3000);
    }

    // Notify listeners
    this.listeners.forEach((listener) => listener(name, point));
  }

  /**
   * Get metric
   */
  get(name: string): Metric | undefined {
    return this.metrics.get(name);
  }

  /**
   * Get all metrics
   */
  getAll(): Metric[] {
    return Array.from(this.metrics.values());
  }

  /**
   * Get latest value
   */
  getLatest(name: string): MetricPoint | undefined {
    const metric = this.metrics.get(name);
    return metric?.values[metric.values.length - 1];
  }

  /**
   * Get time series data
   */
  getTimeSeries(name: string, fromTimestamp?: string, toTimestamp?: string): MetricPoint[] {
    const metric = this.metrics.get(name);
    if (!metric) return [];

    let points = metric.values;

    if (fromTimestamp) {
      const from = new Date(fromTimestamp).getTime();
      points = points.filter((p) => new Date(p.timestamp).getTime() >= from);
    }

    if (toTimestamp) {
      const to = new Date(toTimestamp).getTime();
      points = points.filter((p) => new Date(p.timestamp).getTime() <= to);
    }

    return points;
  }

  /**
   * Calculate statistics
   */
  getStats(name: string): {
    count: number;
    sum: number;
    avg: number;
    min: number;
    max: number;
    latest: number;
    p50?: number;
    p95?: number;
    p99?: number;
  } | null {
    const metric = this.metrics.get(name);
    if (!metric || metric.values.length === 0) return null;

    const values = metric.values.map((p) => p.value).sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    const count = values.length;

    return {
      count,
      sum,
      avg: sum / count,
      min: values[0],
      max: values[values.length - 1],
      latest: values[values.length - 1],
      p50: this.percentile(values, 50),
      p95: this.percentile(values, 95),
      p99: this.percentile(values, 99),
    };
  }

  /**
   * Calculate percentile
   */
  private percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    const index = Math.ceil((p / 100) * sortedValues.length) - 1;
    return sortedValues[Math.max(0, index)];
  }

  /**
   * Add metric listener
   */
  onMetric(listener: (name: string, point: MetricPoint) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Remove metric listener
   */
  offMetric(listener: (name: string, point: MetricPoint) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  /**
   * Cleanup old data
   */
  private cleanup(): void {
    const cutoff = Date.now() - this.config.retentionPeriod;

    for (const metric of this.metrics.values()) {
      metric.values = metric.values.filter((p) => new Date(p.timestamp).getTime() > cutoff);
    }
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics.clear();
  }
}

// ========================================
// Timer Helper
// ========================================

export class Timer {
  private startTime: number;
  private labels: Record<string, string>;

  constructor(labels: Record<string, string> = {}) {
    this.startTime = Date.now();
    this.labels = labels;
  }

  /**
   * Stop timer and record
   */
  stop(metrics: MetricsCollector, name: string): number {
    const duration = Date.now() - this.startTime;
    metrics.recordTimer(name, duration, this.labels);
    return duration;
  }
}

// ========================================
// Global Instances
// ========================================

import { createTenantAwareSingleton } from './runtime/tenantAwareSingleton';

const loggerSingleton = createTenantAwareSingleton(() => new Logger());
const metricsSingleton = createTenantAwareSingleton(() => new MetricsCollector());

export function getGlobalLogger(): Logger {
  return loggerSingleton.get();
}

export function setGlobalLogLevel(level: LogLevel): void {
  const logger = getGlobalLogger();
  logger.setLevel(level);
}

export function setGlobalLogFormat(format: LogFormat): void {
  const logger = getGlobalLogger();
  logger.setLogFormat(format);
}

export function getGlobalMetrics(): MetricsCollector {
  return metricsSingleton.get();
}

export function resetGlobalLogger(): void {
  loggerSingleton.reset();
}

export function resetGlobalMetrics(): void {
  metricsSingleton.reset();
}
