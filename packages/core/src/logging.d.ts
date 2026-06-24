/**
 * Logging and Monitoring
 * Phase 2: 日志和监控
 *
 * 提供统一的日志记录、指标收集和监控接口
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';
export interface LogEntry {
    id: string;
    timestamp: string;
    level: LogLevel;
    component: string;
    message: string;
    context?: Record<string, unknown>;
    duration?: number;
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
export declare class Logger {
    private config;
    private entries;
    private listeners;
    constructor(config?: Partial<LoggerConfig>);
    /**
     * Set the log level at runtime.
     */
    setLevel(level: LogLevel): void;
    /**
     * Get the current log level.
     */
    getLevel(): LogLevel;
    /**
     * Set the output format at runtime.
     */
    setLogFormat(format: LogFormat): void;
    /**
     * Get the current output format.
     */
    getLogFormat(): LogFormat;
    /**
     * Log debug message
     */
    debug(component: string, message: string, context?: Record<string, unknown>): void;
    info(component: string, message: string, context?: Record<string, unknown>): void;
    warn(component: string, message: string, context?: Record<string, unknown>): void;
    error(component: string, message: string, error?: Error, context?: Record<string, unknown>): void;
    critical(component: string, message: string, context?: Record<string, unknown>): void;
    private log;
    /**
     * Console output with formatting
     */
    private consoleLog;
    /**
     * Generate unique ID
     */
    private generateId;
    /**
     * Add log listener
     */
    private static readonly MAX_LISTENERS;
    onLog(listener: (entry: LogEntry) => void): void;
    /**
     * Remove log listener
     */
    offLog(listener: (entry: LogEntry) => void): void;
    /**
     * Get recent logs
     */
    getRecent(limit?: number, level?: LogLevel): LogEntry[];
    /**
     * Get logs by component
     */
    getByComponent(component: string, limit?: number): LogEntry[];
    /**
     * Get error logs
     */
    getErrors(limit?: number): LogEntry[];
    /**
     * Clear logs
     */
    clear(): void;
    /**
     * Get statistics
     */
    getStats(): {
        total: number;
        byLevel: Record<LogLevel, number>;
        byComponent: Record<string, number>;
        errorRate: number;
    };
}
export interface MetricsConfig {
    retentionPeriod: number;
    sampleInterval: number;
}
export declare class MetricsCollector {
    private config;
    private metrics;
    private listeners;
    private cleanupTimer;
    constructor(config?: Partial<MetricsConfig>);
    dispose(): void;
    /**
     * Increment counter
     */
    incrementCounter(name: string, value?: number, labels?: Record<string, string>): void;
    /**
     * Set gauge value
     */
    setGauge(name: string, value: number, labels?: Record<string, string>): void;
    /**
     * Record histogram value
     */
    recordHistogram(name: string, value: number, labels?: Record<string, string>): void;
    /**
     * Record timer value
     */
    recordTimer(name: string, durationMs: number, labels?: Record<string, string>): void;
    /**
     * Core record method
     */
    private record;
    /**
     * Get metric
     */
    get(name: string): Metric | undefined;
    /**
     * Get all metrics
     */
    getAll(): Metric[];
    /**
     * Get latest value
     */
    getLatest(name: string): MetricPoint | undefined;
    /**
     * Get time series data
     */
    getTimeSeries(name: string, fromTimestamp?: string, toTimestamp?: string): MetricPoint[];
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
    } | null;
    /**
     * Calculate percentile
     */
    private percentile;
    /**
     * Add metric listener
     */
    onMetric(listener: (name: string, point: MetricPoint) => void): void;
    /**
     * Remove metric listener
     */
    offMetric(listener: (name: string, point: MetricPoint) => void): void;
    /**
     * Cleanup old data
     */
    private cleanup;
    /**
     * Clear all metrics
     */
    clear(): void;
}
export declare class Timer {
    private startTime;
    private labels;
    constructor(labels?: Record<string, string>);
    /**
     * Stop timer and record
     */
    stop(metrics: MetricsCollector, name: string): number;
}
export declare function getGlobalLogger(): Logger;
export declare function setGlobalLogLevel(level: LogLevel): void;
export declare function setGlobalLogFormat(format: LogFormat): void;
export declare function getGlobalMetrics(): MetricsCollector;
export declare function resetGlobalLogger(): void;
export declare function resetGlobalMetrics(): void;
