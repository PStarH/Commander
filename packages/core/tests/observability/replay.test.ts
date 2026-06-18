import { describe, it } from 'node:test';
import assert from 'node:assert';
import { dryReplay, liveReplay, type LiveReplayContext } from '../../src/observability/replay';
import type { ExecutionTrace, TraceEvent } from '../../src/runtime/types';

function llm(spanId: string, ts: string, output: string): TraceEvent {
  return {
    spanId,
    parentSpanId: undefined,
    traceId: 't1',
    runId: 'r1',
    agentId: 'a1',
    type: 'llm_call',
    timestamp: ts,
    durationMs: 100,
    data: {
      output,
      modelInfo: { provider: 'openai', model: 'gpt-4o' },
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    },
  };
}

function tool(
  spanId: string,
  parent: string,
  ts: string,
  name: string,
  output: unknown,
): TraceEvent {
  return {
    spanId,
    parentSpanId: parent,
    traceId: 't1',
    runId: 'r1',
    agentId: 'a1',
    type: 'tool_execution',
    timestamp: ts,
    durationMs: 50,
    data: { input: name, output },
  };
}

describe('dryReplay', () => {
  it('produces same-node diff when no substitutions applied', () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [llm('s1', '2026-06-05T00:00:00.000Z', 'hi')],
      summary: {
        totalEvents: 1,
        totalDurationMs: 100,
        totalTokens: 150,
        llmCalls: 1,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    const r = dryReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: false });
    assert.strictEqual(r.diff.newSpans, 0);
    assert.strictEqual(r.diff.changedSpans, 0);
    assert.strictEqual(r.diff.costDeltaUsd, 0);
  });

  it('substitutes tool_output and reports changedSpans', () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [tool('s1', undefined, '2026-06-05T00:00:00.000Z', 'shell', { exit: 0 })],
      summary: {
        totalEvents: 1,
        totalDurationMs: 50,
        totalTokens: 0,
        llmCalls: 0,
        toolExecutions: 1,
        errors: 0,
        modelUsed: '',
      },
    };
    const r = dryReplay(trace, {
      runId: 'r1',
      substitutions: [
        { target: 'tool_output', spanId: 's1', value: { exit: 1, stderr: 'failed' } },
      ],
      reExecuteLlm: false,
    });
    assert.strictEqual(r.diff.changedSpans, 1);
    assert.ok(r.replayedNodes[0]!.toolOutputPreview?.includes('"exit":1'));
  });

  it('substitutes llm_response', () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [llm('s1', '2026-06-05T00:00:00.000Z', 'original')],
      summary: {
        totalEvents: 1,
        totalDurationMs: 100,
        totalTokens: 150,
        llmCalls: 1,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    const r = dryReplay(trace, {
      runId: 'r1',
      substitutions: [
        { target: 'llm_response', spanId: 's1', value: 'replayed-with-different-prompt' },
      ],
      reExecuteLlm: true,
    });
    assert.strictEqual(r.diff.changedSpans, 1);
    assert.ok(r.replayedNodes[0]!.reasoning?.includes('replayed'));
  });
});

