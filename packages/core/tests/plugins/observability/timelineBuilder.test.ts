import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildTimeline,
  buildSpanTree,
} from '../../../src/plugins/builtin/observability/timelineBuilder';
import type { ExecutionTrace, TraceEvent } from '../../../src/runtime/types';

function makeTrace(events: TraceEvent[]): ExecutionTrace {
  return {
    runId: 'run-1',
    traceId: 'trace-1',
    agentId: 'a-1',
    startedAt: events[0]?.timestamp ?? '2026-06-05T00:00:00.000Z',
    events,
    summary: {
      totalEvents: events.length,
      totalDurationMs: 0,
      totalTokens: 0,
      llmCalls: 0,
      toolExecutions: 0,
      errors: 0,
      modelUsed: '',
    },
  };
}

function llmEvent(
  spanId: string,
  parentSpanId: string | undefined,
  model: string,
  prompt: number,
  completion: number,
  ts: string,
): TraceEvent {
  return {
    spanId,
    parentSpanId,
    traceId: 'trace-1',
    runId: 'run-1',
    agentId: 'a-1',
    type: 'llm_call',
    timestamp: ts,
    durationMs: 100,
    data: {
      input: 'q',
      output: 'a',
      modelInfo: { provider: 'openai', model },
      tokenUsage: {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
      },
    },
  };
}

function toolEvent(spanId: string, parentSpanId: string, tool: string, ts: string): TraceEvent {
  return {
    spanId,
    parentSpanId,
    traceId: 'trace-1',
    runId: 'run-1',
    agentId: 'a-1',
    type: 'tool_execution',
    timestamp: ts,
    durationMs: 50,
    data: { input: tool, output: { ok: true } },
  };
}

describe('buildTimeline', () => {
  it('produces a TimelineNode for each event', () => {
    const trace = makeTrace([
      llmEvent('s1', undefined, 'gpt-4o', 100, 50, '2026-06-05T00:00:00.000Z'),
      toolEvent('s2', 's1', 'web_search', '2026-06-05T00:00:01.000Z'),
    ]);
    const t = buildTimeline(trace);
    assert.strictEqual(t.runId, 'run-1');
    assert.strictEqual(t.nodes.length, 2);
    assert.strictEqual(t.nodes[0]!.type, 'LLM');
    assert.strictEqual(t.nodes[1]!.type, 'TOOL');
  });

  it('attaches tokens and cost to LLM nodes', () => {
    const trace = makeTrace([
      llmEvent('s1', undefined, 'gpt-4o', 1000, 500, '2026-06-05T00:00:00.000Z'),
    ]);
    const t = buildTimeline(trace);
    const n = t.nodes[0]!;
    assert.strictEqual(n.tokens?.input, 1000);
    assert.strictEqual(n.tokens?.output, 500);
    assert.ok(n.cost && n.cost.totalCostUsd > 0);
  });

  it('summarizes by model', () => {
    const trace = makeTrace([
      llmEvent('s1', undefined, 'gpt-4o', 100, 50, '2026-06-05T00:00:00.000Z'),
      llmEvent('s2', undefined, 'gpt-4o', 200, 100, '2026-06-05T00:00:01.000Z'),
      llmEvent('s3', undefined, 'claude-3-5-sonnet-20251001', 300, 150, '2026-06-05T00:00:02.000Z'),
    ]);
    const t = buildTimeline(trace);
    assert.strictEqual(t.summary.llmCalls, 3);
    assert.strictEqual(t.summary.modelsUsed.length, 2);
  });

  it('marks nodes with hasChildren based on parentSpanId references', () => {
    const trace = makeTrace([
      llmEvent('s1', undefined, 'gpt-4o', 10, 10, '2026-06-05T00:00:00.000Z'),
      toolEvent('s2', 's1', 'shell', '2026-06-05T00:00:00.500Z'),
    ]);
    const t = buildTimeline(trace);
    const s1 = t.nodes.find((n) => n.spanId === 's1')!;
    const s2 = t.nodes.find((n) => n.spanId === 's2')!;
    assert.strictEqual(s1.hasChildren, true);
    assert.strictEqual(s2.hasChildren, false);
  });
});

describe('buildSpanTree', () => {
  it('builds a root and nested children', () => {
    const trace = makeTrace([
      llmEvent('s1', undefined, 'gpt-4o', 10, 10, '2026-06-05T00:00:00.000Z'),
      toolEvent('s2', 's1', 'web_search', '2026-06-05T00:00:00.500Z'),
      toolEvent('s3', 's1', 'web_fetch', '2026-06-05T00:00:01.000Z'),
    ]);
    const tree = buildSpanTree(trace);
    assert.ok(tree.root);
    assert.strictEqual(tree.root!.span.spanId, 's1');
    assert.strictEqual(tree.root!.children.length, 2);
  });

  it('collects orphan spans separately', () => {
    const trace = makeTrace([
      llmEvent('s1', undefined, 'gpt-4o', 10, 10, '2026-06-05T00:00:00.000Z'),
      toolEvent('orphan', 'unknown-parent', 'shell', '2026-06-05T00:00:01.000Z'),
    ]);
    const tree = buildSpanTree(trace);
    assert.strictEqual(tree.orphans.length, 1);
    assert.strictEqual(tree.orphans[0]!.span.spanId, 'orphan');
  });
});
