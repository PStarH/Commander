import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { Readable, Writable } from 'stream';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  handleObservabilityRequest,
  type ObservabilityDeps,
} from '../../src/observability/httpApi';
import { ExecutionTraceRecorder } from '../../src/runtime/executionTrace';
import { PersistentTraceStore } from '../../src/runtime/traceStore';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import type { LiveReplayContext } from '../../src/observability/replay';

class MockRes extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.body += chunk.toString('utf-8');
    cb();
  }
  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }
  end(chunk?: string | Buffer): this {
    if (chunk) this.body += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    return this;
  }
  json(): Record<string, unknown> {
    return JSON.parse(this.body || '{}');
  }
}

function makeReq(method: string, body?: unknown): IncomingMessage {
  const stream = new Readable({ read() {} });
  if (body !== undefined) {
    stream.push(JSON.stringify(body));
    stream.push(null);
  } else {
    stream.push(null);
  }
  (stream as IncomingMessage & { method: string }).method = method;
  return stream as IncomingMessage;
}

function makeDeps(tmpDir: string, tenantId: string | undefined): ObservabilityDeps {
  resetTraceRecorder();
  const store = new PersistentTraceStore(tmpDir, tenantId);
  const recorder = new ExecutionTraceRecorder(store);
  return {
    recorder,
    traceStore: store,
    resolveTenant: () => tenantId,
  };
}

async function dispatch(
  req: IncomingMessage,
  res: MockRes,
  deps: ObservabilityDeps,
  segments: string[],
  queryStr = '',
): Promise<MockRes> {
  await handleObservabilityRequest(req, res as unknown as ServerResponse, deps, segments, queryStr);
  return res;
}

