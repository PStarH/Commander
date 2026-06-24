/**
 * Logging and Monitoring
 * Phase 2: 日志和监控
 *
 * 提供统一的日志记录、指标收集和监控接口
 */
const DEFAULT_CONFIG = {
    level: 'info',
    enableConsole: true,
    enableStorage: true,
    maxEntries: 10000,
    prettyPrint: true,
    logFormat: 'pretty',
};
const LEVEL_PRIORITY = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    critical: 4,
};
export class Logger {
    config;
    entries = [];
    listeners = [];
    constructor(config) {
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
    setLevel(level) {
        this.config.level = level;
    }
    /**
     * Get the current log level.
     */
    getLevel() {
        return this.config.level;
    }
    /**
     * Set the output format at runtime.
     */
    setLogFormat(format) {
        this.config.logFormat = format;
    }
    /**
     * Get the current output format.
     */
    getLogFormat() {
        return this.config.logFormat;
    }
    /**
     * Log debug message
     */
    debug(component, message, context) {
        this.log('debug', component, message, context);
    }
    info(component, message, context) {
        this.log('info', component, message, context);
    }
    warn(component, message, context) {
        this.log('warn', component, message, context);
    }
    error(component, message, error, context) {
        const errorInfo = error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
            }
            : undefined;
        this.log('error', component, message, context, errorInfo);
    }
    critical(component, message, context) {
        this.log('critical', component, message, context);
    }
    log(level, component, message, context, error) {
        // Check level threshold
        if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.config.level]) {
            return;
        }
        const entry = {
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
    consoleLog(entry) {
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
            }
            else if (entry.level === 'warn') {
                console.warn(jsonLine);
            }
            else {
                console.log(jsonLine);
            }
            return;
        }
        const icons = {
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
        }
        else if (entry.level === 'warn') {
            console.warn(output);
        }
        else if (this.config.prettyPrint) {
            console.log(output);
        }
        else {
            console.log(output);
        }
    }
    /**
     * Generate unique ID
     */
    generateId() {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    /**
     * Add log listener
     */
    static MAX_LISTENERS = 50;
    onLog(listener) {
        if (this.listeners.length >= Logger.MAX_LISTENERS) {
            this.listeners.shift();
        }
        this.listeners.push(listener);
    }
    /**
     * Remove log listener
     */
    offLog(listener) {
        this.listeners = this.listeners.filter((l) => l !== listener);
    }
    /**
     * Get recent logs
     */
    getRecent(limit = 100, level) {
        let entries = this.entries;
        if (level) {
            entries = entries.filter((e) => e.level === level);
        }
        return entries.slice(-limit);
    }
    /**
     * Get logs by component
     */
    getByComponent(component, limit) {
        const entries = this.entries.filter((e) => e.component === component);
        return limit ? entries.slice(-limit) : entries;
    }
    /**
     * Get error logs
     */
    getErrors(limit) {
        const entries = this.entries.filter((e) => e.level === 'error' || e.level === 'critical');
        return limit ? entries.slice(-limit) : entries;
    }
    /**
     * Clear logs
     */
    clear() {
        this.entries = [];
    }
    /**
     * Get statistics
     */
    getStats() {
        const byLevel = {
            debug: 0,
            info: 0,
            warn: 0,
            error: 0,
            critical: 0,
        };
        const byComponent = {};
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
const DEFAULT_METRICS_CONFIG = {
    retentionPeriod: 3600000, // 1 hour
    sampleInterval: 10000, // 10 seconds
};
export class MetricsCollector {
    config;
    metrics = new Map();
    listeners = [];
    cleanupTimer = null;
    constructor(config) {
        this.config = { ...DEFAULT_METRICS_CONFIG, ...config };
        // Cleanup old data periodically — run at half the retention period so stale
        // data is evicted promptly instead of sitting around for up to 2x retention.
        this.cleanupTimer = setInterval(() => this.cleanup(), this.config.retentionPeriod / 2);
        this.cleanupTimer.unref();
    }
    dispose() {
        if (this.cleanupTimer !== null) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        this.metrics.clear();
        this.listeners.length = 0;
    }
    /**
     * Increment counter
     */
    incrementCounter(name, value = 1, labels = {}) {
        this.record('counter', name, value, labels);
    }
    /**
     * Set gauge value
     */
    setGauge(name, value, labels = {}) {
        this.record('gauge', name, value, labels);
    }
    /**
     * Record histogram value
     */
    recordHistogram(name, value, labels = {}) {
        this.record('histogram', name, value, labels);
    }
    /**
     * Record timer value
     */
    recordTimer(name, durationMs, labels = {}) {
        this.record('timer', name, durationMs, labels);
    }
    /**
     * Core record method
     */
    record(type, name, value, labels) {
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
        const point = {
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
    get(name) {
        return this.metrics.get(name);
    }
    /**
     * Get all metrics
     */
    getAll() {
        return Array.from(this.metrics.values());
    }
    /**
     * Get latest value
     */
    getLatest(name) {
        const metric = this.metrics.get(name);
        return metric?.values[metric.values.length - 1];
    }
    /**
     * Get time series data
     */
    getTimeSeries(name, fromTimestamp, toTimestamp) {
        const metric = this.metrics.get(name);
        if (!metric)
            return [];
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
    getStats(name) {
        const metric = this.metrics.get(name);
        if (!metric || metric.values.length === 0)
            return null;
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
    percentile(sortedValues, p) {
        if (sortedValues.length === 0)
            return 0;
        const index = Math.ceil((p / 100) * sortedValues.length) - 1;
        return sortedValues[Math.max(0, index)];
    }
    /**
     * Add metric listener
     */
    onMetric(listener) {
        this.listeners.push(listener);
    }
    /**
     * Remove metric listener
     */
    offMetric(listener) {
        this.listeners = this.listeners.filter((l) => l !== listener);
    }
    /**
     * Cleanup old data
     */
    cleanup() {
        const cutoff = Date.now() - this.config.retentionPeriod;
        for (const metric of this.metrics.values()) {
            metric.values = metric.values.filter((p) => new Date(p.timestamp).getTime() > cutoff);
        }
    }
    /**
     * Clear all metrics
     */
    clear() {
        this.metrics.clear();
    }
}
// ========================================
// Timer Helper
// ========================================
export class Timer {
    startTime;
    labels;
    constructor(labels = {}) {
        this.startTime = Date.now();
        this.labels = labels;
    }
    /**
     * Stop timer and record
     */
    stop(metrics, name) {
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
export function getGlobalLogger() {
    return loggerSingleton.get();
}
export function setGlobalLogLevel(level) {
    const logger = getGlobalLogger();
    logger.setLevel(level);
}
export function setGlobalLogFormat(format) {
    const logger = getGlobalLogger();
    logger.setLogFormat(format);
}
export function getGlobalMetrics() {
    return metricsSingleton.get();
}
export function resetGlobalLogger() {
    loggerSingleton.reset();
}
export function resetGlobalMetrics() {
    metricsSingleton.reset();
}