describe('liveReplay', () => {
  it('returns mode=dry when reExecuteLlm is false (no LLM re-execution)', async () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [llm('s1', '2026-06-05T00:00:00.000Z', 'hi')],
      summary: {
        totalEvents: 1,
        totalDurationMs: 100,
        totalTokens: 150,
        llmCalls: 1,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    let invoked = false;
    const ctx: LiveReplayContext = {
      invokeLlm: async () => {
        invoked = true;
        return {
          text: 'x',
          tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          costUsd: 0,
        };
      },
    };
    const r = await liveReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: false }, ctx);
    assert.strictEqual(r.mode, 'dry');
    assert.strictEqual(invoked, false);
    assert.deepStrictEqual(r.reExecutedSpans, []);
  });

  it('re-executes LLM spans and reports mode=live + reExecutedSpans', async () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [llm('s1', '2026-06-05T00:00:00.000Z', 'original')],
      summary: {
        totalEvents: 1,
        totalDurationMs: 100,
        totalTokens: 150,
        llmCalls: 1,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    const ctx: LiveReplayContext = {
      invokeLlm: async ({ model }) => ({
        text: `replayed with ${model}`,
        tokens: { promptTokens: 80, completionTokens: 30, totalTokens: 110 },
        costUsd: 0.001,
      }),
    };
    const r = await liveReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: true }, ctx);
    assert.strictEqual(r.mode, 'live');
    assert.deepStrictEqual(r.reExecutedSpans, ['s1']);
    assert.ok(r.replayedNodes[0]!.reasoning?.includes('gpt-4o'));
    assert.strictEqual(r.replayedNodes[0]!.tokens?.total, 110);
    assert.strictEqual(r.replayedNodes[0]!.cost?.totalCostUsd, 0.001);
  });

  it('respects modelOverride for re-execution', async () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [llm('s1', '2026-06-05T00:00:00.000Z', 'hi')],
      summary: {
        totalEvents: 1,
        totalDurationMs: 100,
        totalTokens: 150,
        llmCalls: 1,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    let receivedModel = '';
    const ctx: LiveReplayContext = {
      invokeLlm: async ({ model }) => {
        receivedModel = model;
        return {
          text: 'x',
          tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          costUsd: 0,
        };
      },
    };
    await liveReplay(
      trace,
      { runId: 'r1', substitutions: [], reExecuteLlm: true, modelOverride: 'claude-3-5-sonnet' },
      ctx,
      { modelOverride: 'claude-3-5-sonnet' },
    );
    assert.strictEqual(receivedModel, 'claude-3-5-sonnet');
  });

  it('falls back to dry node on LLM invocation failure', async () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [llm('s1', '2026-06-05T00:00:00.000Z', 'original')],
      summary: {
        totalEvents: 1,
        totalDurationMs: 100,
        totalTokens: 150,
        llmCalls: 1,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    const ctx: LiveReplayContext = {
      invokeLlm: async () => {
        throw new Error('provider down');
      },
    };
    const r = await liveReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: true }, ctx);
    assert.strictEqual(r.reExecutedSpans.length, 0);
    assert.strictEqual(r.replayedNodes.length, 1);
  });

  it('respects onlySpanIds filter', async () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [
        llm('s1', '2026-06-05T00:00:00.000Z', 'first'),
        llm('s2', '2026-06-05T00:00:01.000Z', 'second'),
      ],
      summary: {
        totalEvents: 2,
        totalDurationMs: 200,
        totalTokens: 300,
        llmCalls: 2,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    const ctx: LiveReplayContext = {
      invokeLlm: async ({ spanId }) => ({
        text: `ok-${spanId}`,
        tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        costUsd: 0,
      }),
    };
    const r = await liveReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: true }, ctx, {
      onlySpanIds: ['s2'],
    });
    assert.deepStrictEqual(r.reExecutedSpans, ['s2']);
  });
});

// ============================================================================
// E2E: Full end-to-end liveReplay scenarios
// ============================================================================