describe('handleObservabilityRequest', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-test-'));
  });

  it('returns 404 for unknown segments', async () => {
    const deps = makeDeps(tmpDir, 't1');
    const res = await dispatch(makeReq('GET'), new MockRes(), deps, ['unknown']);
    assert.strictEqual(res.statusCode, 404);
  });

  it('returns 405 for POST /runs', async () => {
    const deps = makeDeps(tmpDir, 't1');
    const res = await dispatch(makeReq('POST'), new MockRes(), deps, ['runs']);
    assert.strictEqual(res.statusCode, 405);
  });

  it('returns 200 + empty list for fresh recorder', async () => {
    const deps = makeDeps(tmpDir, 't1');
    const res = await dispatch(makeReq('GET'), new MockRes(), deps, ['runs']);
    assert.strictEqual(res.statusCode, 200);
    const j = res.json();
    assert.strictEqual(j.count, 0);
  });

  it('returns 404 for missing run', async () => {
    const deps = makeDeps(tmpDir, 't1');
    const res = await dispatch(makeReq('GET'), new MockRes(), deps, [
      'runs',
      'no-such-run',
      'timeline',
    ]);
    assert.strictEqual(res.statusCode, 404);
  });

  it('returns timeline for known run', async () => {
    const deps = makeDeps(tmpDir, 't1');
    deps.recorder.startRun('r1', 'a1', undefined, 't1', { tenantId: 't1' });
    deps.recorder.recordEvent('r1', {
      type: 'llm_call',
      durationMs: 100,
      data: {
        modelInfo: { provider: 'openai', model: 'gpt-4o' },
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    });
    const res = await dispatch(makeReq('GET'), new MockRes(), deps, ['runs', 'r1', 'timeline']);
    assert.strictEqual(res.statusCode, 200);
    const j = res.json();
    assert.strictEqual(j.runId, 'r1');
    assert.strictEqual(j.nodes.length, 1);
    assert.strictEqual(j.nodes[0].type, 'LLM');
  });

  it('returns cost report with total > 0', async () => {
    const deps = makeDeps(tmpDir, 't1');
    deps.recorder.startRun('r1', 'a1', undefined, 't1', { tenantId: 't1' });
    deps.recorder.recordEvent('r1', {
      type: 'llm_call',
      durationMs: 100,
      data: {
        modelInfo: { provider: 'openai', model: 'gpt-4o' },
        tokenUsage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      },
    });
    const res = await dispatch(makeReq('GET'), new MockRes(), deps, ['runs', 'r1', 'cost']);
    assert.strictEqual(res.statusCode, 200);
    const j = res.json();
    assert.ok(j.total.totalCostUsd > 0);
    assert.strictEqual(j.byModel.length, 1);
  });

  it('returns decisions list', async () => {
    const deps = makeDeps(tmpDir, 't1');
    deps.recorder.startRun('r1', 'a1', undefined, 't1', { tenantId: 't1' });
    const llm = deps.recorder.recordEvent('r1', {
      type: 'llm_call',
      durationMs: 100,
      data: {
        output: { content: 'I will use web_search' },
        modelInfo: { provider: 'openai', model: 'gpt-4o' },
      },
    });
    deps.recorder.recordEvent('r1', {
      type: 'tool_execution',
      durationMs: 50,
      parentSpanId: llm.spanId,
      data: { input: 'web_search', output: { ok: true } },
    });
    const res = await dispatch(makeReq('GET'), new MockRes(), deps, ['runs', 'r1', 'decisions']);
    assert.strictEqual(res.statusCode, 200);
    const j = res.json();
    assert.strictEqual(j.decisions.length, 1);
    assert.strictEqual(j.decisions[0].toolName, 'web_search');
  });

  it('replay produces diff on substitution', async () => {
    const deps = makeDeps(tmpDir, 't1');
    deps.recorder.startRun('r1', 'a1', undefined, 't1', { tenantId: 't1' });
    const t = deps.recorder.recordEvent('r1', {
      type: 'tool_execution',
      durationMs: 50,
      data: { input: 'shell', output: { exit: 0 } },
    });
    const res = await dispatch(
      makeReq('POST', {
        runId: 'r1',
        substitutions: [{ target: 'tool_output', spanId: t.spanId, value: { exit: 1 } }],
        reExecuteLlm: false,
      }),
      new MockRes(),
      deps,
      ['runs', 'r1', 'replay'],
    );
    assert.strictEqual(res.statusCode, 200);
    const j = res.json();
    assert.strictEqual(j.diff.changedSpans, 1);
  });

  it('returns agent-scoped runs', async () => {
    const deps = makeDeps(tmpDir, 't1');
    deps.recorder.startRun('r1', 'a1', undefined, 't1', { tenantId: 't1' });
    deps.recorder.startRun('r2', 'a2', undefined, 't2', { tenantId: 't1' });
    const res = await dispatch(makeReq('GET'), new MockRes(), deps, ['agents', 'a1']);
    assert.strictEqual(res.statusCode, 200);
    const j = res.json();
    assert.strictEqual(j.count, 1);
    assert.strictEqual(j.runs[0].runId, 'r1');
  });

  it('filters by tenant', async () => {
    const deps = makeDeps(tmpDir, 't1');
    deps.recorder.startRun('r1', 'a1', undefined, 't1', { tenantId: 't1' });
    deps.recorder.startRun('r2', 'a2', undefined, 't2', { tenantId: 'OTHER' });
    const res = await dispatch(makeReq('GET'), new MockRes(), deps, ['runs']);
    const j = res.json();
    assert.strictEqual(j.count, 1);
  });

  // ============================================================================
  // Live replay integration: POST /runs/:id/replay with reExecuteLlm + modelOverride
  // ============================================================================

  it('live replay: POST /replay with reExecuteLlm=true + modelOverride returns mode=live, reExecutedSpans, and non-zero costDelta', async () => {
    // Build LiveReplayContext that simulates LLM re-execution with a cheaper model
    const invokedModels: string[] = [];
    const liveCtx: LiveReplayContext = {
      invokeLlm: async ({ spanId, model }) => {
        invokedModels.push(model);
        return {
          text: `[REPLAYED by ${model}] span=${spanId}`,
          tokens: { promptTokens: 80, completionTokens: 20, totalTokens: 100 },
          costUsd: 0.004, // different from original gpt-4o cost
        };
      },
    };

    // Create deps with the liveReplayContext wired in
    const deps: ObservabilityDeps = {
      ...makeDeps(tmpDir, 't1'),
      liveReplayContext: liveCtx,
    };

    // Create a realistic multi-step trace with LLM and tool events
    deps.recorder.startRun('r-live', 'agent-1', undefined, 't-live', { tenantId: 't1' });
    const llm1 = deps.recorder.recordEvent('r-live', {
      type: 'llm_call',
      durationMs: 100,
      data: {
        output: 'I will read the config file',
        modelInfo: { provider: 'openai', model: 'gpt-4o' },
        tokenUsage: { promptTokens: 200, completionTokens: 50, totalTokens: 250 },
      },
    });
    deps.recorder.recordEvent('r-live', {
      type: 'tool_execution',
      durationMs: 50,
      parentSpanId: llm1.spanId,
      data: { input: 'read_file', output: { path: 'config.json', content: '{}' } },
    });
    const llm2 = deps.recorder.recordEvent('r-live', {
      type: 'llm_call',
      durationMs: 100,
      data: {
        output: 'Config loaded, writing implementation',
        modelInfo: { provider: 'openai', model: 'gpt-4o' },
        tokenUsage: { promptTokens: 150, completionTokens: 60, totalTokens: 210 },
      },
    });
    deps.recorder.recordEvent('r-live', {
      type: 'tool_execution',
      durationMs: 50,
      parentSpanId: llm2.spanId,
      data: { input: 'write_file', output: { path: 'src/main.ts', success: true } },
    });
    deps.recorder.recordEvent('r-live', {
      type: 'llm_call',
      durationMs: 100,
      data: {
        output: 'Implementation complete',
        modelInfo: { provider: 'openai', model: 'gpt-4o' },
        tokenUsage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
      },
    });

    // POST to /replay with reExecuteLlm and modelOverride
    const body = {
      runId: 'r-live',
      substitutions: [],
      reExecuteLlm: true,
      modelOverride: 'claude-3-opus',
    };
    const res = await dispatch(makeReq('POST', body), new MockRes(), deps, [
      'runs',
      'r-live',
      'replay',
    ]);

    // Verify HTTP response
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const j = res.json();

    // Live replay mode
    assert.strictEqual(j.mode, 'live', `expected mode=live, got ${j.mode}`);

    // All 3 LLM spans re-executed (tool spans skipped)
    assert.ok(Array.isArray(j.reExecutedSpans), 'reExecutedSpans should be an array');
    assert.strictEqual(
      j.reExecutedSpans.length,
      3,
      `expected 3 reExecutedSpans, got ${j.reExecutedSpans?.length}`,
    );
    // The span IDs match the LLM calls we recorded
    const reExecutedIds: string[] = j.reExecutedSpans;
    assert.ok(reExecutedIds.includes(llm1.spanId), `missing ${llm1.spanId}`);
    assert.ok(reExecutedIds.includes(llm2.spanId), `missing ${llm2.spanId}`);

    // All LLM invocations received the modelOverride
    assert.strictEqual(
      invokedModels.length,
      3,
      `expected 3 invocations, got ${invokedModels.length}`,
    );
    for (const m of invokedModels) {
      assert.strictEqual(m, 'claude-3-opus');
    }

    // Replayed nodes: all 5 nodes preserved (3 LLM + 2 TOOL)
    assert.strictEqual(j.replayedNodes.length, 5);

    // LLM nodes have the override model and replayed costs
    const replayedLlmNodes = j.replayedNodes.filter((n: { type: string }) => n.type === 'LLM');
    assert.strictEqual(replayedLlmNodes.length, 3);
    for (const n of replayedLlmNodes) {
      assert.strictEqual(n.model, 'claude-3-opus', `expected model=claude-3-opus, got ${n.model}`);
      assert.ok(n.reasoning?.startsWith('[REPLAYED by claude-3-opus]'));
      assert.strictEqual(n.cost?.totalCostUsd, 0.004);
      assert.strictEqual(n.tokens?.total, 100);
    }

    // TOOL nodes unchanged
    const replayedToolNodes = j.replayedNodes.filter((n: { type: string }) => n.type === 'TOOL');
    assert.strictEqual(replayedToolNodes.length, 2);

    // Diff: changedSpans should reflect model + reasoning changes on all 3 LLM spans
    assert.ok(j.diff.changedSpans >= 3, `expected changedSpans >= 3, got ${j.diff.changedSpans}`);
    assert.strictEqual(j.diff.newSpans, 0);

    // costDelta should be non-zero (replay costs differ from original gpt-4o costs)
    assert.ok(typeof j.diff.costDeltaUsd === 'number');
    assert.ok(!Number.isNaN(j.diff.costDeltaUsd));
    assert.ok(j.diff.costDeltaUsd !== 0, `expected non-zero costDelta, got ${j.diff.costDeltaUsd}`);

    // tokenDelta should match the exact diff: replayTokens - originalTokens
    assert.ok(typeof j.diff.tokenDelta === 'number');
    assert.ok(!Number.isNaN(j.diff.tokenDelta));
    assert.strictEqual(
      j.diff.tokenDelta,
      300 - j.originalSummary.totalTokens.total,
      `expected tokenDelta = 300 - ${j.originalSummary.totalTokens.total}`,
    );
  });

  it('live replay: falls back to dry mode when reExecuteLlm=true but no liveReplayContext', async () => {
    // No liveCtx in deps
    const deps = makeDeps(tmpDir, 't1');
    deps.recorder.startRun('r-dry', 'a1', undefined, 't-dry', { tenantId: 't1' });
    deps.recorder.recordEvent('r-dry', {
      type: 'llm_call',
      durationMs: 100,
      data: {
        output: 'hello',
        modelInfo: { provider: 'openai', model: 'gpt-4o' },
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    });

    const body = {
      runId: 'r-dry',
      substitutions: [],
      reExecuteLlm: true, // true, but no liveCtx → falls back to dry
    };
    const res = await dispatch(makeReq('POST', body), new MockRes(), deps, [
      'runs',
      'r-dry',
      'replay',
    ]);

    assert.strictEqual(res.statusCode, 200);
    const j = res.json();
    // Should be a dry replay result (no mode or mode=dry)
    assert.ok(!j.mode || j.mode === 'dry', `expected no mode or dry, got ${j.mode}`);
    assert.ok(
      !j.reExecutedSpans || j.reExecutedSpans.length === 0,
      'should have no reExecutedSpans in dry mode',
    );
  });

  it('live replay: modelOverride from body wires through to invokeLlm', async () => {
    let receivedModel = '';
    const liveCtx: LiveReplayContext = {
      invokeLlm: async ({ model }) => {
        receivedModel = model;
        return {
          text: 'ok',
          tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          costUsd: 0,
        };
      },
    };
    const deps: ObservabilityDeps = {
      ...makeDeps(tmpDir, 't1'),
      liveReplayContext: liveCtx,
    };
    deps.recorder.startRun('r-mo', 'a1', undefined, 't-mo', { tenantId: 't1' });
    deps.recorder.recordEvent('r-mo', {
      type: 'llm_call',
      durationMs: 100,
      data: {
        output: 'hi',
        modelInfo: { provider: 'openai', model: 'gpt-3.5-turbo' },
        tokenUsage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
      },
    });

    const body = {
      runId: 'r-mo',
      substitutions: [],
      reExecuteLlm: true,
      modelOverride: 'gemini-2.5-pro',
    };
    const res = await dispatch(makeReq('POST', body), new MockRes(), deps, [
      'runs',
      'r-mo',
      'replay',
    ]);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      receivedModel,
      'gemini-2.5-pro',
      `expected gemini-2.5-pro, got ${receivedModel}`,
    );
    const j = res.json();
    assert.strictEqual(j.mode, 'live');
    assert.strictEqual(j.reExecutedSpans.length, 1);
  });

  it('live replay: returns 404 for unknown runId', async () => {
    const liveCtx: LiveReplayContext = {
      invokeLlm: async () => ({
        text: '',
        tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        costUsd: 0,
      }),
    };
    const deps: ObservabilityDeps = {
      ...makeDeps(tmpDir, 't1'),
      liveReplayContext: liveCtx,
    };
    const body = { runId: 'nonexistent', substitutions: [], reExecuteLlm: true };
    const res = await dispatch(makeReq('POST', body), new MockRes(), deps, [
      'runs',
      'nonexistent',
      'replay',
    ]);
    assert.strictEqual(res.statusCode, 404);
  });

  it('live replay: onlySpanIds from body wires through to liveReplay options', async () => {
    // When onlySpanIds is passed in the body, only those spans should be re-executed
    const invokedSpanIds: string[] = [];
    const liveCtx: LiveReplayContext = {
      invokeLlm: async ({ spanId }) => {
        invokedSpanIds.push(spanId);
        return {
          text: `ok-${spanId}`,
          tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          costUsd: 0,
        };
      },
    };
    const deps: ObservabilityDeps = {
      ...makeDeps(tmpDir, 't1'),
      liveReplayContext: liveCtx,
    };
    deps.recorder.startRun('r-only', 'a1', undefined, 't-only', { tenantId: 't1' });
    const s1 = deps.recorder.recordEvent('r-only', {
      type: 'llm_call',
      durationMs: 100,
      data: {
        output: 'first',
        modelInfo: { provider: 'openai', model: 'gpt-4o' },
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    });
    const s2 = deps.recorder.recordEvent('r-only', {
      type: 'llm_call',
      durationMs: 100,
      data: {
        output: 'second',
        modelInfo: { provider: 'openai', model: 'gpt-4o' },
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    });
    const s3 = deps.recorder.recordEvent('r-only', {
      type: 'llm_call',
      durationMs: 100,
      data: {
        output: 'third',
        modelInfo: { provider: 'openai', model: 'gpt-4o' },
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    });

    const body = {
      runId: 'r-only',
      substitutions: [],
      reExecuteLlm: true,
      onlySpanIds: [s1.spanId, s3.spanId], // only first and third
    };
    const res = await dispatch(makeReq('POST', body), new MockRes(), deps, [
      'runs',
      'r-only',
      'replay',
    ]);

    assert.strictEqual(res.statusCode, 200);
    const j = res.json();
    assert.strictEqual(j.mode, 'live');

    // Only s1 and s3 re-executed; s2 skipped
    assert.strictEqual(j.reExecutedSpans.length, 2);
    assert.deepStrictEqual(j.reExecutedSpans.sort(), [s1.spanId, s3.spanId].sort());
    assert.deepStrictEqual(invokedSpanIds.sort(), [s1.spanId, s3.spanId].sort());

    // s2 kept original reasoning (filtered out by onlySpanIds)
    const s2Node = j.replayedNodes.find((n: { spanId: string }) => n.spanId === s2.spanId);
    assert.ok(s2Node);
    assert.ok(s2Node.reasoning?.includes('second'));
  });

  it('live replay: substitutions combine with live execution in the full HTTP path', async () => {
    const liveCtx: LiveReplayContext = {
      invokeLlm: async ({ spanId }) => ({
        text: `live-replayed-${spanId}`,
        tokens: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
        costUsd: 0.001,
      }),
    };
    const deps: ObservabilityDeps = {
      ...makeDeps(tmpDir, 't1'),
      liveReplayContext: liveCtx,
    };
    deps.recorder.startRun('r-sub', 'a1', undefined, 't-sub', { tenantId: 't1' });
    const llmSpan = deps.recorder.recordEvent('r-sub', {
      type: 'llm_call',
      durationMs: 100,
      data: {
        output: 'original reasoning',
        modelInfo: { provider: 'openai', model: 'gpt-4o' },
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    });
    const toolSpan = deps.recorder.recordEvent('r-sub', {
      type: 'tool_execution',
      durationMs: 50,
      parentSpanId: llmSpan.spanId,
      data: { input: 'shell', output: { exit: 0 } },
    });

    const body = {
      runId: 'r-sub',
      substitutions: [
        {
          target: 'tool_output',
          spanId: toolSpan.spanId,
          value: { exit: 1, stderr: 'injected failure' },
        },
      ],
      reExecuteLlm: true,
      modelOverride: 'claude-3-haiku',
    };
    const res = await dispatch(makeReq('POST', body), new MockRes(), deps, [
      'runs',
      'r-sub',
      'replay',
    ]);

    assert.strictEqual(res.statusCode, 200);
    const j = res.json();
    assert.strictEqual(j.mode, 'live');
    assert.strictEqual(j.reExecutedSpans.length, 1);

    // LLM node: live re-executed with modelOverride
    const llmNode = j.replayedNodes.find((n: { spanId: string }) => n.spanId === llmSpan.spanId);
    assert.ok(llmNode);
    assert.strictEqual(llmNode.model, 'claude-3-haiku');
    assert.strictEqual(llmNode.reasoning, `live-replayed-${llmSpan.spanId}`);

    // TOOL node: substitution applied
    const toolNode = j.replayedNodes.find((n: { spanId: string }) => n.spanId === toolSpan.spanId);
    assert.ok(toolNode);
    assert.ok(toolNode.toolOutputPreview?.includes('injected failure'));
  });
});
