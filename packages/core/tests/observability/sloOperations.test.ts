/**
 * SLO Operations Integration Tests
 *
 * Verifies the continuous monitoring, alerting, and post-mortem pipeline:
 *   1. SLO Monitoring Engine: burn rate calculation and multi-window alerting
 *   2. Alert Rule Engine: rule evaluation, firing, auto-resolution, acknowledgment
 *   3. Incident Manager: incident creation, status lifecycle, post-mortem generation
 *   4. SLO Operations Manager: end-to-end pipeline integration
 *   5. HTTP Route Handlers: all API endpoints
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SLOMonitoringEngine,
  resetSLOMonitoringEngine,
} from '../../src/observability/sloMonitoringEngine';
import {
  AlertRuleEngine,
  resetAlertRuleEngine,
  createDefaultSLORules,
} from '../../src/observability/alertRuleEngine';
import {
  IncidentManager,
  resetIncidentManager,
} from '../../src/observability/incidentManager';
import {
  SLOOperationsManager,
  getSLOOperations,
  resetSLOOperations,
  handleSLOOperationsRequest,
  DEFAULT_SLO_CONFIG,
} from '../../src/observability/sloOperations';

describe('SLO Monitoring Engine', () => {
  let engine: SLOMonitoringEngine;

  beforeEach(() => {
    resetSLOMonitoringEngine();
    engine = new SLOMonitoringEngine({
      shortWindowMs: 1000,
      longWindowMs: 5000,
      fullWindowMs: 10000,
      evaluationIntervalMs: 100,
    });
  });

  afterEach(() => {
    engine.stop();
    resetSLOMonitoringEngine();
  });

  it('should register SLOs and calculate burn rate', () => {
    engine.registerSLO('test-slo', 99.0);

    // Record 100 events, 2 failures (98% success rate)
    // SLO target: 99%, allowed error: 1%, actual error: 2%
    // Expected burn rate: 2.0
    for (let i = 0; i < 98; i++) {
      engine.recordEvent('test-slo', 'success_rate', 1, true);
    }
    for (let i = 0; i < 2; i++) {
      engine.recordEvent('test-slo', 'success_rate', 0, false);
    }

    const results = engine.evaluate();
    expect(results).toHaveLength(1);
    expect(results[0].sloId).toBe('test-slo');
    expect(results[0].burnRate).toBeGreaterThan(1);
    expect(results[0].isViolating).toBe(true);
  });

  it('should derive correct severity from multi-window burn rate', () => {
    engine.registerSLO('critical-slo', 99.9);

    // Record many failures to trigger high burn rate
    // SLO target: 99.9%, allowed error: 0.1%
    // 50% failure rate → burn rate = 500x → page severity
    for (let i = 0; i < 50; i++) {
      engine.recordEvent('critical-slo', 'error_rate', 1, false);
    }

    const results = engine.evaluate();
    expect(results[0].severity).toBe('page');
  });

  it('should report healthy when all events pass', () => {
    engine.registerSLO('healthy-slo', 99.0);

    for (let i = 0; i < 100; i++) {
      engine.recordEvent('healthy-slo', 'success_rate', 1, true);
    }

    const results = engine.evaluate();
    expect(results[0].burnRate).toBe(0);
    expect(results[0].isViolating).toBe(false);
    expect(results[0].severity).toBe('none');
  });

  it('should provide a dashboard with event counts', () => {
    engine.registerSLO('dash-slo', 99.0);
    engine.recordEvent('dash-slo', 'latency_ms', 100, true);
    engine.recordEvent('dash-slo', 'latency_ms', 600, false);

    const dashboard = engine.getDashboard();
    expect(dashboard.totalSLOs).toBe(1);
    expect(dashboard.eventCounts.short).toBe(2);
  });

  it('should fire alert callback on warning severity', () => {
    engine.registerSLO('alert-slo', 99.0);
    let alertFired = false;
    engine.onAlert(() => { alertFired = true; });

    // 5% failure rate, burn rate = 5x → warning
    for (let i = 0; i < 95; i++) {
      engine.recordEvent('alert-slo', 'success_rate', 1, true);
    }
    for (let i = 0; i < 5; i++) {
      engine.recordEvent('alert-slo', 'success_rate', 0, false);
    }

    engine.evaluate();
    expect(alertFired).toBe(true);
  });

  it('should fire incident callback on page severity', () => {
    engine.registerSLO('page-slo', 99.9);
    let incidentFired = false;
    engine.onIncident(() => { incidentFired = true; });

    // 50% failure rate → burn rate ~500x → page
    for (let i = 0; i < 50; i++) {
      engine.recordEvent('page-slo', 'success_rate', 0, false);
    }

    engine.evaluate();
    expect(incidentFired).toBe(true);
  });
});

describe('Alert Rule Engine', () => {
  let engine: AlertRuleEngine;

  beforeEach(() => {
    resetAlertRuleEngine();
    engine = new AlertRuleEngine();
  });

  afterEach(() => {
    resetAlertRuleEngine();
  });

  it('should create and list rules', () => {
    const rule = engine.createRule({
      name: 'High latency',
      description: 'P99 latency above 500ms',
      metric: 'latency.p99_ms',
      condition: 'gt',
      threshold: 500,
      severity: 'warning',
      channels: ['slack'],
      forDurationMs: 0,
      autoResolveAfterMs: 1000,
      enabled: true,
    });

    expect(rule.id).toBeDefined();
    expect(engine.listRules()).toHaveLength(1);
  });

  it('should fire alert when condition is met', () => {
    engine.createRule({
      name: 'High error rate',
      description: 'Error rate above 5%',
      metric: 'error_rate',
      condition: 'gt',
      threshold: 5,
      severity: 'critical',
      channels: ['pagerduty'],
      forDurationMs: 0,
      autoResolveAfterMs: 1000,
      enabled: true,
    });

    const { fired } = engine.evaluateMetric('error_rate', 10);
    expect(fired).toHaveLength(1);
    expect(fired[0].severity).toBe('critical');
    expect(fired[0].currentValue).toBe(10);
  });

  it('should not fire when condition is not met', () => {
    engine.createRule({
      name: 'High error rate',
      description: 'Error rate above 5%',
      metric: 'error_rate',
      condition: 'gt',
      threshold: 5,
      severity: 'critical',
      channels: [],
      forDurationMs: 0,
      autoResolveAfterMs: 1000,
      enabled: true,
    });

    const { fired } = engine.evaluateMetric('error_rate', 2);
    expect(fired).toHaveLength(0);
  });

  it('should auto-resolve after healthy duration', async () => {
    engine.createRule({
      name: 'High latency',
      description: 'Latency above 100ms',
      metric: 'latency_ms',
      condition: 'gt',
      threshold: 100,
      severity: 'warning',
      channels: [],
      forDurationMs: 0,
      autoResolveAfterMs: 50, // 50ms for fast testing
      enabled: true,
    });

    // Fire the alert
    engine.evaluateMetric('latency_ms', 200);
    expect(engine.getActiveAlerts()).toHaveLength(1);

    // Wait for auto-resolve duration
    await new Promise((r) => setTimeout(r, 100));

    // Condition no longer met — evaluate to trigger auto-resolve
    engine.evaluateMetric('latency_ms', 50);
    // May need one more evaluation to clear the alert
    await new Promise((r) => setTimeout(r, 50));
    engine.evaluateMetric('latency_ms', 50);
    expect(engine.getActiveAlerts()).toHaveLength(0);
  });

  it('should support alert acknowledgment', () => {
    engine.createRule({
      name: 'Critical alert',
      description: 'Test',
      metric: 'cpu_usage',
      condition: 'gt',
      threshold: 90,
      severity: 'page',
      channels: [],
      forDurationMs: 0,
      autoResolveAfterMs: 60000,
      enabled: true,
    });

    const { fired } = engine.evaluateMetric('cpu_usage', 95);
    const alertId = fired[0].id;

    const acked = engine.acknowledgeAlert(alertId, 'operator-1');
    expect(acked).toBe(true);
    expect(engine.getActiveAlerts()[0].status).toBe('acknowledged');
    expect(engine.getActiveAlerts()[0].acknowledgedBy).toBe('operator-1');
  });

  it('should create default SLO burn-rate rules', () => {
    createDefaultSLORules(engine, 'test-slo', 'Test SLO');
    const rules = engine.listRules();
    expect(rules).toHaveLength(3);

    const pageRule = rules.find((r) => r.severity === 'page');
    expect(pageRule?.threshold).toBe(14.4);

    const criticalRule = rules.find((r) => r.severity === 'critical');
    expect(criticalRule?.threshold).toBe(6);

    const warningRule = rules.find((r) => r.severity === 'warning');
    expect(warningRule?.threshold).toBe(3);
  });

  it('should provide summary with counts', () => {
    engine.createRule({
      name: 'Alert 1',
      description: 'Test',
      metric: 'm1',
      condition: 'gt',
      threshold: 10,
      severity: 'critical',
      channels: [],
      forDurationMs: 0,
      autoResolveAfterMs: 60000,
      enabled: true,
    });
    engine.createRule({
      name: 'Alert 2',
      description: 'Test',
      metric: 'm2',
      condition: 'gt',
      threshold: 10,
      severity: 'warning',
      channels: [],
      forDurationMs: 0,
      autoResolveAfterMs: 60000,
      enabled: true,
    });

    engine.evaluateMetric('m1', 20);
    engine.evaluateMetric('m2', 20);

    const summary = engine.getSummary();
    expect(summary.firing).toBe(2);
    expect(summary.critical).toBe(1);
    expect(summary.warning).toBe(1);
  });
});

describe('Incident Manager', () => {
  let manager: IncidentManager;

  beforeEach(() => {
    resetIncidentManager();
    manager = new IncidentManager();
  });

  afterEach(() => {
    resetIncidentManager();
  });

  it('should create an incident with correct initial state', () => {
    const incident = manager.createIncident({
      title: 'SLO violation: latency',
      severity: 'SEV1',
      source: 'slo_burn_rate',
      sloId: 'latency-p99',
      affectedComponents: ['api-gateway'],
      metricsSnapshot: { burnRate: 15.2 },
    });

    expect(incident.id).toBeDefined();
    expect(incident.status).toBe('detected');
    expect(incident.severity).toBe('SEV1');
    expect(incident.timeline).toHaveLength(1);
    expect(incident.postmortem).toBeNull();
  });

  it('should update status through lifecycle', () => {
    const incident = manager.createIncident({
      title: 'Test incident',
      severity: 'SEV2',
      source: 'manual',
      affectedComponents: ['service-a'],
    });

    manager.updateStatus(incident.id, 'investigating', 'responder-1');
    expect(manager.getIncident(incident.id)?.status).toBe('investigating');

    manager.updateStatus(incident.id, 'mitigated', 'responder-1', 'Restarted service');
    expect(manager.getIncident(incident.id)?.mitigatedAt).toBeDefined();

    manager.updateStatus(incident.id, 'resolved', 'responder-1');
    const resolved = manager.getIncident(incident.id);
    expect(resolved?.resolvedAt).toBeDefined();
    expect(resolved?.status).toBe('postmortem_pending');
    expect(resolved?.postmortem).not.toBeNull();
    expect(resolved?.postmortem?.status).toBe('draft');
  });

  it('should auto-generate post-mortem draft on resolution', () => {
    const incident = manager.createIncident({
      title: 'Test',
      severity: 'SEV1',
      source: 'alert_escalation',
      affectedComponents: ['api'],
    });

    manager.updateStatus(incident.id, 'resolved', 'system');
    const resolved = manager.getIncident(incident.id);

    expect(resolved?.postmortem).not.toBeNull();
    expect(resolved?.postmortem?.incidentId).toBe(incident.id);
    expect(resolved?.postmortem?.summary).toContain('AUTO-DRAFT');
    expect(resolved?.postmortem?.timeline).toBe(incident.timeline);
    expect(resolved?.postmortem?.actionItems).toEqual([]);
  });

  it('should submit and approve post-mortem', () => {
    const incident = manager.createIncident({
      title: 'Test',
      severity: 'SEV2',
      source: 'manual',
      affectedComponents: ['api'],
    });

    manager.updateStatus(incident.id, 'resolved', 'responder');
    manager.submitPostmortem(incident.id, {
      summary: 'Root cause was a misconfigured timeout.',
      rootCauses: ['Timeout set to 100ms instead of 1000ms'],
      status: 'approved',
    }, 'responder');

    const closed = manager.getIncident(incident.id);
    expect(closed?.status).toBe('closed');
    expect(closed?.postmortem?.status).toBe('approved');
    expect(closed?.postmortem?.summary).toBe('Root cause was a misconfigured timeout.');
  });

  it('should track action items', () => {
    const incident = manager.createIncident({
      title: 'Test',
      severity: 'SEV3',
      source: 'manual',
      affectedComponents: ['api'],
    });
    manager.updateStatus(incident.id, 'resolved', 'responder');

    const item = manager.addActionItem(
      incident.id,
      'Add timeout to config validation',
      'team-lead',
      'high',
      '2026-07-01',
    );

    expect(item).toBeDefined();
    expect(item?.status).toBe('open');
    expect(manager.getIncident(incident.id)?.postmortem?.actionItems).toHaveLength(1);
  });

  it('should provide summary with MTTD/MTTR', () => {
    const incident = manager.createIncident({
      title: 'Test',
      severity: 'SEV2',
      source: 'manual',
      affectedComponents: ['api'],
    });

    manager.updateStatus(incident.id, 'investigating', 'responder');
    manager.updateStatus(incident.id, 'resolved', 'responder');

    const summary = manager.getSummary();
    expect(summary.total).toBeGreaterThanOrEqual(1);
    expect(summary.mttdMinutes).toBeGreaterThanOrEqual(0);
    expect(summary.mttrMinutes).toBeGreaterThanOrEqual(0);
  });

  it('should provide SLA status', () => {
    const incident = manager.createIncident({
      title: 'SEV1 incident',
      severity: 'SEV1',
      source: 'slo_burn_rate',
      affectedComponents: ['critical-service'],
    });

    const sla = manager.getSLAStatus(incident.id);
    expect(sla).toBeDefined();
    expect(sla?.responseTargetMinutes).toBe(5);
    expect(sla?.resolutionTargetMinutes).toBe(60);
  });

  it('should list and filter incidents', () => {
    manager.createIncident({
      title: 'SEV1',
      severity: 'SEV1',
      source: 'manual',
      affectedComponents: [],
    });
    manager.createIncident({
      title: 'SEV3',
      severity: 'SEV3',
      source: 'manual',
      affectedComponents: [],
    });

    expect(manager.listIncidents({ severity: 'SEV1' })).toHaveLength(1);
    expect(manager.listIncidents({ severity: 'SEV3' })).toHaveLength(1);
    expect(manager.listIncidents()).toHaveLength(2);
  });
});

describe('SLO Operations Manager (Integration)', () => {
  let ops: SLOOperationsManager;

  beforeEach(() => {
    resetSLOOperations();
    ops = getSLOOperations();
  });

  afterEach(() => {
    resetSLOOperations();
  });

  it('should initialize with default SLO config', () => {
    ops.initialize();
    const dashboard = ops.getMonitoringEngine().getDashboard();
    expect(dashboard.totalSLOs).toBe(DEFAULT_SLO_CONFIG.slos.length);
  });

  it('should register alert rules for each SLO', () => {
    ops.initialize();
    const rules = ops.getAlertEngine().listRules();
    // 3 SLOs × 3 rules each (page, critical, warning) = 9 rules
    expect(rules.length).toBe(DEFAULT_SLO_CONFIG.slos.length * 3);
  });

  it('should process trace events and record SLO metrics', () => {
    ops.initialize();

    // Simulate processing a successful trace
    ops.processTraceEvent({
      data: {
        runId: 'test-run',
        status: 'success',
        totalDurationMs: 100,
        totalCostUsd: 0.001,
        totalTokens: 100,
      },
    });

    // Trigger evaluation so the dashboard reflects the new events
    ops.getMonitoringEngine().evaluate();

    // The monitoring engine should have recorded events
    const dashboard = ops.getMonitoringEngine().getDashboard();
    expect(dashboard.eventCounts.short).toBeGreaterThan(0);
  });

  it('should create incident when burn rate is critical', () => {
    ops.initialize();

    // Feed many failures to trigger page-level burn rate
    for (let i = 0; i < 100; i++) {
      ops.processTraceEvent({
        data: {
          runId: `fail-${i}`,
          status: 'failed',
          totalDurationMs: 2000,
          totalCostUsd: 0.001,
          totalTokens: 100,
        },
      });
    }

    // Trigger evaluation — this fires the onIncident callback
    // which creates an incident in the IncidentManager
    const burnRates = ops.getMonitoringEngine().evaluate();

    // Verify burn rate is at page level
    const pageBurn = burnRates.find((b) => b.severity === 'page');
    expect(pageBurn).toBeDefined();

    const incidents = ops.getIncidentManager().listIncidents();
    expect(incidents.length).toBeGreaterThan(0);
    expect(incidents[0].severity).toBe('SEV1');
    expect(incidents[0].source).toBe('slo_burn_rate');
  });
});

describe('SLO Operations HTTP Handlers', () => {
  beforeEach(() => {
    resetSLOOperations();
    getSLOOperations().initialize();
  });

  afterEach(() => {
    resetSLOOperations();
  });

  it('GET /slo returns dashboard', () => {
    const result = handleSLOOperationsRequest('GET', ['slo']);
    expect(result).not.toBeNull();
    expect(result?.statusCode).toBe(200);

    const body = JSON.parse(result!.body);
    expect(body.totalSLOs).toBeGreaterThan(0);
    expect(body.burnRates).toBeDefined();
  });

  it('GET /slo/burn-rates returns evaluation results', () => {
    const result = handleSLOOperationsRequest('GET', ['slo', 'burn-rates']);
    expect(result?.statusCode).toBe(200);

    const body = JSON.parse(result!.body);
    expect(body.burnRates).toBeDefined();
    expect(body.evaluatedAt).toBeDefined();
  });

  it('GET /alerts returns summary and active alerts', () => {
    const result = handleSLOOperationsRequest('GET', ['alerts']);
    expect(result?.statusCode).toBe(200);

    const body = JSON.parse(result!.body);
    expect(body.summary).toBeDefined();
    expect(body.activeAlerts).toBeDefined();
  });

  it('GET /alerts/rules lists all rules', () => {
    const result = handleSLOOperationsRequest('GET', ['alerts', 'rules']);
    expect(result?.statusCode).toBe(200);

    const body = JSON.parse(result!.body);
    expect(body.rules.length).toBeGreaterThan(0);
  });

  it('POST /alerts/rules creates a new rule', () => {
    const ruleData = {
      name: 'Test rule',
      description: 'Test',
      metric: 'test_metric',
      condition: 'gt',
      threshold: 100,
      severity: 'warning',
      channels: ['slack'],
      forDurationMs: 0,
      autoResolveAfterMs: 5000,
      enabled: true,
    };

    const result = handleSLOOperationsRequest('POST', ['alerts', 'rules'], JSON.stringify(ruleData));
    expect(result?.statusCode).toBe(201);

    const body = JSON.parse(result!.body);
    expect(body.id).toBeDefined();
    expect(body.name).toBe('Test rule');
  });

  it('GET /incidents returns summary and list', () => {
    const result = handleSLOOperationsRequest('GET', ['incidents']);
    expect(result?.statusCode).toBe(200);

    const body = JSON.parse(result!.body);
    expect(body.summary).toBeDefined();
    expect(body.incidents).toBeDefined();
  });

  it('POST /incidents creates a manual incident', () => {
    const incidentData = {
      title: 'Manual test incident',
      severity: 'SEV3',
      affectedComponents: ['test-service'],
    };

    const result = handleSLOOperationsRequest('POST', ['incidents'], JSON.stringify(incidentData));
    expect(result?.statusCode).toBe(201);

    const body = JSON.parse(result!.body);
    expect(body.id).toBeDefined();
    expect(body.title).toBe('Manual test incident');
    expect(body.status).toBe('detected');
  });

  it('PUT /incidents/:id updates status', () => {
    // Create incident first
    const createResult = handleSLOOperationsRequest('POST', ['incidents'], JSON.stringify({
      title: 'Test',
      severity: 'SEV2',
      affectedComponents: [],
    }));
    const incidentId = JSON.parse(createResult!.body).id;

    // Update status
    const result = handleSLOOperationsRequest('PUT', ['incidents', incidentId], JSON.stringify({
      status: 'investigating',
      actor: 'test-user',
    }));

    expect(result?.statusCode).toBe(200);
    const body = JSON.parse(result!.body);
    expect(body.status).toBe('investigating');
  });

  it('GET /incidents/summary returns MTTD/MTTR', () => {
    const result = handleSLOOperationsRequest('GET', ['incidents', 'summary']);
    expect(result?.statusCode).toBe(200);

    const body = JSON.parse(result!.body);
    expect(body.mttdMinutes).toBeDefined();
    expect(body.mttrMinutes).toBeDefined();
  });

  it('returns 404 for unknown endpoints', () => {
    const result = handleSLOOperationsRequest('GET', ['unknown']);
    expect(result).toBeNull();
  });
});