describe('liveReplay E2E', () => {
  it('E2E: multi-step trace with interleaved LLM and TOOL — only LLMs re-executed', async () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [
        llm('llm1', '2026-06-05T00:00:00.000Z', 'I will read a file'),
        tool('tool1', 'llm1', '2026-06-05T00:00:01.000Z', 'read_file', {
          path: '/a.txt',
          content: 'hello',
        }),
        llm('llm2', '2026-06-05T00:00:02.000Z', 'I will write a file'),
        tool('tool2', 'llm2', '2026-06-05T00:00:03.000Z', 'write_file', { path: '/b.txt' }),
        llm('llm3', '2026-06-05T00:00:04.000Z', 'Done'),
      ],
      summary: {
        totalEvents: 5,
        totalDurationMs: 500,
        totalTokens: 450,
        llmCalls: 3,
        toolExecutions: 2,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    const invokedSpans: string[] = [];
    const ctx: LiveReplayContext = {
      invokeLlm: async ({ spanId }) => {
        invokedSpans.push(spanId);
        return {
          text: `replayed-${spanId}`,
          tokens: { promptTokens: 40, completionTokens: 10, totalTokens: 50 },
          costUsd: 0.0005,
        };
      },
    };
    const r = await liveReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: true }, ctx);

    // Only LLM spans re-executed
    assert.deepStrictEqual(r.reExecutedSpans.sort(), ['llm1', 'llm2', 'llm3']);
    assert.deepStrictEqual(invokedSpans.sort(), ['llm1', 'llm2', 'llm3']);

    // All 5 nodes preserved
    assert.strictEqual(r.replayedNodes.length, 5);

    // TOOL nodes unchanged
    const toolNodes = r.replayedNodes.filter((n) => n.type === 'TOOL');
    assert.strictEqual(toolNodes.length, 2);
    assert.ok(toolNodes[0]!.toolInputPreview?.includes('read_file'));
    assert.ok(toolNodes[1]!.toolInputPreview?.includes('write_file'));

    // LLM nodes have new text and costs
    const llmNodes = r.replayedNodes.filter((n) => n.type === 'LLM');
    assert.strictEqual(llmNodes.length, 3);
    for (const n of llmNodes) {
      assert.ok(n.reasoning?.startsWith('replayed-'));
      assert.strictEqual(n.cost?.totalCostUsd, 0.0005);
      assert.strictEqual(n.tokens?.total, 50);
    }
  });

  it('E2E: costDelta reflects replayed LLM costs vs original costs', async () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [
        llm('s1', '2026-06-05T00:00:00.000Z', 'first'),
        llm('s2', '2026-06-05T00:00:01.000Z', 'second'),
      ],
      summary: {
        totalEvents: 2,
        totalDurationMs: 200,
        totalTokens: 300,
        llmCalls: 2,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    // Original costs from the cost model for gpt-4o with promptTokens=100, completionTokens=50, totalTokens=150
    // Replayed costs: 0.003 per LLM, total 0.006
    const ctx: LiveReplayContext = {
      invokeLlm: async ({ spanId }) => ({
        text: `replayed-${spanId}`,
        tokens: { promptTokens: 80, completionTokens: 20, totalTokens: 100 },
        costUsd: spanId === 's1' ? 0.003 : 0.005,
      }),
    };
    const r = await liveReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: true }, ctx);

    assert.strictEqual(r.mode, 'live');
    assert.deepStrictEqual(r.reExecutedSpans.sort(), ['s1', 's2']);

    // Replay summary should reflect the new costs
    assert.strictEqual(r.replaySummary.totalCost.totalCostUsd, 0.008); // 0.003 + 0.005
    assert.strictEqual(r.replaySummary.totalTokens.total, 200); // 100 + 100

    // costDelta = replayCost - originalCost
    // originalCost is computed by the cost model from the original trace events (gpt-4o pricing)
    // Replay cost = 0.008, original cost ≈ 0.0015, so costDelta should be positive and roughly 0.0065
    assert.ok(typeof r.diff.costDeltaUsd === 'number');
    assert.ok(!Number.isNaN(r.diff.costDeltaUsd));
    assert.ok(r.diff.costDeltaUsd > 0, `expected positive costDelta, got ${r.diff.costDeltaUsd}`);
  });

  it('E2E: tokenDelta reflects replayed token counts', async () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [llm('s1', '2026-06-05T00:00:00.000Z', 'original')],
      summary: {
        totalEvents: 1,
        totalDurationMs: 100,
        totalTokens: 150,
        llmCalls: 1,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    const ctx: LiveReplayContext = {
      invokeLlm: async () => ({
        text: 'replayed',
        tokens: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
        costUsd: 0.001,
      }),
    };
    const r = await liveReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: true }, ctx);

    // Replay summary has the new tokens
    assert.strictEqual(r.replaySummary.totalTokens.total, 50);
    assert.strictEqual(r.replaySummary.totalTokens.input, 30);
    assert.strictEqual(r.replaySummary.totalTokens.output, 20);

    // tokenDelta = replayTokens - originalTokens
    assert.strictEqual(r.diff.tokenDelta, 50 - r.originalSummary.totalTokens.total);
  });

  it('E2E: modelOverride changes model field and triggers changedSpans', async () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [
        llm('s1', '2026-06-05T00:00:00.000Z', 'hi'),
        llm('s2', '2026-06-05T00:00:01.000Z', 'bye'),
      ],
      summary: {
        totalEvents: 2,
        totalDurationMs: 200,
        totalTokens: 300,
        llmCalls: 2,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    const ctx: LiveReplayContext = {
      invokeLlm: async ({ model }) => ({
        text: `replayed with ${model}`,
        tokens: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
        costUsd: 0.002,
      }),
    };
    const r = await liveReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: true }, ctx, {
      modelOverride: 'claude-3-opus',
    });

    assert.strictEqual(r.mode, 'live');
    assert.deepStrictEqual(r.reExecutedSpans.sort(), ['s1', 's2']);

    // Both spans should have the override model and original tokens/prompt used
    for (const n of r.replayedNodes.filter((x) => x.type === 'LLM')) {
      assert.strictEqual(n.model, 'claude-3-opus');
      assert.ok(n.reasoning?.includes('claude-3-opus'));
    }

    // changedSpans should be >= 2: both model changed AND reasoning changed
    assert.ok(r.diff.changedSpans >= 2);
  });

  it('E2E: substitutions applied alongside live re-execution', async () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [
        llm('llm1', '2026-06-05T00:00:00.000Z', 'I will call a tool'),
        tool('tool1', 'llm1', '2026-06-05T00:00:01.000Z', 'shell', { exit: 0 }),
        llm('llm2', '2026-06-05T00:00:02.000Z', 'Tool succeeded'),
      ],
      summary: {
        totalEvents: 3,
        totalDurationMs: 300,
        totalTokens: 300,
        llmCalls: 2,
        toolExecutions: 1,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    const ctx: LiveReplayContext = {
      invokeLlm: async ({ spanId }) => ({
        text: `replayed-${spanId}`,
        tokens: { promptTokens: 40, completionTokens: 10, totalTokens: 50 },
        costUsd: 0.001,
      }),
    };
    const r = await liveReplay(
      trace,
      {
        runId: 'r1',
        substitutions: [
          {
            target: 'tool_output',
            spanId: 'tool1',
            value: { exit: 1, stderr: 'simulated failure' },
          },
          { target: 'llm_response', spanId: 'llm2', value: 'Tool failed, retrying...' },
        ],
        reExecuteLlm: true,
      },
      ctx,
    );

    // LLM spans re-executed
    assert.deepStrictEqual(r.reExecutedSpans.sort(), ['llm1', 'llm2']);
    assert.strictEqual(r.mode, 'live');

    // Tool output substituted
    const toolNode = r.replayedNodes.find((n) => n.spanId === 'tool1');
    assert.ok(toolNode);
    assert.ok(toolNode!.toolOutputPreview?.includes('simulated failure'));

    // llm1: live re-executed (reasoning = 'replayed-llm1', not substitution)
    const llm1Node = r.replayedNodes.find((n) => n.spanId === 'llm1');
    assert.ok(llm1Node);
    assert.strictEqual(llm1Node!.reasoning, 'replayed-llm1');

    // llm2: live re-executed, then substitution overrides reasoning
    // (applySubstitution runs on the replayed result, and llm_response substitution wins)
    const llm2Node = r.replayedNodes.find((n) => n.spanId === 'llm2');
    assert.ok(llm2Node);
    assert.ok(llm2Node!.reasoning?.includes('Tool failed, retrying'));
  });

  it('E2E: AbortSignal prevents LLM invocation and falls back to dry nodes', async () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [
        llm('s1', '2026-06-05T00:00:00.000Z', 'first'),
        llm('s2', '2026-06-05T00:00:01.000Z', 'second'),
      ],
      summary: {
        totalEvents: 2,
        totalDurationMs: 200,
        totalTokens: 300,
        llmCalls: 2,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    let invoked = false;
    const controller = new AbortController();
    controller.abort(); // Abort immediately
    const ctx: LiveReplayContext = {
      invokeLlm: async () => {
        invoked = true;
        return {
          text: 'x',
          tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          costUsd: 0,
        };
      },
      signal: controller.signal,
    };
    const r = await liveReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: true }, ctx);

    // invokeLlm should never be called (signal already aborted)
    // The check: ctx.signal?.aborted throws before calling invokeLlm
    // But wait — reExecuteLlm is true and the first span triggers invokeLlm.
    // The signal check inside liveReplay: if (ctx.signal?.aborted) throw new Error('replay aborted');
    // That throws BEFORE invokeLlm for each span, so each span catches and uses dry node.
    assert.strictEqual(r.reExecutedSpans.length, 0);
    assert.strictEqual(r.replayedNodes.length, 2);
  });

  it('E2E: mixed trace where some LLM calls fail and others succeed', async () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [
        llm('s1', '2026-06-05T00:00:00.000Z', 'will fail'),
        llm('s2', '2026-06-05T00:00:01.000Z', 'will succeed'),
        llm('s3', '2026-06-05T00:00:02.000Z', 'will succeed too'),
      ],
      summary: {
        totalEvents: 3,
        totalDurationMs: 300,
        totalTokens: 450,
        llmCalls: 3,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    const ctx: LiveReplayContext = {
      invokeLlm: async ({ spanId }) => {
        if (spanId === 's1') throw new Error('provider down');
        return {
          text: `ok-${spanId}`,
          tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          costUsd: 0,
        };
      },
    };
    const r = await liveReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: true }, ctx);

    assert.strictEqual(r.mode, 'live');
    // Only s2 and s3 re-executed; s1 fell back to dry
    assert.deepStrictEqual(r.reExecutedSpans.sort(), ['s2', 's3']);

    // s1 keeps original reasoning
    const s1Node = r.replayedNodes.find((n) => n.spanId === 's1');
    assert.ok(s1Node);
    assert.ok(s1Node!.reasoning?.includes('will fail'));

    // s2 and s3 have new reasoning
    for (const spanId of ['s2', 's3']) {
      const node = r.replayedNodes.find((n) => n.spanId === spanId);
      assert.ok(node);
      assert.strictEqual(node!.reasoning, `ok-${spanId}`);
    }
  });

  it('E2E: full agent execution trace simulation — LLM→tool→LLM→tool→LLM', async () => {
    const trace: ExecutionTrace = {
      runId: 'r-full',
      traceId: 't-full',
      agentId: 'agent-1',
      startedAt: '2026-06-05T00:00:00.000Z',
      completedAt: '2026-06-05T00:00:05.000Z',
      events: [
        llm('plan', '2026-06-05T00:00:00.000Z', 'I will read config then write code'),
        tool('read', 'plan', '2026-06-05T00:00:01.000Z', 'read_file', {
          path: 'tsconfig.json',
          content: '{"strict":true}',
        }),
        llm('code', '2026-06-05T00:00:02.000Z', 'I will write the implementation'),
        tool('write', 'code', '2026-06-05T00:00:03.000Z', 'write_file', {
          path: 'src/app.ts',
          success: true,
        }),
        llm('verify', '2026-06-05T00:00:04.000Z', 'Code written successfully'),
      ],
      summary: {
        totalEvents: 5,
        totalDurationMs: 5000,
        totalTokens: 450,
        llmCalls: 3,
        toolExecutions: 2,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };

    const callLog: Array<{ spanId: string; model: string; prompt: string }> = [];
    const ctx: LiveReplayContext = {
      invokeLlm: async (args) => {
        callLog.push({ spanId: args.spanId, model: args.model, prompt: args.prompt });
        // Simulate different costs per phase
        const costs: Record<string, number> = { plan: 0.003, code: 0.005, verify: 0.002 };
        return {
          text: `[REPLAYED] ${args.model}: analysis for span ${args.spanId}`,
          tokens: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
          costUsd: costs[args.spanId] ?? 0.001,
        };
      },
    };

    const r = await liveReplay(
      trace,
      { runId: 'r-full', substitutions: [], reExecuteLlm: true },
      ctx,
      {
        modelOverride: 'claude-3-5-sonnet',
      },
    );

    // All 3 LLM spans re-executed
    assert.deepStrictEqual(r.reExecutedSpans.sort(), ['code', 'plan', 'verify']);
    assert.strictEqual(r.mode, 'live');

    // All 3 LLM calls received modelOverride
    assert.strictEqual(callLog.length, 3);
    for (const log of callLog) {
      assert.strictEqual(log.model, 'claude-3-5-sonnet');
    }

    // 5 total nodes preserved
    assert.strictEqual(r.replayedNodes.length, 5);

    // TOOL nodes untouched
    const toolNodes = r.replayedNodes.filter((n) => n.type === 'TOOL');
    assert.strictEqual(toolNodes.length, 2);

    // Replay summary reflects 3 LLM re-executions at the given costs
    assert.strictEqual(r.replaySummary.llmCalls, 3);
    assert.strictEqual(r.replaySummary.toolCalls, 2);
    // Total cost: 0.003 + 0.005 + 0.002 = 0.010
    assert.strictEqual(r.replaySummary.totalCost.totalCostUsd, 0.01);
    // Total tokens: 150 × 3 = 450
    assert.strictEqual(r.replaySummary.totalTokens.total, 450);

    // changedSpans: all 3 LLM spans changed (model + reasoning), TOOL spans unchanged
    assert.strictEqual(r.diff.changedSpans, 3);
    assert.strictEqual(r.diff.newSpans, 0);

    // costDelta is defined and non-NaN
    assert.ok(typeof r.diff.costDeltaUsd === 'number');
    assert.ok(!Number.isNaN(r.diff.costDeltaUsd));
    // tokenDelta is defined
    assert.ok(typeof r.diff.tokenDelta === 'number');
    assert.ok(!Number.isNaN(r.diff.tokenDelta));
  });

  it('E2E: diff structure has expected keys', () => {
    // Verify diff object shape to catch regressions
    const expectedKeys = ['newSpans', 'changedSpans', 'costDeltaUsd', 'tokenDelta'];
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [llm('s1', '2026-06-05T00:00:00.000Z', 'hi')],
      summary: {
        totalEvents: 1,
        totalDurationMs: 100,
        totalTokens: 150,
        llmCalls: 1,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    const r = dryReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: false });
    assert.deepStrictEqual(Object.keys(r.diff).sort(), expectedKeys.sort());
  });

  it('E2E: empty trace returns dry result with no re-executed spans', async () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [],
      summary: {
        totalEvents: 0,
        totalDurationMs: 0,
        totalTokens: 0,
        llmCalls: 0,
        toolExecutions: 0,
        errors: 0,
        modelUsed: '',
      },
    };
    let invoked = false;
    const ctx: LiveReplayContext = {
      invokeLlm: async () => {
        invoked = true;
        return {
          text: '',
          tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          costUsd: 0,
        };
      },
    };
    const r = await liveReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: true }, ctx);
    assert.strictEqual(r.mode, 'live');
    assert.strictEqual(invoked, false);
    assert.deepStrictEqual(r.reExecutedSpans, []);
    assert.strictEqual(r.replayedNodes.length, 0);
    assert.strictEqual(r.diff.costDeltaUsd, 0);
    assert.strictEqual(r.diff.tokenDelta, 0);
  });

  it('E2E: originalTokens passed to invokeLlm match trace event token counts', async () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [llm('s1', '2026-06-05T00:00:00.000Z', 'output')],
      summary: {
        totalEvents: 1,
        totalDurationMs: 100,
        totalTokens: 150,
        llmCalls: 1,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    let capturedTokens: { promptTokens: number; completionTokens: number; totalTokens: number } = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const ctx: LiveReplayContext = {
      invokeLlm: async ({ originalTokens }) => {
        capturedTokens = originalTokens;
        return {
          text: 'ok',
          tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          costUsd: 0,
        };
      },
    };
    await liveReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: true }, ctx);

    // Original trace event had promptTokens=100, completionTokens=50, totalTokens=150
    assert.strictEqual(capturedTokens.promptTokens, 100);
    assert.strictEqual(capturedTokens.completionTokens, 50);
    assert.strictEqual(capturedTokens.totalTokens, 150);
  });

  it('E2E: prompt passed to invokeLlm comes from node reasoning preview', async () => {
    const trace: ExecutionTrace = {
      runId: 'r1',
      traceId: 't1',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [llm('s1', '2026-06-05T00:00:00.000Z', 'The plan is to refactor the module')],
      summary: {
        totalEvents: 1,
        totalDurationMs: 100,
        totalTokens: 150,
        llmCalls: 1,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };
    let capturedPrompt = '';
    const ctx: LiveReplayContext = {
      invokeLlm: async ({ prompt }) => {
        capturedPrompt = prompt;
        return {
          text: 'ok',
          tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          costUsd: 0,
        };
      },
    };
    await liveReplay(trace, { runId: 'r1', substitutions: [], reExecuteLlm: true }, ctx);

    assert.ok(
      capturedPrompt.includes('refactor'),
      `Expected prompt to contain original reasoning, got: ${capturedPrompt}`,
    );
  });

  it('E2E: noProgress/maxSteps type scenarios — consecutive LLM calls with escalating costs', async () => {
    // Simulates an agent stuck in a loop: 5 consecutive LLM calls, each more expensive
    const trace: ExecutionTrace = {
      runId: 'r-loop',
      traceId: 't-loop',
      agentId: 'a1',
      startedAt: '2026-06-05T00:00:00.000Z',
      events: [
        llm('llm1', '2026-06-05T00:00:00.000Z', 'Attempt 1: Try reading the file'),
        llm('llm2', '2026-06-05T00:00:01.000Z', 'Attempt 2: File not found, retrying'),
        llm(
          'llm3',
          '2026-06-05T00:00:02.000Z',
          'Attempt 3: Still cannot access, trying different path',
        ),
        llm('llm4', '2026-06-05T00:00:03.000Z', 'Attempt 4: Asking user for clarification'),
        llm('llm5', '2026-06-05T00:00:04.000Z', 'Attempt 5: Giving up'),
      ],
      summary: {
        totalEvents: 5,
        totalDurationMs: 500,
        totalTokens: 750,
        llmCalls: 5,
        toolExecutions: 0,
        errors: 0,
        modelUsed: 'gpt-4o',
      },
    };

    const replayedCosts: number[] = [];
    const ctx: LiveReplayContext = {
      invokeLlm: async ({ spanId }) => {
        // Simulate escalating costs for each retry
        const attemptNum = parseInt(spanId.replace('llm', ''), 10);
        const cost = attemptNum * 0.002;
        replayedCosts.push(cost);
        return {
          text: `Replayed ${spanId}`,
          tokens: {
            promptTokens: 50 * attemptNum,
            completionTokens: 10,
            totalTokens: 50 * attemptNum + 10,
          },
          costUsd: cost,
        };
      },
    };

    const r = await liveReplay(
      trace,
      { runId: 'r-loop', substitutions: [], reExecuteLlm: true },
      ctx,
    );

    assert.strictEqual(r.mode, 'live');
    assert.strictEqual(r.reExecutedSpans.length, 5);

    // Total cost: 0.002 + 0.004 + 0.006 + 0.008 + 0.010 = 0.030
    assert.strictEqual(r.replaySummary.totalCost.totalCostUsd, 0.03);

    // Total tokens: (50+10) + (100+10) + (150+10) + (200+10) + (250+10) = 60+110+160+210+260 = 800
    assert.strictEqual(r.replaySummary.totalTokens.total, 800);

    // All costs recorded in order
    assert.strictEqual(replayedCosts.length, 5);
  });
});
