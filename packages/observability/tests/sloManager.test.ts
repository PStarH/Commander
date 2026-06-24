import { describe, it, expect, beforeEach } from 'vitest';
import type { ExecutionTrace } from '@commander/core';
import { SLOManager } from '../src/sloManager';

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    runId: 'run-1',
    traceId: 'trace-1',
    agentId: 'agent-1',
    startedAt: new Date().toISOString(),
    completedAt: new Date(Date.now() + 1000).toISOString(),
    events: [],
    summary: {
      totalEvents: 10,
      totalDurationMs: 500,
      totalTokens: 1000,
      llmCalls: 3,
      toolExecutions: 2,
      errors: 1,
      modelUsed: 'gpt-4o',
    },
    ...overrides,
  };
}

describe('SLOManager', () => {
  let manager: SLOManager;

  beforeEach(() => {
    manager = new SLOManager();
  });

  it('creates an SLO', () => {
    const slo = manager.createSLO({
      name: 'Latency SLO',
      metric: 'latency_ms',
      threshold: 5000,
      operator: 'lt',
      windowSize: 60,
      alertChannels: [],
      enabled: true,
    });
    expect(slo.id).toBeDefined();
    expect(slo.name).toBe('Latency SLO');
  });

  it('lists SLOs', () => {
    manager.createSLO({ name: 'SLO 1', metric: 'latency_ms', threshold: 1000, operator: 'lt', windowSize: 60, alertChannels: [], enabled: true });
    manager.createSLO({ name: 'SLO 2', metric: 'error_rate', threshold: 0.1, operator: 'lt', windowSize: 60, alertChannels: [], enabled: true });
    expect(manager.listSLOs()).toHaveLength(2);
  });

  it('gets an SLO by id', () => {
    const created = manager.createSLO({ name: 'Test', metric: 'latency_ms', threshold: 1000, operator: 'lt', windowSize: 60, alertChannels: [], enabled: true });
    expect(manager.getSLO(created.id)?.name).toBe('Test');
  });

  it('updates an SLO', () => {
    const created = manager.createSLO({ name: 'Original', metric: 'latency_ms', threshold: 1000, operator: 'lt', windowSize: 60, alertChannels: [], enabled: true });
    const updated = manager.updateSLO(created.id, { name: 'Updated' });
    expect(updated?.name).toBe('Updated');
  });

  it('deletes an SLO', () => {
    const created = manager.createSLO({ name: 'Test', metric: 'latency_ms', threshold: 1000, operator: 'lt', windowSize: 60, alertChannels: [], enabled: true });
    expect(manager.deleteSLO(created.id)).toBe(true);
    expect(manager.getSLO(created.id)).toBeUndefined();
  });

  it('checks trace for violations (latency > threshold)', () => {
    manager.createSLO({
      name: 'Max latency',
      metric: 'latency_ms',
      threshold: 100,
      operator: 'gt',
      windowSize: 60,
      alertChannels: [],
      enabled: true,
    });
    const trace = makeTrace({ summary: { ...makeTrace().summary, totalDurationMs: 500 } });
    const violations = manager.checkTrace(trace);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.metric).toBe('latency_ms');
  });

  it('does not violate when within threshold', () => {
    manager.createSLO({
      name: 'Max latency',
      metric: 'latency_ms',
      threshold: 10000,
      operator: 'gt',
      windowSize: 60,
      alertChannels: [],
      enabled: true,
    });
    const trace = makeTrace({ summary: { ...makeTrace().summary, totalDurationMs: 500 } });
    const violations = manager.checkTrace(trace);
    expect(violations).toHaveLength(0);
  });

  it('skips disabled SLOs', () => {
    manager.createSLO({
      name: 'Disabled',
      metric: 'latency_ms',
      threshold: 100,
      operator: 'gt',
      windowSize: 60,
      alertChannels: [],
      enabled: false,
    });
    const trace = makeTrace({ summary: { ...makeTrace().summary, totalDurationMs: 500 } });
    const violations = manager.checkTrace(trace);
    expect(violations).toHaveLength(0);
  });

  it('checks error_rate violations', () => {
    manager.createSLO({
      name: 'Low errors',
      metric: 'error_rate',
      threshold: 0.05,
      operator: 'gt',
      windowSize: 60,
      alertChannels: [],
      enabled: true,
    });
    const trace = makeTrace({ summary: { ...makeTrace().summary, errors: 2, totalEvents: 10 } });
    const violations = manager.checkTrace(trace);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.severity).toBe('critical');
  });

  it('getStatus returns status for all SLOs', () => {
    manager.createSLO({ name: 'SLO 1', metric: 'latency_ms', threshold: 1000, operator: 'lt', windowSize: 60, alertChannels: [], enabled: true });
    const status = manager.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]!.name).toBe('SLO 1');
  });

  it('getViolations returns all violations', () => {
    manager.createSLO({ name: 'Test', metric: 'latency_ms', threshold: 100, operator: 'gt', windowSize: 60, alertChannels: [], enabled: true });
    manager.checkTrace(makeTrace({ summary: { ...makeTrace().summary, totalDurationMs: 500 } }));
    expect(manager.getViolations()).toHaveLength(1);
  });

  it('getViolations filters by sloId', () => {
    const slo = manager.createSLO({ name: 'Test', metric: 'latency_ms', threshold: 100, operator: 'gt', windowSize: 60, alertChannels: [], enabled: true });
    manager.checkTrace(makeTrace({ summary: { ...makeTrace().summary, totalDurationMs: 500 } }));
    expect(manager.getViolations(slo.id)).toHaveLength(1);
    expect(manager.getViolations('other-id')).toHaveLength(0);
  });
});
