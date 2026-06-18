"use strict";
/**
 * SecurityAuditLogger — Centralized security event audit trail.
 *
 * Records all security-relevant events across Commander's defense layers:
 * - Sandbox violations (escape attempts, policy breaches)
 * - Authentication failures (bad keys, rate limits, disabled users)
 * - Approval denials (user/system rejections)
 * - Content threat detections (prompt injection, hidden HTML, etc.)
 * - ExecPolicy violations (forbidden commands, unknown commands)
 * - Credential access (reads, masks, rotations)
 * - Input validation failures (malformed tool calls, path traversal)
 *
 * Design:
 * - Append-only JSON Lines (.ndjson) persisted under .commander_security/
 * - In-memory ring buffer for fast querying (last 10000 events)
 * - Metrics integration via MetricsCollector (counters per event type)
 * - MessageBus integration for real-time security alerting
 * - Severity-based filtering and querying
 *
 * Usage:
 *   import { getSecurityAuditLogger } from './security/securityAuditLogger';
 *   const audit = getSecurityAuditLogger();
 *   audit.logEvent({
 *     type: 'sandbox_violation',
 *     severity: 'critical',
 *     source: 'DockerExecBackend',
 *     message: 'Container escape attempt detected',
 *     details: { container: 'untrusted', command: '...' },
 *   });
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecurityAuditLogger = void 0;
exports.getSecurityAuditLogger = getSecurityAuditLogger;
exports.resetSecurityAuditLogger = resetSecurityAuditLogger;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const logging_1 = require("../logging");
// ============================================================================
// SecurityAuditLogger
// ============================================================================
class SecurityAuditLogger {
    constructor(options) {
        var _a, _b, _c, _d;
        this.events = [];
        this.currentFileIndex = 0;
        this.maxEvents = (_a = options === null || options === void 0 ? void 0 : options.maxEvents) !== null && _a !== void 0 ? _a : 10000;
        this.persistDir = (_b = options === null || options === void 0 ? void 0 : options.persistDir) !== null && _b !== void 0 ? _b : path.join(process.cwd(), '.commander_security');
        this.maxFileSize = (_c = options === null || options === void 0 ? void 0 : options.maxFileSize) !== null && _c !== void 0 ? _c : 50 * 1024 * 1024; // 50MB
        this.maxFiles = (_d = options === null || options === void 0 ? void 0 : options.maxFiles) !== null && _d !== void 0 ? _d : 5;
        this.ensurePersistDir();
    }
    // ── Core API ──────────────────────────────────────────────────────
    queryEvents(q = {}) {
        var _a, _b, _c, _d;
        const limit = Math.max(1, Math.min((_a = q.limit) !== null && _a !== void 0 ? _a : 100, 5000));
        const since = (_b = q.since) !== null && _b !== void 0 ? _b : 0;
        const out = [];
        for (let i = this.events.length - 1; i >= 0; i--) {
            const e = this.events[i];
            if (!e)
                continue;
            if (Date.parse(e.timestamp) < since)
                continue;
            if (q.type && e.type !== q.type)
                continue;
            if (q.severity && e.severity !== q.severity)
                continue;
            if (q.tenantId && ((_c = e.context) === null || _c === void 0 ? void 0 : _c.tenantId) !== q.tenantId)
                continue;
            if (q.runId && ((_d = e.context) === null || _d === void 0 ? void 0 : _d.runId) !== q.runId)
                continue;
            out.push(e);
            if (out.length >= limit)
                break;
        }
        return out;
    }
    /**
     * Log a security event. This is the primary entry point.
     */
    logEvent(event) {
        const fullEvent = {
            id: `sec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            timestamp: new Date().toISOString(),
            ...event,
        };
        // In-memory ring buffer
        this.events.push(fullEvent);
        if (this.events.length > this.maxEvents) {
            this.events.shift();
        }
        // Persist to disk (async, non-blocking)
        this.persistEvent(fullEvent).catch(() => {
            // Silently handle persistence failures — audit logging should never break execution
        });
        // Record metrics
        this.recordMetrics(fullEvent);
        // Log to global logger
        this.logToGlobal(fullEvent);
        // Publish on MessageBus for real-time alerting
        this.publishToBus(fullEvent);
        return fullEvent;
    }
    // ── Convenience Methods ───────────────────────────────────────────
    logSandboxViolation(source, message, details, context) {
        return this.logEvent({
            type: 'sandbox_violation',
            severity: 'critical',
            source,
            message,
            details,
            context,
        });
    }
    logAuthFailure(source, message, details) {
        return this.logEvent({ type: 'auth_failure', severity: 'high', source, message, details });
    }
    logAuthSuccess(source, message, details) {
        return this.logEvent({ type: 'auth_success', severity: 'low', source, message, details });
    }
    logAuthRateLimit(source, message, details) {
        return this.logEvent({ type: 'auth_rate_limit', severity: 'high', source, message, details });
    }
    logApprovalDenied(source, message, details, context) {
        return this.logEvent({
            type: 'approval_denied',
            severity: 'medium',
            source,
            message,
            details,
            context,
        });
    }
    logContentThreat(source, message, details, context) {
        return this.logEvent({
            type: 'content_threat',
            severity: 'high',
            source,
            message,
            details,
            context,
        });
    }
    logExecPolicyViolation(source, message, details) {
        return this.logEvent({
            type: 'exec_policy_violation',
            severity: 'medium',
            source,
            message,
            details,
        });
    }
    logExecPolicyForbidden(source, message, details) {
        return this.logEvent({
            type: 'exec_policy_forbidden',
            severity: 'critical',
            source,
            message,
            details,
        });
    }
    logCredentialAccess(source, message, details) {
        return this.logEvent({
            type: 'credential_access',
            severity: 'medium',
            source,
            message,
            details,
        });
    }
    logInputValidationFailure(source, message, details) {
        return this.logEvent({
            type: 'input_validation_failure',
            severity: 'medium',
            source,
            message,
            details,
        });
    }
    logPathTraversalAttempt(source, message, details) {
        return this.logEvent({
            type: 'path_traversal_attempt',
            severity: 'critical',
            source,
            message,
            details,
        });
    }
    logCommandInjectionAttempt(source, message, details) {
        return this.logEvent({
            type: 'command_injection_attempt',
            severity: 'critical',
            source,
            message,
            details,
        });
    }
    logMemoryPoisoning(source, message, details) {
        return this.logEvent({
            type: 'memory_poisoning_detected',
            severity: 'high',
            source,
            message,
            details,
        });
    }
    logSkillSecurityViolation(source, message, details) {
        return this.logEvent({
            type: 'skill_security_violation',
            severity: 'high',
            source,
            message,
            details,
        });
    }
    logConfigChange(source, message, details) {
        return this.logEvent({ type: 'config_change', severity: 'medium', source, message, details });
    }
    logSecurityScan(source, message, details) {
        return this.logEvent({ type: 'security_scan', severity: 'low', source, message, details });
    }
    // ── Query API ─────────────────────────────────────────────────────
    /** Get recent events, optionally filtered by type/severity. */
    getRecent(limit = 50, filters) {
        let result = [...this.events].reverse();
        if (filters === null || filters === void 0 ? void 0 : filters.type)
            result = result.filter((e) => e.type === filters.type);
        if (filters === null || filters === void 0 ? void 0 : filters.severity)
            result = result.filter((e) => e.severity === filters.severity);
        return result.slice(0, limit);
    }
    /** Get events by source component. */
    getBySource(source, limit = 50) {
        return this.events
            .filter((e) => e.source === source)
            .reverse()
            .slice(0, limit);
    }
    /** Get all critical events. */
    getCritical(limit = 50) {
        return this.events
            .filter((e) => e.severity === 'critical')
            .reverse()
            .slice(0, limit);
    }
    /** Get statistics. */
    getStats() {
        var _a, _b;
        const byType = {};
        const bySeverity = {
            low: 0,
            medium: 0,
            high: 0,
            critical: 0,
        };
        const sourceCounts = {};
        for (const e of this.events) {
            byType[e.type] = ((_a = byType[e.type]) !== null && _a !== void 0 ? _a : 0) + 1;
            bySeverity[e.severity]++;
            sourceCounts[e.source] = ((_b = sourceCounts[e.source]) !== null && _b !== void 0 ? _b : 0) + 1;
        }
        const topSources = Object.entries(sourceCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([source, count]) => ({ source, count }));
        return {
            totalEvents: this.events.length,
            byType,
            bySeverity,
            recentCritical: this.getCritical(10),
            topSources,
        };
    }
    /** Clear in-memory events (does not affect persisted logs). */
    clear() {
        this.events = [];
    }
    // ── Internal ──────────────────────────────────────────────────────
    async persistEvent(event) {
        var _a;
        try {
            const filePath = this.getCurrentLogFile();
            const line = JSON.stringify(event) + '\n';
            await fs.promises.appendFile(filePath, line, 'utf-8');
            // Rotate if file exceeds max size
            const stat = await fs.promises.stat(filePath);
            if (stat.size > this.maxFileSize) {
                this.currentFileIndex = (this.currentFileIndex + 1) % this.maxFiles;
            }
        }
        catch (err) {
            // Non-critical: audit logging should never break execution
            process.stderr.write(`[SecurityAuditLogger] Persist failed: ${(_a = err === null || err === void 0 ? void 0 : err.message) !== null && _a !== void 0 ? _a : String(err)}\n`);
        }
    }
    getCurrentLogFile() {
        return path.join(this.persistDir, `security-audit-${this.currentFileIndex}.ndjson`);
    }
    ensurePersistDir() {
        var _a;
        try {
            if (!fs.existsSync(this.persistDir)) {
                fs.mkdirSync(this.persistDir, { recursive: true });
            }
        }
        catch (err) {
            process.stderr.write(`[SecurityAuditLogger] Failed to create persist dir: ${(_a = err === null || err === void 0 ? void 0 : err.message) !== null && _a !== void 0 ? _a : String(err)}\n`);
        }
    }
    recordMetrics(event) {
        try {
            const metrics = (0, logging_1.getGlobalMetrics)();
            metrics.incrementCounter('security.events.total', 1, {
                type: event.type,
                severity: event.severity,
            });
            metrics.incrementCounter(`security.events.${event.type}`, 1);
            if (event.severity === 'critical') {
                metrics.incrementCounter('security.events.critical', 1);
            }
        }
        catch {
            // Metrics not available — non-critical
        }
    }
    logToGlobal(event) {
        try {
            const logger = (0, logging_1.getGlobalLogger)();
            const context = {
                eventId: event.id,
                severity: event.severity,
                source: event.source,
                ...event.details,
            };
            switch (event.severity) {
                case 'critical':
                    logger.critical('SecurityAudit', `[${event.type}] ${event.message}`, context);
                    break;
                case 'high':
                    logger.error('SecurityAudit', `[${event.type}] ${event.message}`, undefined, context);
                    break;
                case 'medium':
                    logger.warn('SecurityAudit', `[${event.type}] ${event.message}`, context);
                    break;
                default:
                    logger.info('SecurityAudit', `[${event.type}] ${event.message}`, context);
            }
        }
        catch {
            // Logger not available — non-critical
        }
    }
    publishToBus(event) {
        try {
            // Dynamic import to avoid circular dependencies
            const { getMessageBus } = require('../runtime/messageBus');
            const bus = getMessageBus();
            bus.publish('security.event', 'SecurityAudit', event, {
                priority: event.severity === 'critical' ? 0 : event.severity === 'high' ? 1 : 3,
            });
        }
        catch {
            // MessageBus not available — non-critical
        }
    }
}
exports.SecurityAuditLogger = SecurityAuditLogger;
// ============================================================================
// Singleton
// ============================================================================
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const securityAuditSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new SecurityAuditLogger());
function getSecurityAuditLogger() {
    return securityAuditSingleton.get();
}
function resetSecurityAuditLogger() {
    securityAuditSingleton.reset();
}
