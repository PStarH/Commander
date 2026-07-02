/**
 * SLO Operations Integration
 *
 * Wires together the SLO Monitoring Engine, Alert Rule Engine, and
 * Incident Manager into a unified operations pipeline:
 *
 *   ExecutionTrace → SLOMonitoringEngine → burn rate evaluation
 *        ↓                                        ↓
 *   AlertRuleEngine ← burn rate metric     IncidentManager
 *        ↓                                        ↓
 *   NotificationManager                    post-mortem draft
 *
 * This module provides:
 *   - initializeSLOOperations(): bootstrap the entire pipeline
 *   - processTraceForSLO(): feed traces into the monitoring engine
 *   - HTTP route handlers for /api/v1/slo, /api/v1/alerts, /api/v1/incidents
 */

import {
  SLOMonitoringEngine,
  getSLOMonitoringEngine,
  resetSLOMonitoringEngine,
  type BurnRateResult,
  type SLODashboard,
} from './sloMonitoringEngine';
import {
  AlertRuleEngine,
  getAlertRuleEngine,
  resetAlertRuleEngine,
  createDefaultSLORules,
  type AlertRule,
  type AlertRecord,
  type AlertSummary,
} from './alertRuleEngine';
import {
  IncidentManager,
  getIncidentManager,
  resetIncidentManager,
  type OperationalIncident,
  type IncidentSummary,
  type IncidentSeverity,
  type IncidentStatus,
  type PostmortemReport,
} from './incidentManager';
import { getGlobalLogger } from '../../../logging';
import { getMessageBus } from '../../../runtime/messageBus';

// ============================================================================
// Configuration
// ============================================================================

export interface SLOOperationsConfig {
  /** SLOs to register with their target percentages */
  slos: Array<{
    id: string;
    name: string;
    targetPercent: number;
    metric: string;
    threshold: number;
  }>;
  /** Whether to auto-start continuous monitoring */
  autoStart: boolean;
}

// ============================================================================
// Default SLO Definitions
// ============================================================================

export const DEFAULT_SLO_CONFIG: SLOOperationsConfig = {
  slos: [
    {
      id: 'topology-success-rate',
      name: 'Topology Success Rate',
      targetPercent: 99.0, // 99% of tasks must succeed
      metric: 'success_rate',
      threshold: 0.99,
    },
    {
      id: 'latency-p99',
      name: 'Latency P99 < 500ms',
      targetPercent: 99.0, // 99% of requests under threshold
      metric: 'latency_ms',
      threshold: 500,
    },
    {
      id: 'cost-per-task',
      name: 'Cost per Task < $0.01',
      targetPercent: 95.0, // 95% of tasks under cost threshold
      metric: 'cost_usd',
      threshold: 0.01,
    },
  ],
  autoStart: true,
};

// ============================================================================
// SLO Operations Manager
// ============================================================================

export class SLOOperationsManager {
  private monitoringEngine: SLOMonitoringEngine;
  private alertEngine: AlertRuleEngine;
  private incidentManager: IncidentManager;
  private initialized = false;
  private registeredSLOs: Array<{ sloId: string; metric: string }> = [];

  constructor() {
    this.monitoringEngine = getSLOMonitoringEngine();
    this.alertEngine = getAlertRuleEngine();
    this.incidentManager = getIncidentManager();
  }

