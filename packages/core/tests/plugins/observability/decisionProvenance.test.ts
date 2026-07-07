import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildDecisions,
  decisionsSummary,
} from '../../../src/plugins/builtin/observability/decisionProvenance';
import type { ExecutionTrace, TraceEvent } from '../../../src/runtime/types';

function llm(spanId: string, ts: string, output: unknown): TraceEvent {
  return {
    spanId,
    parentSpanId: undefined,
    traceId: 't1',
    runId: 'r1',
    agentId: 'a1',
    type: 'llm_call',
    timestamp: ts,
    durationMs: 100,
    data: { output, modelInfo: { provider: 'openai', model: 'gpt-4o' } },
  };
}

function tool(spanId: string, parent: string, ts: string, name: string): TraceEvent {
  return {
    spanId,
    parentSpanId: parent,
    traceId: 't1',
    runId: 'r1',
    agentId: 'a1',
    type: 'tool_execution',
    timestamp: ts,
    durationMs: 50,
    data: { input: name, output: { ok: true } },
  };
}

describe('buildDecisions', () => {
  it('extracts decisions from tool events with preceding LLM call', () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [
        llm('s1', '2026-06-05T00:00:00.000Z', {
          content: 'I will call web_search to find the docs',
        }),
        tool('s2', 's1', '2026-06-05T00:00:01.000Z', 'web_search'),
      ],
      summary: {
        totalEvents: 2,
        totalDurationMs: 0,
        totalTokens: 0,
        llmCalls: 1,
        toolExecutions: 1,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    const decisions = buildDecisions(trace);
    assert.strictEqual(decisions.length, 1);
    assert.strictEqual(decisions[0]!.toolName, 'web_search');
    assert.strictEqual(decisions[0]!.llmSpanId, 's1');
    assert.ok(decisions[0]!.decisionReason.includes('web_search'));
    assert.strictEqual(decisions[0]!.thinkDurationMs, 1000);
  });

  it('reports no preceding LLM when tool has no LLM ancestor', () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [tool('s1', undefined, '2026-06-05T00:00:00.000Z', 'shell')],
      summary: {
        totalEvents: 1,
        totalDurationMs: 0,
        totalTokens: 0,
        llmCalls: 0,
        toolExecutions: 1,
        errors: 0,
        modelUsed: '',
      },
    };
    const decisions = buildDecisions(trace);
    assert.strictEqual(decisions.length, 1);
    assert.strictEqual(decisions[0]!.llmSpanId, undefined);
    assert.ok(decisions[0]!.decisionReason.includes('no preceding'));
  });

  it('summarizes p95 think time and per-tool averages', () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [
        llm('s1', '2026-06-05T00:00:00.000Z', 'a'),
        tool('s2', 's1', '2026-06-05T00:00:00.100Z', 'web_search'),
        tool('s3', 's1', '2026-06-05T00:00:00.500Z', 'web_search'),
        tool('s4', 's1', '2026-06-05T00:00:02.000Z', 'shell'),
      ],
      summary: {
        totalEvents: 4,
        totalDurationMs: 0,
        totalTokens: 0,
        llmCalls: 1,
        toolExecutions: 3,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    const decisions = buildDecisions(trace);
    const s = decisionsSummary(decisions);
    assert.strictEqual(s.total, 3);
    assert.strictEqual(s.byTool.length, 2);
    const ws = s.byTool.find((t) => t.tool === 'web_search')!;
    assert.strictEqual(ws.count, 2);
    assert.strictEqual(ws.avgThinkMs, 300);
  });
});
