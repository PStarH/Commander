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

import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getGlobalLogger, getGlobalMetrics } from '../logging';

// ============================================================================
// Types
// ============================================================================

export type SecurityEventType =
  | 'sandbox_violation'
  | 'auth_failure'
  | 'auth_success'
  | 'auth_rate_limit'
  | 'approval_denied'
  | 'approval_granted'
  | 'content_threat'
  | 'exec_policy_violation'
  | 'exec_policy_forbidden'
  | 'credential_access'
  | 'input_validation_failure'
  | 'path_traversal_attempt'
  | 'command_injection_attempt'
  | 'memory_poisoning_detected'
  | 'skill_security_violation'
  | 'a2a_security_violation'
  | 'config_change'
  | 'security_scan'
  // Audit #1/#4/#7 hardening — operational events emitted by the
  // SequentialPipelineExecutor + commander-rotate CLI. Routed through
  // the same SecurityAuditLogger so dashboards / alerting rules pick them
  // up without bespoke plumbing.
  | 'key_rotation_attempt'
  | 'key_rotation_confirmed'
  | 'key_rotation_dry_run'
  | 'token_budget_breach'
  | 'circuit_breaker_short_circuit'
  | 'security_decision'
  // Adaptive Threat Learning Engine — 学习型安全事件。
  // - threat_learned: 新签名/规则/攻击家族被学习或规则生命周期变更
  // - signature_matched: 入侵请求命中已学习的签名
  | 'threat_learned'
  | 'signature_matched';

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
  topSources: Array<{ source: string; count: number }>;
}

export interface SecurityEventQuery {
  type?: string;
  severity?: SecuritySeverity;
  tenantId?: string;
  runId?: string;
  since?: number;
  limit?: number;
}

// ============================================================================
// SecurityAuditLogger
// ============================================================================

export class SecurityAuditLogger {
  private events: SecurityEvent[] = [];
  private readonly maxEvents: number;
  private readonly persistDir: string;
  private readonly maxFileSize: number;
  private readonly maxFiles: number;
  private currentFileIndex: number = 0;

  constructor(options?: {
    maxEvents?: number;
    persistDir?: string;
    maxFileSize?: number;
    maxFiles?: number;
  }) {
    this.maxEvents = options?.maxEvents ?? 10000;
    this.persistDir = options?.persistDir ?? path.join(process.cwd(), '.commander_security');
    this.maxFileSize = options?.maxFileSize ?? 50 * 1024 * 1024; // 50MB
    this.maxFiles = options?.maxFiles ?? 5;
    this.ensurePersistDir();
  }

  // ── Core API ──────────────────────────────────────────────────────

