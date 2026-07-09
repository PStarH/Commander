/**
 * Alert Rule Engine
 *
 * Centralized alert rule management that unifies SLO violations, metric
 * thresholds, and anomaly detection into a single evaluation pipeline.
 *
 * This replaces the fragmented alerting pattern (bus.publish scattered
 * across components) with a declarative rule registry:
 *   - Operators define AlertRules (metric + condition + severity + channels)
 *   - The engine evaluates rules against live metrics on each tick
 *   - Firing rules produce AlertRecords with full audit trail
 *   - Alerts auto-resolve when conditions return to normal
 *
 * Integration:
 *   - Fed by SLOMonitoringEngine (burn rate alerts)
 *   - Fed by MetricsCollector (threshold alerts)
 *   - Fed by AnomalyDetector (statistical anomaly alerts)
 *   - Consumed by NotificationManager (webhook/email/slack dispatch)
 *   - Exposed via /alerts HTTP endpoint
 */

import { getGlobalLogger } from '../logging';
import { getMessageBus } from '../runtime/messageBus';

// ── Default SLO alert rule thresholds (Google SRE multi-window strategy) ────
const SRE_BURN_RATE_PAGE_THRESHOLD = 14.4;
const SRE_BURN_RATE_CRITICAL_THRESHOLD = 6;
const SRE_BURN_RATE_WARNING_THRESHOLD = 3;
const ALERT_WINDOW_2M = 2 * 60 * 1000;
const ALERT_WINDOW_5M = 5 * 60 * 1000;
const ALERT_WINDOW_10M = 10 * 60 * 1000;
const ALERT_WINDOW_15M = 15 * 60 * 1000;
const ALERT_WINDOW_30M = 30 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

export type AlertSeverity = 'info' | 'warning' | 'critical' | 'page';
export type AlertStatus = 'firing' | 'resolved' | 'suppressed' | 'acknowledged';

export type AlertCondition =
  | 'gt' // value > threshold
  | 'gte' // value >= threshold
  | 'lt' // value < threshold
  | 'lte' // value <= threshold
  | 'eq' // value === threshold
  | 'neq'; // value !== threshold

export interface AlertRule {
  id: string;
  name: string;
  description: string;
  /** Metric name to evaluate (e.g. 'slo.burn_rate', 'latency.p99_ms') */
  metric: string;
  /** Comparison operator */
  condition: AlertCondition;
  /** Threshold value */
  threshold: number;
  /** Severity when firing */
  severity: AlertSeverity;
  /** Notification channels (webhook, email, slack, pagerduty) */
  channels: string[];
  /** How long the condition must hold before alerting (ms) */
  forDurationMs: number;
  /** Auto-resolve after this many ms of healthy state */
  autoResolveAfterMs: number;
  /** Whether the rule is enabled */
  enabled: boolean;
  /** Runbook URL for responders */
  runbookUrl?: string;
  /** SLO ID this rule is associated with (if any) */
  sloId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AlertRecord {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  status: AlertStatus;
  metric: string;
  currentValue: number;
  threshold: number;
  condition: AlertCondition;
  /** When the alert started firing */
  firedAt: string;
  /** When the alert was resolved (if resolved) */
  resolvedAt?: string;
  /** When acknowledged (if acknowledged) */
  acknowledgedAt?: string;
  /** Who acknowledged */
  acknowledgedBy?: string;
  /** Number of notifications sent */
  notificationCount: number;
  /** Associated SLO ID */
  sloId?: string;
  /** Labels for filtering */
  labels: Record<string, string>;
  /** Human-readable message */
  message: string;
  /** Runbook URL */
  runbookUrl?: string;
}

export interface AlertSummary {
  total: number;
  firing: number;
  critical: number;
  warning: number;
  acknowledged: number;
  resolved24h: number;
}

// ============================================================================
// Alert Rule Engine
// ============================================================================

interface RuleState {
  /** When the condition first started being true (for forDurationMs) */
  conditionSince: number | null;
  /** Current alert record (if firing) */
  activeAlert: AlertRecord | null;
  /** Last evaluated value */
  lastValue: number | null;
  /** When the condition last returned to false (for autoResolveAfterMs) */
  healthySince: number | null;
}

export class AlertRuleEngine {
  private rules: Map<string, AlertRule> = new Map();
  private ruleStates: Map<string, RuleState> = new Map();
  private alertHistory: AlertRecord[] = [];
  private maxHistorySize: number;

