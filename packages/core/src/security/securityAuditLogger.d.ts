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
export type SecurityEventType = 'sandbox_violation' | 'auth_failure' | 'auth_success' | 'auth_rate_limit' | 'approval_denied' | 'approval_granted' | 'content_threat' | 'exec_policy_violation' | 'exec_policy_forbidden' | 'credential_access' | 'input_validation_failure' | 'path_traversal_attempt' | 'command_injection_attempt' | 'memory_poisoning_detected' | 'skill_security_violation' | 'config_change' | 'security_scan';
export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical';
export interface SecurityEvent {
    /** Unique event ID */
    id: string;
    /** ISO timestamp */
    timestamp: string;
    /** Event category */
    type: SecurityEventType;
    /** Severity level */
    severity: SecuritySeverity;
    /** Component that generated the event */
    source: string;
    /** Human-readable description */
    message: string;
    /** Structured details (command, path, user, IP, etc.) */
    details?: Record<string, unknown>;
    /** Associated user/agent/run IDs */
    context?: {
        userId?: string;
        agentId?: string;
        runId?: string;
        tenantId?: string;
    };
}
export interface SecurityStats {
    totalEvents: number;
    byType: Record<string, number>;
    bySeverity: Record<SecuritySeverity, number>;
    recentCritical: SecurityEvent[];
    topSources: Array<{
        source: string;
        count: number;
    }>;
}
export interface SecurityEventQuery {
    type?: string;
    severity?: SecuritySeverity;
    tenantId?: string;
    runId?: string;
    since?: number;
    limit?: number;
}
export declare class SecurityAuditLogger {
    private events;
    private readonly maxEvents;
    private readonly persistDir;
    private readonly maxFileSize;
    private readonly maxFiles;
    private currentFileIndex;
    constructor(options?: {
        maxEvents?: number;
        persistDir?: string;
        maxFileSize?: number;
        maxFiles?: number;
    });
    queryEvents(q?: SecurityEventQuery): SecurityEvent[];
    /**
     * Log a security event. This is the primary entry point.
     */
    logEvent(event: Omit<SecurityEvent, 'id' | 'timestamp'>): SecurityEvent;
    logSandboxViolation(source: string, message: string, details?: Record<string, unknown>, context?: SecurityEvent['context']): SecurityEvent;
    logAuthFailure(source: string, message: string, details?: Record<string, unknown>): SecurityEvent;
    logAuthSuccess(source: string, message: string, details?: Record<string, unknown>): SecurityEvent;
    logAuthRateLimit(source: string, message: string, details?: Record<string, unknown>): SecurityEvent;
    logApprovalDenied(source: string, message: string, details?: Record<string, unknown>, context?: SecurityEvent['context']): SecurityEvent;
    logContentThreat(source: string, message: string, details?: Record<string, unknown>, context?: SecurityEvent['context']): SecurityEvent;
    logExecPolicyViolation(source: string, message: string, details?: Record<string, unknown>): SecurityEvent;
    logExecPolicyForbidden(source: string, message: string, details?: Record<string, unknown>): SecurityEvent;
    logCredentialAccess(source: string, message: string, details?: Record<string, unknown>): SecurityEvent;
    logInputValidationFailure(source: string, message: string, details?: Record<string, unknown>): SecurityEvent;
    logPathTraversalAttempt(source: string, message: string, details?: Record<string, unknown>): SecurityEvent;
    logCommandInjectionAttempt(source: string, message: string, details?: Record<string, unknown>): SecurityEvent;
    logMemoryPoisoning(source: string, message: string, details?: Record<string, unknown>): SecurityEvent;
    logSkillSecurityViolation(source: string, message: string, details?: Record<string, unknown>): SecurityEvent;
    logConfigChange(source: string, message: string, details?: Record<string, unknown>): SecurityEvent;
    logSecurityScan(source: string, message: string, details?: Record<string, unknown>): SecurityEvent;
    /** Get recent events, optionally filtered by type/severity. */
    getRecent(limit?: number, filters?: {
        type?: SecurityEventType;
        severity?: SecuritySeverity;
    }): SecurityEvent[];
    /** Get events by source component. */
    getBySource(source: string, limit?: number): SecurityEvent[];
    /** Get all critical events. */
    getCritical(limit?: number): SecurityEvent[];
    /** Get statistics. */
    getStats(): SecurityStats;
    /** Clear in-memory events (does not affect persisted logs). */
    clear(): void;
    private persistEvent;
    private getCurrentLogFile;
    private ensurePersistDir;
    private recordMetrics;
    private logToGlobal;
    private publishToBus;
}
export declare function getSecurityAuditLogger(): SecurityAuditLogger;
export declare function resetSecurityAuditLogger(): void;
//# sourceMappingURL=securityAuditLogger.d.ts.map