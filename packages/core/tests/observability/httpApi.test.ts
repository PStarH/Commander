import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { Readable, Writable } from 'stream';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { handleObservabilityRequest, type ObservabilityDeps } from '../../src/observability/httpApi';
import { ExecutionTraceRecorder } from '../../src/runtime/executionTrace';
import { PersistentTraceStore } from '../../src/runtime/traceStore';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';

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

async function dispatch(req: IncomingMessage, res: MockRes, deps: ObservabilityDeps, segments: string[], queryStr = ''): Promise<MockRes> {
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
    const res = await dispatch(makeReq('GET'), new MockRes(), deps, ['runs', 'no-such-run', 'timeline']);
    assert.strictEqual(res.statusCode, 404);
  });

  it('returns timeline for known run', async () => {
    const deps = makeDeps(tmpDir, 't1');
    deps.recorder.startRun('r1', 'a1', undefined, 't1', { tenantId: 't1' });
    deps.recorder.recordEvent('r1', {
      type: 'llm_call', durationMs: 100,
      data: { modelInfo: { provider: 'openai', model: 'gpt-4o' }, tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } },
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
      type: 'llm_call', durationMs: 100,
      data: { modelInfo: { provider: 'openai', model: 'gpt-4o' }, tokenUsage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 } },
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
      type: 'llm_call', durationMs: 100,
      data: { output: { content: 'I will use web_search' }, modelInfo: { provider: 'openai', model: 'gpt-4o' } },
    });
    deps.recorder.recordEvent('r1', {
      type: 'tool_execution', durationMs: 50, parentSpanId: llm.spanId,
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
      type: 'tool_execution', durationMs: 50,
      data: { input: 'shell', output: { exit: 0 } },
    });
    const res = await dispatch(
      makeReq('POST', { runId: 'r1', substitutions: [{ target: 'tool_output', spanId: t.spanId, value: { exit: 1 } }], reExecuteLlm: false }),
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
});
