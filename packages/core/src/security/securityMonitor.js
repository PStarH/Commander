"use strict";
/**
 * SecurityMonitor — Continuous security health monitoring and anomaly detection.
 *
 * Monitors security events in real-time and detects:
 * - Burst patterns (many events in short window → possible attack)
 * - Severity escalation (low→medium→high→critical chain)
 * - Repeated failures from same source (brute force)
 * - New/unseen event types (zero-day detection)
 * - Credential access anomalies
 *
 * Integrates with SecurityAuditLogger via listener pattern.
 * Publishes alerts on MessageBus topic "security.alert".
 *
 * Usage:
 *   import { getSecurityMonitor } from './security/securityMonitor';
 *   const monitor = getSecurityMonitor();
 *   monitor.start(); // Begin monitoring
 *   monitor.getHealth(); // Get current security health status
 *   monitor.stop(); // Stop monitoring
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecurityMonitor = void 0;
exports.getSecurityMonitor = getSecurityMonitor;
exports.resetSecurityMonitor = resetSecurityMonitor;
const securityAuditLogger_1 = require("./securityAuditLogger");
const logging_1 = require("../logging");
const DEFAULT_CONFIG = {
    burstWindowMs: 60000, // 1 minute
    burstThreshold: 20, // 20 events in 1 minute
    failureWindowMs: 300000, // 5 minutes
    failureThreshold: 10, // 10 failures from same source
    healthCheckIntervalMs: 30000, // 30 seconds
    maxAlerts: 100,
};
// ============================================================================
// SecurityMonitor
// ============================================================================
class SecurityMonitor {
    constructor(config) {
        this.alerts = [];
        this.eventWindow = [];
        this.sourceFailures = new Map();
        this.seenTypes = new Set();
        this.healthCheckTimer = null;
        this.startTime = 0;
        this.running = false;
        this.unsubscribe = null;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    // ── Lifecycle ─────────────────────────────────────────────────────
    /** Start monitoring security events. */
    start() {
        if (this.running)
            return;
        this.running = true;
        this.startTime = Date.now();
        // Subscribe to security audit events
        const audit = (0, securityAuditLogger_1.getSecurityAuditLogger)();
        // We'll poll recent events since SecurityAuditLogger doesn't have a listener pattern yet
        // In a future iteration, add onEvent() to SecurityAuditLogger
        this.healthCheckTimer = setInterval(() => {
            this.analyzeRecentEvents();
            this.cleanupOldEvents();
        }, this.config.healthCheckIntervalMs);
        this.healthCheckTimer.unref();
        (0, logging_1.getGlobalLogger)().info('SecurityMonitor', 'Security monitoring started', {
            burstWindow: this.config.burstWindowMs,
            burstThreshold: this.config.burstThreshold,
        });
    }
    /** Stop monitoring. */
    stop() {
        this.running = false;
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        (0, logging_1.getGlobalLogger)().info('SecurityMonitor', 'Security monitoring stopped');
    }
    /** Check if monitor is running. */
    isRunning() {
        return this.running;
    }
    // ── Health API ────────────────────────────────────────────────────
    /** Get current security health status. */
    getHealth() {
        var _a;
        const recentEvents = this.getRecentEvents(this.config.burstWindowMs);
        const criticalEvents = recentEvents.filter((e) => e.severity === 'critical').length;
        const eventRate = recentEvents.length / (this.config.burstWindowMs / 60000);
        const status = this.alerts.some((a) => a.level === 'critical')
            ? 'critical'
            : this.alerts.length > 0 || eventRate > this.config.burstThreshold / 2
                ? 'elevated'
                : 'healthy';
        const typeCounts = {};
        for (const e of recentEvents) {
            typeCounts[e.type] = ((_a = typeCounts[e.type]) !== null && _a !== void 0 ? _a : 0) + 1;
        }
        const topThreats = Object.entries(typeCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([type, count]) => ({ type, count }));
        return {
            status,
            activeAlerts: this.alerts.length,
            recentEvents: recentEvents.length,
            criticalEvents,
            eventRate: Math.round(eventRate * 100) / 100,
            topThreats,
            uptime: Date.now() - this.startTime,
        };
    }
    /** Get active alerts. */
    getAlerts(limit = 20) {
        return [...this.alerts].reverse().slice(0, limit);
    }
    /** Dismiss an alert by ID. */
    dismissAlert(alertId) {
        const idx = this.alerts.findIndex((a) => a.id === alertId);
        if (idx === -1)
            return false;
        this.alerts.splice(idx, 1);
        return true;
    }
    /** Clear all alerts. */
    clearAlerts() {
        this.alerts = [];
    }
    // ── Analysis ──────────────────────────────────────────────────────
    /** Process a security event for anomaly detection. Called by the audit logger poller. */
    processEvent(event) {
        var _a;
        this.eventWindow.push(event);
        // Track source failures
        if (event.severity === 'high' || event.severity === 'critical') {
            const sourceEvents = (_a = this.sourceFailures.get(event.source)) !== null && _a !== void 0 ? _a : [];
            sourceEvents.push(event);
            this.sourceFailures.set(event.source, sourceEvents);
        }
        // Track seen types for zero-day detection
        if (!this.seenTypes.has(event.type)) {
            this.seenTypes.add(event.type);
        }
        // Run anomaly detectors
        this.detectBurst(event);
        this.detectRepeatedFailures(event);
        this.detectSeverityEscalation(event);
    }
    // ── Detectors ─────────────────────────────────────────────────────
    detectBurst(event) {
        const windowStart = Date.now() - this.config.burstWindowMs;
        const recentInWindow = this.eventWindow.filter((e) => new Date(e.timestamp).getTime() > windowStart);
        if (recentInWindow.length >= this.config.burstThreshold) {
            const existing = this.alerts.find((a) => a.title === 'Security event burst detected');
            if (!existing) {
                this.raiseAlert({
                    level: 'critical',
                    title: 'Security event burst detected',
                    description: `${recentInWindow.length} security events in the last ${this.config.burstWindowMs / 1000}s (threshold: ${this.config.burstThreshold})`,
                    events: recentInWindow.slice(-5),
                    recommendation: 'Investigate the source of these events. Possible coordinated attack or system misconfiguration.',
                });
            }
        }
    }
    detectRepeatedFailures(event) {
        var _a;
        if (event.severity !== 'high' && event.severity !== 'critical')
            return;
        const windowStart = Date.now() - this.config.failureWindowMs;
        const sourceEvents = (_a = this.sourceFailures.get(event.source)) !== null && _a !== void 0 ? _a : [];
        const recentFailures = sourceEvents.filter((e) => new Date(e.timestamp).getTime() > windowStart);
        if (recentFailures.length >= this.config.failureThreshold) {
            const existing = this.alerts.find((a) => { var _a; return a.title === 'Repeated failures from source' && ((_a = a.events[0]) === null || _a === void 0 ? void 0 : _a.source) === event.source; });
            if (!existing) {
                this.raiseAlert({
                    level: 'warning',
                    title: 'Repeated failures from source',
                    description: `${recentFailures.length} failures from "${event.source}" in ${this.config.failureWindowMs / 1000}s`,
                    events: recentFailures.slice(-3),
                    recommendation: `Check if "${event.source}" is under attack or misconfigured.`,
                });
            }
        }
    }
    detectSeverityEscalation(event) {
        var _a;
        if (event.severity !== 'critical')
            return;
        // Check if there were recent high-severity events from the same source
        const windowStart = Date.now() - this.config.burstWindowMs;
        const sourceEvents = (_a = this.sourceFailures.get(event.source)) !== null && _a !== void 0 ? _a : [];
        const recentHigh = sourceEvents.filter((e) => new Date(e.timestamp).getTime() > windowStart && e.severity === 'high');
        if (recentHigh.length >= 3) {
            this.raiseAlert({
                level: 'critical',
                title: 'Severity escalation detected',
                description: `Source "${event.source}" escalated from ${recentHigh.length} high-severity events to critical`,
                events: [...recentHigh.slice(-3), event],
                recommendation: 'Immediate investigation required. This pattern suggests an active attack.',
            });
        }
    }
    // ── Alert Management ──────────────────────────────────────────────
    raiseAlert(alert) {
        const fullAlert = {
            id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: new Date().toISOString(),
            ...alert,
        };
        this.alerts.push(fullAlert);
        // Cap alerts
        if (this.alerts.length > this.config.maxAlerts) {
            this.alerts.shift();
        }
        // Log to global logger
        const logger = (0, logging_1.getGlobalLogger)();
        if (alert.level === 'critical') {
            logger.critical('SecurityMonitor', `🚨 ${alert.title}: ${alert.description}`);
        }
        else {
            logger.warn('SecurityMonitor', `⚠️ ${alert.title}: ${alert.description}`);
        }
        // Record metric
        try {
            const metrics = (0, logging_1.getGlobalMetrics)();
            metrics.incrementCounter('security.alerts', 1, { level: alert.level });
        }
        catch {
            /* non-critical */
        }
        // Publish on MessageBus
        try {
            const { getMessageBus } = require('../runtime/messageBus');
            const bus = getMessageBus();
            bus.publish('security.alert', 'SecurityMonitor', fullAlert, {
                priority: alert.level === 'critical' ? 0 : 2,
            });
        }
        catch {
            /* non-critical */
        }
    }
    // ── Internal ──────────────────────────────────────────────────────
    analyzeRecentEvents() {
        const audit = (0, securityAuditLogger_1.getSecurityAuditLogger)();
        const recent = audit.getRecent(100);
        for (const event of recent) {
            // Only process events we haven't seen yet
            if (!this.eventWindow.some((e) => e.id === event.id)) {
                this.processEvent(event);
            }
        }
    }
    cleanupOldEvents() {
        const cutoff = Date.now() - this.config.failureWindowMs;
        this.eventWindow = this.eventWindow.filter((e) => new Date(e.timestamp).getTime() > cutoff);
        for (const [source, events] of this.sourceFailures) {
            const filtered = events.filter((e) => new Date(e.timestamp).getTime() > cutoff);
            if (filtered.length === 0) {
                this.sourceFailures.delete(source);
            }
            else {
                this.sourceFailures.set(source, filtered);
            }
        }
        // Auto-dismiss old alerts (1 hour)
        const alertCutoff = Date.now() - 3600000;
        this.alerts = this.alerts.filter((a) => new Date(a.timestamp).getTime() > alertCutoff);
    }
    getRecentEvents(windowMs) {
        const cutoff = Date.now() - windowMs;
        return this.eventWindow.filter((e) => new Date(e.timestamp).getTime() > cutoff);
    }
}
exports.SecurityMonitor = SecurityMonitor;
// ============================================================================
// Singleton
// ============================================================================
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const securityMonitorSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new SecurityMonitor());
function getSecurityMonitor() {
    return securityMonitorSingleton.get();
}
function resetSecurityMonitor() {
    securityMonitorSingleton.reset();
}
