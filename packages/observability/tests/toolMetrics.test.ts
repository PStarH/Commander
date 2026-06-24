import { describe, it, expect, beforeEach } from 'vitest';
import type { TraceEvent, ExecutionTrace } from '@commander/core';
import { ToolMetricsCollector } from '../src/toolMetrics';

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: `evt_${Date.now()}_${Math.random()}`,
    spanId: `span_${Date.now()}_${Math.random()}`,
    traceId: 'trace-1',
    runId: 'run-1',
    agentId: 'agent-1',
    type: 'tool_execution',
    timestamp: new Date().toISOString(),
    durationMs: 100,
    data: { input: 'tool1' },
    ...overrides,
  };
}

describe('ToolMetricsCollector', () => {
  let collector: ToolMetricsCollector;

  beforeEach(() => {
    collector = new ToolMetricsCollector();
  });

  it('records tool executions', () => {
    collector.recordToolExecution(makeEvent({ data: { input: 'web_search' } }));
    const stats = collector.getToolStats('web_search');
    expect(stats).toBeDefined();
    expect(stats!.invocations).toBe(1);
    expect(stats!.successes).toBe(1);
  });

  it('records failures', () => {
    collector.recordToolExecution(
      makeEvent({ data: { input: 'web_search', error: 'timeout' } }),
    );
    const stats = collector.getToolStats('web_search');
    expect(stats!.failures).toBe(1);
    expect(stats!.successes).toBe(0);
  });

  it('ignores non-tool events', () => {
    collector.recordToolExecution(
      makeEvent({ type: 'llm_call', data: {} }),
    );
    expect(collector.getAllStats()).toHaveLength(0);
  });

  it('records from trace', () => {
    const events = [
      makeEvent({ data: { input: 'tool1' } }),
      makeEvent({ data: { input: 'tool2' } }),
      makeEvent({ data: { input: 'tool1' } }),
    ];
    collector.recordFromTrace(events);
    expect(collector.getAllStats()).toHaveLength(2);
    expect(collector.getToolStats('tool1')!.invocations).toBe(2);
    expect(collector.getToolStats('tool2')!.invocations).toBe(1);
  });

  it('computes success rate', () => {
    collector.recordToolExecution(makeEvent({ data: { input: 'tool1' } }));
    collector.recordToolExecution(
      makeEvent({ data: { input: 'tool1', error: 'fail' } }),
    );
    expect(collector.getSuccessRate('tool1')).toBe(0.5);
  });

  it('returns 0 success rate for unknown tool', () => {
    expect(collector.getSuccessRate('unknown')).toBe(0);
  });

  it('getSummary returns correct totals', () => {
    collector.recordFromTrace([
      makeEvent({ data: { input: 'tool1' } }),
      makeEvent({ data: { input: 'tool1' } }),
      makeEvent({ data: { input: 'tool2' } }),
    ]);
    const summary = collector.getSummary();
    expect(summary.totalTools).toBe(2);
    expect(summary.totalInvocations).toBe(3);
    expect(summary.overallSuccessRate).toBe(1);
  });

  it('getAllStats sorts by invocation count descending', () => {
    collector.recordFromTrace([
      makeEvent({ data: { input: 'rare' } }),
      makeEvent({ data: { input: 'common' } }),
      makeEvent({ data: { input: 'common' } }),
      makeEvent({ data: { input: 'common' } }),
    ]);
    const stats = collector.getAllStats();
    expect(stats[0]!.toolName).toBe('common');
    expect(stats[1]!.toolName).toBe('rare');
  });
});