  /**
   * Initialize the SLO operations pipeline with default or custom config.
   */
  initialize(config: SLOOperationsConfig = DEFAULT_SLO_CONFIG): void {
    if (this.initialized) {
      getGlobalLogger().warn('SLOOperationsManager', 'Already initialized — skipping');
      return;
    }

    getGlobalLogger().info('SLOOperationsManager', 'Initializing SLO operations pipeline', {
      sloCount: config.slos.length,
      autoStart: config.autoStart,
    });

    // Register SLOs with the monitoring engine
    for (const slo of config.slos) {
      this.monitoringEngine.registerSLO(slo.id, slo.targetPercent);
      this.registeredSLOs.push({ sloId: slo.id, metric: slo.metric });

      // Create default alert rules for each SLO
      createDefaultSLORules(this.alertEngine, slo.id, slo.name);

      getGlobalLogger().info('SLOOperationsManager', 'SLO registered', {
        id: slo.id,
        targetPercent: slo.targetPercent,
      });
    }

    // Wire callbacks: monitoring engine → alert engine → incident manager
    this.monitoringEngine.onAlert((result: BurnRateResult) => {
      this.handleBurnRateAlert(result);
    });

    this.monitoringEngine.onIncident((result: BurnRateResult) => {
      this.handleBurnRateIncident(result);
    });

    // Subscribe to message bus for trace events
    try {
      const bus = getMessageBus();
      bus.subscribe('trace.recorded', (message) => {
        this.processTraceEvent({ data: message.payload as Record<string, unknown> });
      });
    } catch {
      getGlobalLogger().warn(
        'SLOOperationsManager',
        'Message bus not available — trace subscription skipped',
      );
    }

    if (config.autoStart) {
      this.monitoringEngine.start();
    }

    this.initialized = true;
    getGlobalLogger().info('SLOOperationsManager', 'SLO operations pipeline initialized');
  }

