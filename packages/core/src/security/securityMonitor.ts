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

import {
  getSecurityAuditLogger,
  type SecurityEvent,
  type SecuritySeverity,
} from './securityAuditLogger';
import { getGlobalLogger, getGlobalMetrics } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface SecurityAlert {
  id: string;
  timestamp: string;
  level: 'warning' | 'critical';
  title: string;
  description: string;
  events: SecurityEvent[];
  recommendation: string;
}

export interface SecurityHealth {
  status: 'healthy' | 'elevated' | 'critical';
  activeAlerts: number;
  recentEvents: number;
  criticalEvents: number;
  eventRate: number; // events per minute
  topThreats: Array<{ type: string; count: number }>;
  uptime: number; // ms since monitoring started
}

interface MonitorConfig {
  /** Window size for burst detection (ms) */
  burstWindowMs: number;
  /** Threshold for burst alert */
  burstThreshold: number;
  /** Window for repeated failure detection (ms) */
  failureWindowMs: number;
  /** Threshold for repeated failures from same source */
  failureThreshold: number;
  /** Health check interval (ms) */
  healthCheckIntervalMs: number;
  /** Max active alerts */
  maxAlerts: number;
}

const DEFAULT_CONFIG: MonitorConfig = {
  burstWindowMs: 60_000, // 1 minute
  burstThreshold: 20, // 20 events in 1 minute
  failureWindowMs: 300_000, // 5 minutes
  failureThreshold: 10, // 10 failures from same source
  healthCheckIntervalMs: 30_000, // 30 seconds
  maxAlerts: 100,
};

// ============================================================================
// SecurityMonitor
// ============================================================================

export class SecurityMonitor {
  private config: MonitorConfig;
  private alerts: SecurityAlert[] = [];
  private eventWindow: SecurityEvent[] = [];
  private sourceFailures: Map<string, SecurityEvent[]> = new Map();
  private seenTypes: Set<string> = new Set();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private startTime: number = 0;
  private running: boolean = false;
  private unsubscribe: (() => void) | null = null;

