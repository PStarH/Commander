import { describe, it, expect, beforeEach } from 'vitest';
import type { TraceEvent, ExecutionTrace } from '@commander/core';
import { resetCostModel } from '../src/costModel';
import { buildTimeline, buildSpanTree } from '../src/timelineBuilder';

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

function makeTrace(events: TraceEvent[] = []): ExecutionTrace {
  return {
    runId: 'run-1',
    traceId: 'trace-1',
    agentId: 'agent-1',
    startedAt: new Date().toISOString(),
    completedAt: new Date(Date.now() + 1000).toISOString(),
    events,
    summary: {
      totalEvents: events.length,
      totalDurationMs: events.reduce((s, e) => s + e.durationMs, 0),
      totalTokens: 0,
      llmCalls: events.filter((e) => e.type === 'llm_call').length,
      toolExecutions: events.filter((e) => e.type === 'tool_execution').length,
      errors: events.filter((e) => e.type === 'error').length,
      modelUsed: '',
    },
  };
}

describe('buildTimeline', () => {
  beforeEach(() => {
    resetCostModel();
  });

  it('returns a timeline view with correct metadata', () => {
    const trace = makeTrace([makeEvent()]);
    const view = buildTimeline(trace);
    expect(view.runId).toBe('run-1');
    expect(view.traceId).toBe('trace-1');
    expect(view.agentId).toBe('agent-1');
    expect(view.nodes).toHaveLength(1);
  });

  it('maps llm_call events to LLM nodes', () => {
    const trace = makeTrace([
      makeEvent({
        type: 'llm_call',
        data: {
          modelInfo: { model: 'gpt-4o', provider: 'openai', tier: 'standard' },
          tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        },
      }),
    ]);
    const view = buildTimeline(trace);
    expect(view.nodes[0]!.type).toBe('LLM');
    expect(view.nodes[0]!.model).toBe('gpt-4o');
    expect(view.nodes[0]!.tokens?.input).toBe(100);
  });

  it('maps tool_execution events to TOOL nodes', () => {
    const trace = makeTrace([
      makeEvent({ type: 'tool_execution', data: { input: 'web_search' } }),
    ]);
    const view = buildTimeline(trace);
    expect(view.nodes[0]!.type).toBe('TOOL');
    expect(view.nodes[0]!.name).toContain('web_search');
  });

  it('maps error events to ERROR nodes', () => {
    const trace = makeTrace([
      makeEvent({ type: 'error', data: { error: 'something failed' } }),
    ]);
    const view = buildTimeline(trace);
    expect(view.nodes[0]!.type).toBe('ERROR');
    expect(view.nodes[0]!.status).toBe('error');
  });

  it('computes hasChildren correctly', () => {
    const parent = makeEvent({ spanId: 'parent-1', type: 'tool_execution', data: { input: 'tool1' } });
    const child = makeEvent({ spanId: 'child-1', parentSpanId: 'parent-1', type: 'llm_call', data: {} });
    const trace = makeTrace([parent, child]);
    const view = buildTimeline(trace);
    expect(view.nodes.find((n) => n.spanId === 'parent-1')!.hasChildren).toBe(true);
    expect(view.nodes.find((n) => n.spanId === 'child-1')!.hasChildren).toBe(false);
  });

  it('computes summary counts', () => {
    const trace = makeTrace([
      makeEvent({ type: 'llm_call', data: {} }),
      makeEvent({ type: 'llm_call', data: {} }),
      makeEvent({ type: 'tool_execution', data: { input: 'tool1' } }),
      makeEvent({ type: 'error', data: { error: 'fail' } }),
    ]);
    const view = buildTimeline(trace);
    expect(view.summary.totalSpans).toBe(4);
    expect(view.summary.llmCalls).toBe(2);
    expect(view.summary.toolCalls).toBe(1);
    expect(view.summary.errors).toBe(1);
  });

  it('aggregates model usage in summary', () => {
    const trace = makeTrace([
      makeEvent({
        type: 'llm_call',
        data: {
          modelInfo: { model: 'gpt-4o', provider: 'openai', tier: 'standard' },
          tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        },
      }),
      makeEvent({
        type: 'llm_call',
        data: {
          modelInfo: { model: 'gpt-4o', provider: 'openai', tier: 'standard' },
          tokenUsage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
        },
      }),
    ]);
    const view = buildTimeline(trace);
    expect(view.summary.modelsUsed).toHaveLength(1);
    expect(view.summary.modelsUsed[0]!.calls).toBe(2);
    expect(view.summary.modelsUsed[0]!.tokens).toBe(450);
  });
});

describe('buildSpanTree', () => {
  beforeEach(() => {
    resetCostModel();
  });

  it('builds a tree from parent-child relationships', () => {
    const root = makeEvent({ spanId: 'root', type: 'tool_execution', data: { input: 'tool1' } });
    const child1 = makeEvent({ spanId: 'child1', parentSpanId: 'root', type: 'llm_call', data: {} });
    const child2 = makeEvent({ spanId: 'child2', parentSpanId: 'root', type: 'error', data: { error: 'fail' } });
    const grandchild = makeEvent({ spanId: 'gc', parentSpanId: 'child1', type: 'llm_call', data: {} });
    const trace = makeTrace([root, child1, child2, grandchild]);

    const tree = buildSpanTree(trace);
    expect(tree.runId).toBe('run-1');
    expect(tree.root.span.spanId).toBe('root');
    expect(tree.root.children).toHaveLength(2);
    expect(tree.root.children[0]!.children).toHaveLength(1);
    expect(tree.root.children[0]!.children[0]!.span.spanId).toBe('gc');
  });

  it('identifies orphans when parent is missing', () => {
    const orphan = makeEvent({ spanId: 'orphan', parentSpanId: 'missing-parent', type: 'llm_call', data: {} });
    const trace = makeTrace([orphan]);
    const tree = buildSpanTree(trace);
    expect(tree.orphans).toHaveLength(1);
    expect(tree.orphans[0]!.span.spanId).toBe('orphan');
  });

  it('assigns correct depth to nodes', () => {
    const root = makeEvent({ spanId: 'root', type: 'tool_execution', data: { input: 'tool1' } });
    const child = makeEvent({ spanId: 'child', parentSpanId: 'root', type: 'llm_call', data: {} });
    const grandchild = makeEvent({ spanId: 'gc', parentSpanId: 'child', type: 'llm_call', data: {} });
    const trace = makeTrace([root, child, grandchild]);
    const tree = buildSpanTree(trace);
    expect(tree.root.depth).toBe(0);
    expect(tree.root.children[0]!.depth).toBe(1);
    expect(tree.root.children[0]!.children[0]!.depth).toBe(2);
  });
});
