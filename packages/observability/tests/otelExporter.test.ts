import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutionTrace, TraceEvent } from '@commander/core';
import { SamplingPolicy } from '../src/samplingPolicy';

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: `evt_${Date.now()}_${Math.random()}`,
    spanId: `span_${Date.now()}_${Math.random()}`,
    traceId: 'trace-1',
    runId: 'run-1',
    agentId: 'agent-1',
    type: 'llm_call',
    timestamp: new Date().toISOString(),
    durationMs: 100,
    data: {},
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    runId: 'run-1',
    traceId: 'trace-1',
    agentId: 'agent-1',
    startedAt: new Date().toISOString(),
    completedAt: new Date(Date.now() + 1000).toISOString(),
    events: [makeEvent()],
    summary: {
      totalEvents: 1,
      totalDurationMs: 100,
      totalTokens: 0,
      llmCalls: 1,
      toolExecutions: 0,
      errors: 0,
      modelUsed: '',
    },
    ...overrides,
  };
}

// Dynamic import to avoid module-level side effects
async function loadExporter() {
  const mod = await import('../src/otelExporter');
  return mod;
}

describe('OtelSpanExporter', () => {
  let exporter: InstanceType<any>;

  beforeEach(async () => {
    const { OtelSpanExporter } = await loadExporter();
    exporter = new OtelSpanExporter({
      endpoint: 'http://localhost:4318',
      disabled: true,
    });
  });

  it('does nothing when disabled', () => {
    exporter.enqueue(makeTrace());
    expect(exporter.pendingCount()).toBe(0);
    expect(exporter.getStats().totalTracesSeen).toBe(0);
  });

  it('enqueues traces when enabled', async () => {
    const { OtelSpanExporter } = await loadExporter();
    const exp = new OtelSpanExporter({
      endpoint: 'http://localhost:4318',
      disabled: false,
      samplingPolicy: new SamplingPolicy({ baseRate: 1.0, salt: 'test' }),
    });
    exp.enqueue(makeTrace());
    expect(exp.getStats().totalTracesSeen).toBe(1);
    expect(exp.getStats().totalTracesSampled).toBe(1);
    exp.stop();
  });

  it('drops traces that fail sampling', async () => {
    const { OtelSpanExporter } = await loadExporter();
    const exp = new OtelSpanExporter({
      endpoint: 'http://localhost:4318',
      disabled: false,
      samplingPolicy: new SamplingPolicy({ baseRate: 0, salt: 'test' }),
    });
    exp.enqueue(makeTrace());
    expect(exp.getStats().totalTracesSampled).toBe(0);
    exp.stop();
  });

  it('applies backpressure when buffer is full', async () => {
    const { OtelSpanExporter } = await loadExporter();
    const exp = new OtelSpanExporter({
      endpoint: 'http://localhost:4318',
      disabled: false,
      maxBufferSize: 2,
      samplingPolicy: new SamplingPolicy({ baseRate: 1.0, salt: 'test' }),
    });
    exp.enqueue(makeTrace({ traceId: 't1' }));
    exp.enqueue(makeTrace({ traceId: 't2' }));
    exp.enqueue(makeTrace({ traceId: 't3' }));
    expect(exp.pendingCount()).toBe(2);
    expect(exp.getStats().bufferOverflowCount).toBe(1);
    exp.stop();
  });

  it('start/stop manages the flush timer', () => {
    exporter.start();
    exporter.stop();
    expect(exporter.pendingCount()).toBe(0);
  });

  it('setSamplingPolicy updates the policy', () => {
    const newPolicy = new SamplingPolicy({ baseRate: 0.5, salt: 'new' });
    exporter.setSamplingPolicy(newPolicy);
    expect(exporter.getSamplingPolicy()).toBe(newPolicy);
  });

  it('getStats returns current stats', () => {
    const stats = exporter.getStats();
    expect(stats.totalTracesSeen).toBe(0);
    expect(stats.totalSpansExported).toBe(0);
    expect(stats.lastExportAt).toBeUndefined();
  });
});