  queryEvents(q: SecurityEventQuery = {}): SecurityEvent[] {
    const limit = Math.max(1, Math.min(q.limit ?? 100, 5000));
    const since = q.since ?? 0;
    const out: SecurityEvent[] = [];
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (!e) continue;
      if (Date.parse(e.timestamp) < since) continue;
      if (q.type && e.type !== q.type) continue;
      if (q.severity && e.severity !== q.severity) continue;
      if (q.tenantId && e.context?.tenantId !== q.tenantId) continue;
      if (q.runId && e.context?.runId !== q.runId) continue;
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Log a security event. This is the primary entry point.
   */
  logEvent(event: Omit<SecurityEvent, 'id' | 'timestamp'>): SecurityEvent {
    const fullEvent: SecurityEvent = {
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

  logSandboxViolation(
    source: string,
    message: string,
    details?: Record<string, unknown>,
    context?: SecurityEvent['context'],
  ): SecurityEvent {
    return this.logEvent({
      type: 'sandbox_violation',
      severity: 'critical',
      source,
      message,
      details,
      context,
    });
  }

  logAuthFailure(
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): SecurityEvent {
    return this.logEvent({ type: 'auth_failure', severity: 'high', source, message, details });
  }

  logAuthSuccess(
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): SecurityEvent {
    return this.logEvent({ type: 'auth_success', severity: 'low', source, message, details });
  }

  logAuthRateLimit(
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): SecurityEvent {
    return this.logEvent({ type: 'auth_rate_limit', severity: 'high', source, message, details });
  }

  logApprovalDenied(
    source: string,
    message: string,
    details?: Record<string, unknown>,
    context?: SecurityEvent['context'],
  ): SecurityEvent {
    return this.logEvent({
      type: 'approval_denied',
      severity: 'medium',
      source,
      message,
      details,
      context,
    });
  }

  logContentThreat(
    source: string,
    message: string,
    details?: Record<string, unknown>,
    context?: SecurityEvent['context'],
  ): SecurityEvent {
    return this.logEvent({
      type: 'content_threat',
      severity: 'high',
      source,
      message,
      details,
      context,
    });
  }

  logExecPolicyViolation(
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): SecurityEvent {
    return this.logEvent({
      type: 'exec_policy_violation',
      severity: 'medium',
      source,
      message,
      details,
    });
  }

  logExecPolicyForbidden(
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): SecurityEvent {
    return this.logEvent({
      type: 'exec_policy_forbidden',
      severity: 'critical',
      source,
      message,
      details,
    });
  }

  logCredentialAccess(
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): SecurityEvent {
    return this.logEvent({
      type: 'credential_access',
      severity: 'medium',
      source,
      message,
      details,
    });
  }

  logInputValidationFailure(
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): SecurityEvent {
    return this.logEvent({
      type: 'input_validation_failure',
      severity: 'medium',
      source,
      message,
      details,
    });
  }

  logPathTraversalAttempt(
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): SecurityEvent {
    return this.logEvent({
      type: 'path_traversal_attempt',
      severity: 'critical',
      source,
      message,
      details,
    });
  }

  logCommandInjectionAttempt(
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): SecurityEvent {
    return this.logEvent({
      type: 'command_injection_attempt',
      severity: 'critical',
      source,
      message,
      details,
    });
  }

  logMemoryPoisoning(
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): SecurityEvent {
    return this.logEvent({
      type: 'memory_poisoning_detected',
      severity: 'high',
      source,
      message,
      details,
    });
  }

  logSkillSecurityViolation(
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): SecurityEvent {
    return this.logEvent({
      type: 'skill_security_violation',
      severity: 'high',
      source,
      message,
      details,
    });
  }

  logConfigChange(
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): SecurityEvent {
    return this.logEvent({ type: 'config_change', severity: 'medium', source, message, details });
  }

  logSecurityScan(
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): SecurityEvent {
    return this.logEvent({ type: 'security_scan', severity: 'low', source, message, details });
  }

  // ── Query API ─────────────────────────────────────────────────────

  /** Get recent events, optionally filtered by type/severity. */
  getRecent(
    limit: number = 50,
    filters?: { type?: SecurityEventType; severity?: SecuritySeverity },
  ): SecurityEvent[] {
    let result = [...this.events].reverse();
    if (filters?.type) result = result.filter((e) => e.type === filters.type);
    if (filters?.severity) result = result.filter((e) => e.severity === filters.severity);
    return result.slice(0, limit);
  }

  /** Get events by source component. */
  getBySource(source: string, limit: number = 50): SecurityEvent[] {
    return this.events
      .filter((e) => e.source === source)
      .reverse()
      .slice(0, limit);
  }

  /** Get all critical events. */
  getCritical(limit: number = 50): SecurityEvent[] {
    return this.events
      .filter((e) => e.severity === 'critical')
      .reverse()
      .slice(0, limit);
  }

  /** Get statistics. */
  getStats(): SecurityStats {
    const byType: Record<string, number> = {};
    const bySeverity: Record<SecuritySeverity, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };
    const sourceCounts: Record<string, number> = {};

    for (const e of this.events) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      bySeverity[e.severity]++;
      sourceCounts[e.source] = (sourceCounts[e.source] ?? 0) + 1;
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
  clear(): void {
    this.events = [];
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async persistEvent(event: SecurityEvent): Promise<void> {
    try {
      const filePath = this.getCurrentLogFile();
      const line = JSON.stringify(event) + '\n';
      await fs.promises.appendFile(filePath, line, 'utf-8');

      // Rotate if file exceeds max size
      const stat = await fs.promises.stat(filePath);
      if (stat.size > this.maxFileSize) {
        this.currentFileIndex = (this.currentFileIndex + 1) % this.maxFiles;
      }
    } catch (err) {
      // Non-critical: audit logging should never break execution
      process.stderr.write(
        `[SecurityAuditLogger] Persist failed: ${(err as Error)?.message ?? String(err)}\n`,
      );
    }
  }

  private getCurrentLogFile(): string {
    return path.join(this.persistDir, `security-audit-${this.currentFileIndex}.ndjson`);
  }

  private ensurePersistDir(): void {
    try {
      if (!fs.existsSync(this.persistDir)) {
        fs.mkdirSync(this.persistDir, { recursive: true });
      }
    } catch (err) {
      process.stderr.write(
        `[SecurityAuditLogger] Failed to create persist dir: ${(err as Error)?.message ?? String(err)}\n`,
      );
    }
  }

  private recordMetrics(event: SecurityEvent): void {
    try {
      const metrics = getGlobalMetrics();
      metrics.incrementCounter('security.events.total', 1, {
        type: event.type,
        severity: event.severity,
      });
      metrics.incrementCounter(`security.events.${event.type}`, 1);
      if (event.severity === 'critical') {
        metrics.incrementCounter('security.events.critical', 1);
      }
    } catch (err) {
      reportSilentFailure(err, 'securityAuditLogger:506');
      // Metrics not available — non-critical
    }
  }

  private logToGlobal(event: SecurityEvent): void {
    try {
      const logger = getGlobalLogger();
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
    } catch (err) {
      reportSilentFailure(err, 'securityAuditLogger:534');
      // Logger not available — non-critical
    }
  }

  private publishToBus(event: SecurityEvent): void {
    try {
      // Dynamic import to avoid circular dependencies
      const { getMessageBus } = require('../runtime/messageBus');
      const bus = getMessageBus();
      bus.publish('security.event', 'SecurityAudit', event, {
        priority: event.severity === 'critical' ? 0 : event.severity === 'high' ? 1 : 3,
      });
    } catch (err) {
      reportSilentFailure(err, 'securityAuditLogger:548');
      // MessageBus not available — non-critical
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const securityAuditSingleton = createTenantAwareSingleton(() => new SecurityAuditLogger(), {
  componentName: 'SecurityAuditLogger',
});

export function getSecurityAuditLogger(): SecurityAuditLogger {
  return securityAuditSingleton.get();
}

export function resetSecurityAuditLogger(): void {
  securityAuditSingleton.reset();
}