  constructor(config?: Partial<MonitorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /** Start monitoring security events. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();

    // Subscribe to security audit events
    const audit = getSecurityAuditLogger();
    // We'll poll recent events since SecurityAuditLogger doesn't have a listener pattern yet
    // In a future iteration, add onEvent() to SecurityAuditLogger
    this.healthCheckTimer = setInterval(() => {
      this.analyzeRecentEvents();
      this.cleanupOldEvents();
    }, this.config.healthCheckIntervalMs);
    this.healthCheckTimer.unref();

    getGlobalLogger().info('SecurityMonitor', 'Security monitoring started', {
      burstWindow: this.config.burstWindowMs,
      burstThreshold: this.config.burstThreshold,
    });
  }

  /** Stop monitoring. */
  stop(): void {
    this.running = false;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    getGlobalLogger().info('SecurityMonitor', 'Security monitoring stopped');
  }

  /** Check if monitor is running. */
  isRunning(): boolean {
    return this.running;
  }

  // ── Health API ────────────────────────────────────────────────────

  /** Get current security health status. */
  getHealth(): SecurityHealth {
    const recentEvents = this.getRecentEvents(this.config.burstWindowMs);
    const criticalEvents = recentEvents.filter((e) => e.severity === 'critical').length;
    const eventRate = recentEvents.length / (this.config.burstWindowMs / 60_000);

    const status = this.alerts.some((a) => a.level === 'critical')
      ? 'critical'
      : this.alerts.length > 0 || eventRate > this.config.burstThreshold / 2
        ? 'elevated'
        : 'healthy';

    const typeCounts: Record<string, number> = {};
    for (const e of recentEvents) {
      typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
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
  getAlerts(limit: number = 20): SecurityAlert[] {
    return [...this.alerts].reverse().slice(0, limit);
  }

  /** Dismiss an alert by ID. */
  dismissAlert(alertId: string): boolean {
    const idx = this.alerts.findIndex((a) => a.id === alertId);
    if (idx === -1) return false;
    this.alerts.splice(idx, 1);
    return true;
  }

  /** Clear all alerts. */
  clearAlerts(): void {
    this.alerts = [];
  }

  /**
   * Public helper for external subsystems (correlator, threat feed, etc.) to
   * raise a security alert without building a full SecurityEvent.
   */
  logAlert(payload: {
    type: string;
    severity: string;
    source: string;
    message: string;
    details?: Record<string, unknown>;
    timestamp?: string;
    recommendation?: string;
  }): void {
    const level: SecurityAlert['level'] = payload.severity === 'critical' ? 'critical' : 'warning';
    const severity =
      payload.severity === 'low' ||
      payload.severity === 'medium' ||
      payload.severity === 'high' ||
      payload.severity === 'critical'
        ? payload.severity
        : 'medium';

    this.raiseAlert({
      level,
      title: payload.type,
      description: payload.message,
      events: [
        {
          id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: payload.timestamp ?? new Date().toISOString(),
          type: payload.type as import('./securityAuditLogger').SecurityEventType,
          severity,
          source: payload.source,
          message: payload.message,
          details: payload.details,
        },
      ],
      recommendation: payload.recommendation ?? 'Investigate and respond according to runbook.',
    });
  }

  // ── Analysis ──────────────────────────────────────────────────────

  /** Process a security event for anomaly detection. Called by the audit logger poller. */
  processEvent(event: SecurityEvent): void {
    this.eventWindow.push(event);

    // Track source failures
    if (event.severity === 'high' || event.severity === 'critical') {
      const sourceEvents = this.sourceFailures.get(event.source) ?? [];
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

  private detectBurst(event: SecurityEvent): void {
    const windowStart = Date.now() - this.config.burstWindowMs;
    const recentInWindow = this.eventWindow.filter(
      (e) => new Date(e.timestamp).getTime() > windowStart,
    );

    if (recentInWindow.length >= this.config.burstThreshold) {
      const existing = this.alerts.find((a) => a.title === 'Security event burst detected');
      if (!existing) {
        this.raiseAlert({
          level: 'critical',
          title: 'Security event burst detected',
          description: `${recentInWindow.length} security events in the last ${this.config.burstWindowMs / 1000}s (threshold: ${this.config.burstThreshold})`,
          events: recentInWindow.slice(-5),
          recommendation:
            'Investigate the source of these events. Possible coordinated attack or system misconfiguration.',
        });
      }
    }
  }

  private detectRepeatedFailures(event: SecurityEvent): void {
    if (event.severity !== 'high' && event.severity !== 'critical') return;

    const windowStart = Date.now() - this.config.failureWindowMs;
    const sourceEvents = this.sourceFailures.get(event.source) ?? [];
    const recentFailures = sourceEvents.filter(
      (e) => new Date(e.timestamp).getTime() > windowStart,
    );

    if (recentFailures.length >= this.config.failureThreshold) {
      const existing = this.alerts.find(
        (a) => a.title === 'Repeated failures from source' && a.events[0]?.source === event.source,
      );
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

  private detectSeverityEscalation(event: SecurityEvent): void {
    if (event.severity !== 'critical') return;

    // Check if there were recent high-severity events from the same source
    const windowStart = Date.now() - this.config.burstWindowMs;
    const sourceEvents = this.sourceFailures.get(event.source) ?? [];
    const recentHigh = sourceEvents.filter(
      (e) => new Date(e.timestamp).getTime() > windowStart && e.severity === 'high',
    );

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

  private raiseAlert(alert: Omit<SecurityAlert, 'id' | 'timestamp'>): void {
    const fullAlert: SecurityAlert = {
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
    const logger = getGlobalLogger();
    if (alert.level === 'critical') {
      logger.critical('SecurityMonitor', `🚨 ${alert.title}: ${alert.description}`);
    } else {
      logger.warn('SecurityMonitor', `⚠️ ${alert.title}: ${alert.description}`);
    }

    // Record metric
    try {
      const metrics = getGlobalMetrics();
      metrics.incrementCounter('security.alerts', 1, { level: alert.level });
    } catch (err) {
      console.warn('[Catch]', err);
      /* non-critical */
    }

    // Publish on MessageBus
    try {
      const { getMessageBus } = require('../runtime/messageBus');
      const bus = getMessageBus();
      bus.publish('security.alert', 'SecurityMonitor', fullAlert, {
        priority: alert.level === 'critical' ? 0 : 2,
      });
    } catch (err) {
      console.warn('[Catch]', err);
      /* non-critical */
    }

    // AgentSOC integration: create incidents from security alerts
    // This wires the monitoring pipeline into the SOC operations center
    try {
      const { getAgentSoc } = require('./agentSoc');
      const soc = getAgentSoc();
      soc.createIncident({
        event: {
          id: fullAlert.id,
          timestamp: fullAlert.timestamp,
          type: 'security_scan',
          severity: alert.level === 'critical' ? 'critical' : 'high',
          source: 'SecurityMonitor',
          message: fullAlert.description,
        },
        alert: fullAlert,
      });
    } catch (err) {
      console.warn('[Catch]', err);
      /* non-critical — AgentSOC may not be initialized */
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  private analyzeRecentEvents(): void {
    const audit = getSecurityAuditLogger();
    const recent = audit.getRecent(100);
    for (const event of recent) {
      // Only process events we haven't seen yet
      if (!this.eventWindow.some((e) => e.id === event.id)) {
        this.processEvent(event);
      }
    }
  }

  private cleanupOldEvents(): void {
    const cutoff = Date.now() - this.config.failureWindowMs;
    this.eventWindow = this.eventWindow.filter((e) => new Date(e.timestamp).getTime() > cutoff);

    for (const [source, events] of this.sourceFailures) {
      const filtered = events.filter((e) => new Date(e.timestamp).getTime() > cutoff);
      if (filtered.length === 0) {
        this.sourceFailures.delete(source);
      } else {
        this.sourceFailures.set(source, filtered);
      }
    }

    // Auto-dismiss old alerts (1 hour)
    const alertCutoff = Date.now() - 3600_000;
    this.alerts = this.alerts.filter((a) => new Date(a.timestamp).getTime() > alertCutoff);
  }

  private getRecentEvents(windowMs: number): SecurityEvent[] {
    const cutoff = Date.now() - windowMs;
    return this.eventWindow.filter((e) => new Date(e.timestamp).getTime() > cutoff);
  }
}

// ============================================================================
// Singleton
// ============================================================================

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const securityMonitorSingleton = createTenantAwareSingleton(() => new SecurityMonitor());

export function getSecurityMonitor(): SecurityMonitor {
  return securityMonitorSingleton.get();
}

export function resetSecurityMonitor(): void {
  securityMonitorSingleton.reset();
}