  /**
   * Process a trace event for SLO evaluation.
   */
  processTraceEvent(event: { data: Record<string, unknown> }): void {
    try {
      const data = event.data;
      const status = data.status as string;
      const latencyMs = data.totalDurationMs as number;
      const costUsd = data.totalCostUsd as number;

      // Evaluate against the registered SLOs directly.
      // Always use registeredSLOs (from config) rather than the dashboard's
      // burnRates, because burnRates may have metric='unknown' before any
      // events have been recorded.
      const sloIds = this.registeredSLOs;

      for (const { sloId, metric } of sloIds) {
        let value = 0;
        let passed = true;

        switch (metric) {
          case 'success_rate':
            value = status === 'success' ? 1 : 0;
            passed = status === 'success';
            break;
          case 'latency_ms':
            value = latencyMs;
            passed = latencyMs < 500;
            break;
          case 'cost_usd':
            value = costUsd;
            passed = costUsd < 0.01;
            break;
          default:
            continue;
        }

        this.monitoringEngine.recordEvent(sloId, metric, value, passed);
      }
    } catch (err) {
      getGlobalLogger().debug('SLOOperationsManager', 'Trace processing failed', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Handle burn rate alerts (warning/critical level).
   */
  private handleBurnRateAlert(result: BurnRateResult): void {
    // Feed the burn rate as a metric into the alert rule engine
    const metricName = `slo.${result.sloId}.burn_rate`;
    this.alertEngine.evaluateMetric(metricName, result.burnRate, {
      sloId: result.sloId,
      severity: result.severity,
    });
  }

  /**
   * Handle burn rate incidents (page level — create operational incident).
   */
  private handleBurnRateIncident(result: BurnRateResult): void {
    // Check if there's already an open incident for this SLO
    const existing = this.incidentManager
      .listIncidents({
        sloId: result.sloId,
        limit: 1,
      })
      .find((i) => i.status !== 'closed');

    if (existing) {
      // Add timeline entry to existing incident
      this.incidentManager.addTimelineEntry(
        existing.id,
        `Burn rate escalated: ${result.burnRate.toFixed(1)}x (${result.severity})`,
        'system',
        { burnRate: result.burnRate, errorBudget: result.errorBudgetRemaining },
      );
      return;
    }

    // Create new incident
    const severity: IncidentSeverity = result.severity === 'page' ? 'SEV1' : 'SEV2';
    this.incidentManager.createIncident({
      title: `SLO violation: ${result.sloName} burn rate ${result.burnRate.toFixed(1)}x`,
      severity,
      source: 'slo_burn_rate',
      sloId: result.sloId,
      affectedComponents: [result.sloName],
      metricsSnapshot: {
        burnRate: result.burnRate,
        errorBudgetRemaining: result.errorBudgetRemaining,
        shortWindowBurnRate: result.shortWindowBurnRate,
        longWindowBurnRate: result.longWindowBurnRate,
      },
      labels: { sloId: result.sloId, severity: result.severity },
    });
  }

  /**
   * Shutdown the SLO operations pipeline.
   */
  shutdown(): void {
    this.monitoringEngine.stop();
    getGlobalLogger().info('SLOOperationsManager', 'SLO operations pipeline shut down');
  }

  /**
   * Reset all state (for testing).
   */
  reset(): void {
    this.monitoringEngine.reset();
    this.alertEngine.reset();
    this.incidentManager.reset();
    this.registeredSLOs = [];
    this.initialized = false;
  }

  // ========================================================================
  // Accessors for HTTP handlers
  // ========================================================================

  getMonitoringEngine(): SLOMonitoringEngine {
    return this.monitoringEngine;
  }

  getAlertEngine(): AlertRuleEngine {
    return this.alertEngine;
  }

  getIncidentManager(): IncidentManager {
    return this.incidentManager;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalOpsManager: SLOOperationsManager | null = null;

export function getSLOOperations(): SLOOperationsManager {
  if (!globalOpsManager) {
    globalOpsManager = new SLOOperationsManager();
  }
  return globalOpsManager;
}

export function resetSLOOperations(): void {
  globalOpsManager?.shutdown();
  globalOpsManager?.reset();
  globalOpsManager = null;
  resetSLOMonitoringEngine();
  resetAlertRuleEngine();
  resetIncidentManager();
}

// ============================================================================
// HTTP Route Handlers
// ============================================================================

export interface HttpResponseLike {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}

function json(data: unknown, status = 200): HttpResponseLike {
  return {
    statusCode: status,
    body: JSON.stringify(data, null, 2),
    headers: { 'Content-Type': 'application/json' },
  };
}

/**
 * Handle SLO operations HTTP requests.
 *
 * Routes:
 *   GET  /api/v1/slo               — SLO dashboard (burn rates, status)
 *   GET  /api/v1/slo/burn-rates     — Detailed burn rate report
 *   POST /api/v1/slo/:id/evaluate   — Manually trigger SLO evaluation
 *
 *   GET  /api/v1/alerts             — Active alerts + summary
 *   GET  /api/v1/alerts/history     — Alert history (query: limit, sinceMs)
 *   POST /api/v1/alerts/rules       — Create alert rule
 *   PUT  /api/v1/alerts/rules/:id   — Update alert rule
 *   DELETE /api/v1/alerts/rules/:id — Delete alert rule
 *   POST /api/v1/alerts/:id/ack     — Acknowledge alert
 *
 *   GET  /api/v1/incidents          — Incident list + summary
 *   GET  /api/v1/incidents/:id      — Incident detail
 *   POST /api/v1/incidents          — Create manual incident
 *   PUT  /api/v1/incidents/:id      — Update incident status
 *   POST /api/v1/incidents/:id/postmortem — Submit post-mortem
 *   GET  /api/v1/incidents/summary  — Incident summary (MTTD/MTTR)
 */
export function handleSLOOperationsRequest(
  method: string,
  segments: string[],
  body?: string,
): HttpResponseLike | null {
  const ops = getSLOOperations();

  // /api/v1/slo
  if (segments[0] === 'slo') {
    if (method === 'GET' && segments.length === 1) {
      return json(ops.getMonitoringEngine().getDashboard());
    }

    if (method === 'GET' && segments[1] === 'burn-rates') {
      const results = ops.getMonitoringEngine().evaluate();
      return json({ burnRates: results, evaluatedAt: new Date().toISOString() });
    }

    if (method === 'POST' && segments[2] === 'evaluate') {
      const results = ops.getMonitoringEngine().evaluate();
      const target = results.find((r) => r.sloId === segments[1]);
      return json(target ?? { error: 'SLO not found', sloId: segments[1] }, target ? 200 : 404);
    }
  }

  // /api/v1/alerts
  if (segments[0] === 'alerts') {
    if (method === 'GET' && segments.length === 1) {
      const summary = ops.getAlertEngine().getSummary();
      const active = ops.getAlertEngine().getActiveAlerts();
      return json({ summary, activeAlerts: active });
    }

    if (method === 'GET' && segments[1] === 'history') {
      const limit = 100;
      const history = ops.getAlertEngine().getAlertHistory(limit);
      return json({ alerts: history, count: history.length });
    }

    if (method === 'GET' && segments[1] === 'rules') {
      return json({ rules: ops.getAlertEngine().listRules() });
    }

    if (method === 'POST' && segments[1] === 'rules') {
      try {
        const ruleData = JSON.parse(body ?? '{}');
        const rule = ops.getAlertEngine().createRule(ruleData);
        return json(rule, 201);
      } catch (err) {
        return json({ error: 'Invalid rule data', message: (err as Error).message }, 400);
      }
    }

    if (method === 'PUT' && segments[1] === 'rules' && segments[2]) {
      try {
        const updates = JSON.parse(body ?? '{}');
        const rule = ops.getAlertEngine().updateRule(segments[2], updates);
        return rule ? json(rule) : json({ error: 'Rule not found' }, 404);
      } catch (err) {
        return json({ error: 'Invalid update', message: (err as Error).message }, 400);
      }
    }

    if (method === 'DELETE' && segments[1] === 'rules' && segments[2]) {
      const deleted = ops.getAlertEngine().deleteRule(segments[2]);
      return deleted ? json({ deleted: true }) : json({ error: 'Rule not found' }, 404);
    }

    if (method === 'POST' && segments[2] === 'ack') {
      const ackBody = JSON.parse(body ?? '{}');
      const acked = ops
        .getAlertEngine()
        .acknowledgeAlert(segments[1], ackBody.acknowledgedBy ?? 'api');
      return acked ? json({ acknowledged: true }) : json({ error: 'Alert not found' }, 404);
    }
  }

  // /api/v1/incidents
  if (segments[0] === 'incidents') {
    if (method === 'GET' && segments.length === 1) {
      const summary = ops.getIncidentManager().getSummary();
      const incidents = ops.getIncidentManager().listIncidents({ limit: 50 });
      return json({ summary, incidents });
    }

    if (method === 'GET' && segments[1] === 'summary') {
      return json(ops.getIncidentManager().getSummary());
    }

    if (method === 'GET' && segments.length === 2 && segments[1] !== 'summary') {
      const incident = ops.getIncidentManager().getIncident(segments[1]);
      return incident ? json(incident) : json({ error: 'Incident not found' }, 404);
    }

    if (method === 'POST' && segments.length === 1) {
      try {
        const data = JSON.parse(body ?? '{}');
        const incident = ops.getIncidentManager().createIncident({
          title: data.title ?? 'Manual incident',
          severity: data.severity ?? 'SEV3',
          source: 'manual',
          affectedComponents: data.affectedComponents ?? [],
          metricsSnapshot: data.metricsSnapshot,
          labels: data.labels,
        });
        return json(incident, 201);
      } catch (err) {
        return json({ error: 'Invalid incident data', message: (err as Error).message }, 400);
      }
    }

    if (method === 'PUT' && segments.length === 2) {
      try {
        const data = JSON.parse(body ?? '{}');
        const incident = ops
          .getIncidentManager()
          .updateStatus(segments[1], data.status, data.actor ?? 'api', data.details);
        return incident ? json(incident) : json({ error: 'Incident not found' }, 404);
      } catch (err) {
        return json({ error: 'Invalid update', message: (err as Error).message }, 400);
      }
    }

    if (method === 'POST' && segments[2] === 'postmortem') {
      try {
        const data = JSON.parse(body ?? '{}');
        const incident = ops
          .getIncidentManager()
          .submitPostmortem(segments[1], data, data.author ?? 'api');
        return incident ? json(incident) : json({ error: 'Incident not found' }, 404);
      } catch (err) {
        return json({ error: 'Invalid post-mortem data', message: (err as Error).message }, 400);
      }
    }

    if (method === 'GET' && segments[2] === 'sla') {
      const sla = ops.getIncidentManager().getSLAStatus(segments[1]);
      return sla ? json(sla) : json({ error: 'Incident not found' }, 404);
    }
  }

  return null;
}