  constructor(maxHistorySize: number = 10000) {
    this.maxHistorySize = maxHistorySize;
  }

  /**
   * Register a new alert rule.
   */
  createRule(rule: Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>): AlertRule {
    const id = `alert-rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const fullRule: AlertRule = {
      ...rule,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.rules.set(id, fullRule);
    this.ruleStates.set(id, {
      conditionSince: null,
      activeAlert: null,
      lastValue: null,
      healthySince: null,
    });

    getGlobalLogger().info('AlertRuleEngine', 'Alert rule created', {
      id,
      name: rule.name,
      metric: rule.metric,
      severity: rule.severity,
    });

    return fullRule;
  }

  /**
   * Update an existing rule.
   */
  updateRule(id: string, updates: Partial<AlertRule>): AlertRule | undefined {
    const existing = this.rules.get(id);
    if (!existing) return undefined;

    const updated: AlertRule = {
      ...existing,
      ...updates,
      id: existing.id,
      updatedAt: new Date().toISOString(),
    };
    this.rules.set(id, updated);
    return updated;
  }

  /**
   * Delete a rule.
   */
  deleteRule(id: string): boolean {
    const deleted = this.rules.delete(id);
    this.ruleStates.delete(id);
    return deleted;
  }

  /**
   * Get a rule by ID.
   */
  getRule(id: string): AlertRule | undefined {
    return this.rules.get(id);
  }

  /**
   * List all rules.
   */
  listRules(): AlertRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Evaluate a single metric value against all matching rules.
   * Returns any alerts that fired or resolved during this evaluation.
   */
  evaluateMetric(
    metric: string,
    value: number,
    labels: Record<string, string> = {},
  ): {
    fired: AlertRecord[];
    resolved: AlertRecord[];
  } {
    const fired: AlertRecord[] = [];
    const resolved: AlertRecord[] = [];

    for (const [ruleId, rule] of this.rules) {
      if (!rule.enabled || rule.metric !== metric) continue;

      const state = this.ruleStates.get(ruleId)!;
      state.lastValue = value;

      const conditionMet = this.checkCondition(value, rule.threshold, rule.condition);
      const now = Date.now();

      if (conditionMet) {
        state.healthySince = null;

        // Track when condition first became true
        if (state.conditionSince === null) {
          state.conditionSince = now;
        }

        const durationHeld = now - state.conditionSince;

        // Fire alert if forDurationMs has elapsed and no active alert
        if (durationHeld >= rule.forDurationMs && !state.activeAlert) {
          const alert: AlertRecord = {
            id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            ruleId,
            ruleName: rule.name,
            severity: rule.severity,
            status: 'firing',
            metric,
            currentValue: value,
            threshold: rule.threshold,
            condition: rule.condition,
            firedAt: new Date().toISOString(),
            notificationCount: 0,
            sloId: rule.sloId,
            labels,
            message: this.buildMessage(rule, value),
            runbookUrl: rule.runbookUrl,
          };

          state.activeAlert = alert;
          this.alertHistory.push(alert);
          this.trimHistory();
          fired.push(alert);

          // Publish to message bus for NotificationManager
          this.publishAlert(alert);

          getGlobalLogger().warn('AlertRuleEngine', 'Alert fired', {
            alertId: alert.id,
            ruleName: rule.name,
            metric,
            value,
            threshold: rule.threshold,
            severity: rule.severity,
          });
        } else if (state.activeAlert) {
          // Update current value on existing alert
          state.activeAlert.currentValue = value;
        }
      } else {
        state.conditionSince = null;

        // Auto-resolve if condition is false
        if (state.activeAlert) {
          if (state.healthySince === null) {
            state.healthySince = now;
          }

          const healthyDuration = now - state.healthySince;
          if (healthyDuration >= rule.autoResolveAfterMs) {
            state.activeAlert.status = 'resolved';
            state.activeAlert.resolvedAt = new Date().toISOString();
            resolved.push(state.activeAlert);
            this.publishAlertResolution(state.activeAlert);
            state.activeAlert = null;
            state.healthySince = null;

            getGlobalLogger().info('AlertRuleEngine', 'Alert resolved', {
              ruleId,
              ruleName: rule.name,
            });
          }
        }
      }
    }

    return { fired, resolved };
  }

  /**
   * Acknowledge an alert.
   */
  acknowledgeAlert(alertId: string, acknowledgedBy: string): boolean {
    // Find in active alerts
    for (const state of this.ruleStates.values()) {
      if (state.activeAlert?.id === alertId) {
        state.activeAlert.status = 'acknowledged';
        state.activeAlert.acknowledgedAt = new Date().toISOString();
        state.activeAlert.acknowledgedBy = acknowledgedBy;
        return true;
      }
    }
    return false;
  }

  /**
   * Get all currently firing/acknowledged alerts.
   */
  getActiveAlerts(): AlertRecord[] {
    const active: AlertRecord[] = [];
    for (const state of this.ruleStates.values()) {
      if (state.activeAlert) {
        active.push(state.activeAlert);
      }
    }
    return active.sort((a, b) => {
      const sevOrder = { page: 0, critical: 1, warning: 2, info: 3 };
      return sevOrder[a.severity] - sevOrder[b.severity];
    });
  }

  /**
   * Get alert history (including resolved).
   */
  getAlertHistory(limit: number = 100, sinceMs?: number): AlertRecord[] {
    let history = this.alertHistory;
    if (sinceMs !== undefined) {
      const cutoff = Date.now() - sinceMs;
      history = history.filter((a) => new Date(a.firedAt).getTime() >= cutoff);
    }
    return history.slice(-limit).reverse();
  }

  /**
   * Get a summary of current alert state.
   */
  getSummary(): AlertSummary {
    const active = this.getActiveAlerts();
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    const resolved24h = this.alertHistory.filter(
      (a) =>
        a.status === 'resolved' && a.resolvedAt && new Date(a.resolvedAt).getTime() >= cutoff24h,
    ).length;

    return {
      total: active.length,
      firing: active.filter((a) => a.status === 'firing').length,
      critical: active.filter((a) => a.severity === 'critical' || a.severity === 'page').length,
      warning: active.filter((a) => a.severity === 'warning').length,
      acknowledged: active.filter((a) => a.status === 'acknowledged').length,
      resolved24h,
    };
  }

  /**
   * Clear all state (for testing).
   */
  reset(): void {
    this.rules.clear();
    this.ruleStates.clear();
    this.alertHistory = [];
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  private checkCondition(value: number, threshold: number, condition: AlertCondition): boolean {
    switch (condition) {
      case 'gt':
        return value > threshold;
      case 'gte':
        return value >= threshold;
      case 'lt':
        return value < threshold;
      case 'lte':
        return value <= threshold;
      case 'eq':
        return value === threshold;
      case 'neq':
        return value !== threshold;
      default:
        return false;
    }
  }

  private buildMessage(rule: AlertRule, value: number): string {
    const conditionStr = {
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
      eq: '===',
      neq: '!==',
    }[rule.condition];
    return `${rule.name}: ${rule.metric} (${value.toFixed(4)}) ${conditionStr} ${rule.threshold} — ${rule.description}`;
  }

  private publishAlert(alert: AlertRecord): void {
    try {
      const bus = getMessageBus();
      bus.publish('system.alert', 'alertRuleEngine', {
        type: 'alert_fired',
        alertId: alert.id,
        ruleId: alert.ruleId,
        ruleName: alert.ruleName,
        severity: alert.severity,
        metric: alert.metric,
        currentValue: alert.currentValue,
        threshold: alert.threshold,
        message: alert.message,
        runbookUrl: alert.runbookUrl,
        timestamp: alert.firedAt,
      });
    } catch {
      // Bus not initialized — skip
    }
  }

  private publishAlertResolution(alert: AlertRecord): void {
    try {
      const bus = getMessageBus();
      bus.publish('system.alert', 'alertRuleEngine', {
        type: 'alert_resolved',
        alertId: alert.id,
        ruleId: alert.ruleId,
        ruleName: alert.ruleName,
        resolvedAt: alert.resolvedAt,
        timestamp: alert.resolvedAt,
      });
    } catch {
      // Bus not initialized — skip
    }
  }

  private trimHistory(): void {
    if (this.alertHistory.length > this.maxHistorySize) {
      this.alertHistory = this.alertHistory.slice(-this.maxHistorySize);
    }
  }
}

// ============================================================================
// Default SLO Alert Rules
// ============================================================================

/**
 * Create default alert rules for SLO burn-rate monitoring.
 * These implement the Google SRE multi-window multi-burn-rate strategy.
 */
export function createDefaultSLORules(
  engine: AlertRuleEngine,
  sloId: string,
  sloName: string,
): void {
  // Page: 14.4x burn rate (2% budget in 1 hour)
  engine.createRule({
    name: `${sloName} — burn rate page (14.4x)`,
    description: `Error budget burning 14.4x fast for SLO ${sloName}`,
    metric: `slo.${sloId}.burn_rate`,
    condition: 'gt',
    threshold: SRE_BURN_RATE_PAGE_THRESHOLD,
    severity: 'page',
    channels: ['pagerduty', 'slack'],
    forDurationMs: ALERT_WINDOW_2M,
    autoResolveAfterMs: ALERT_WINDOW_5M,
    enabled: true,
    runbookUrl: `https://runbooks.commander.dev/slo/${sloId}`,
    sloId,
  });

