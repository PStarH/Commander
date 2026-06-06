import { describe, it } from 'node:test';
import assert from 'node:assert';
import { dryReplay } from '../../src/observability/replay';
import type { ExecutionTrace, TraceEvent } from '../../src/runtime/types';

function llm(spanId: string, ts: string, output: string): TraceEvent {
  return {
    spanId, parentSpanId: undefined, traceId: 't1', runId: 'r1', agentId: 'a1',
    type: 'llm_call', timestamp: ts, durationMs: 100,
    data: { output, modelInfo: { provider: 'openai', model: 'gpt-4o' }, tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } },
  };
}

function tool(spanId: string, parent: string, ts: string, name: string, output: unknown): TraceEvent {
  return {
    spanId, parentSpanId: parent, traceId: 't1', runId: 'r1', agentId: 'a1',
    type: 'tool_execution', timestamp: ts, durationMs: 50,
    data: { input: name, output },
  };
}

describe('dryReplay', () => {
  it('produces same-node diff when no substitutions applied', () => {
    const trace: ExecutionTrace = {
      runId: 'r1', traceId: 't1', agentId: 'a1', startedAt: '2026-06-05T00:00:00.000Z',
      events: [llm('s1', '2026-06-05T00:00:00.000Z', 'hi')],
      summary: { totalEvents: 1, totalDurationMs: 100, totalTokens: 150, llmCalls: 1, toolExecutions: 0, errors: 0, modelUsed: 'gpt-4o' },
    };
    const r = dryReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: false });
    assert.strictEqual(r.diff.newSpans, 0);
    assert.strictEqual(r.diff.changedSpans, 0);
    assert.strictEqual(r.diff.costDeltaUsd, 0);
  });

  it('substitutes tool_output and reports changedSpans', () => {
    const trace: ExecutionTrace = {
      runId: 'r1', traceId: 't1', agentId: 'a1', startedAt: '2026-06-05T00:00:00.000Z',
      events: [
        tool('s1', undefined, '2026-06-05T00:00:00.000Z', 'shell', { exit: 0 }),
      ],
      summary: { totalEvents: 1, totalDurationMs: 50, totalTokens: 0, llmCalls: 0, toolExecutions: 1, errors: 0, modelUsed: '' },
    };
    const r = dryReplay(trace, {
      runId: 'r1',
      substitutions: [{ target: 'tool_output', spanId: 's1', value: { exit: 1, stderr: 'failed' } }],
      reExecuteLlm: false,
    });
    assert.strictEqual(r.diff.changedSpans, 1);
    assert.ok(r.replayedNodes[0]!.toolOutputPreview?.includes('"exit":1'));
  });

  it('substitutes llm_response', () => {
    const trace: ExecutionTrace = {
      runId: 'r1', traceId: 't1', agentId: 'a1', startedAt: '2026-06-05T00:00:00.000Z',
      events: [llm('s1', '2026-06-05T00:00:00.000Z', 'original')],
      summary: { totalEvents: 1, totalDurationMs: 100, totalTokens: 150, llmCalls: 1, toolExecutions: 0, errors: 0, modelUsed: 'gpt-4o' },
    };
    const r = dryReplay(trace, {
      runId: 'r1',
      substitutions: [{ target: 'llm_response', spanId: 's1', value: 'replayed-with-different-prompt' }],
      reExecuteLlm: true,
    });
    assert.strictEqual(r.diff.changedSpans, 1);
    assert.ok(r.replayedNodes[0]!.reasoning?.includes('replayed'));
  });
});