  // Critical: 6x burn rate (5% budget in 6 hours)
  engine.createRule({
    name: `${sloName} — burn rate critical (6x)`,
    description: `Error budget burning 6x fast for SLO ${sloName}`,
    metric: `slo.${sloId}.burn_rate`,
    condition: 'gt',
    threshold: SRE_BURN_RATE_CRITICAL_THRESHOLD,
    severity: 'critical',
    channels: ['slack', 'email'],
    forDurationMs: ALERT_WINDOW_5M,
    autoResolveAfterMs: ALERT_WINDOW_10M,
    enabled: true,
    runbookUrl: `https://runbooks.commander.dev/slo/${sloId}`,
    sloId,
  });

  // Warning: 3x burn rate (10% budget in 3 days)
  engine.createRule({
    name: `${sloName} — burn rate warning (3x)`,
    description: `Error budget burning 3x fast for SLO ${sloName}`,
    metric: `slo.${sloId}.burn_rate`,
    condition: 'gt',
    threshold: SRE_BURN_RATE_WARNING_THRESHOLD,
    severity: 'warning',
    channels: ['slack'],
    forDurationMs: ALERT_WINDOW_15M,
    autoResolveAfterMs: ALERT_WINDOW_30M,
    enabled: true,
    sloId,
  });
}

// ============================================================================
// Singleton
// ============================================================================

let globalEngine: AlertRuleEngine | null = null;

export function getAlertRuleEngine(): AlertRuleEngine {
  if (!globalEngine) {
    globalEngine = new AlertRuleEngine();
  }
  return globalEngine;
}

export function resetAlertRuleEngine(): void {
  globalEngine?.reset();
  globalEngine = null;
}
