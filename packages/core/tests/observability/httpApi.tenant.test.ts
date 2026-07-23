import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage } from 'node:http';
import {
  handleObservabilityRequest,
  type ObservabilityDeps,
} from '../../src/observability/httpApi';
import { ExecutionTraceRecorder } from '../../src/runtime/executionTrace';
import { PersistentTraceStore } from '../../src/runtime/traceStore';

function makeReq(method: string, body?: unknown): IncomingMessage {
  const req = new Readable({ read() {} }) as IncomingMessage;
  req.method = method;
  if (body === undefined) {
    req.push(null);
  } else {
    req.push(JSON.stringify(body));
    req.push(null);
  }
  return req;
}

describe('observability trace tenant authorization', () => {
  let tmpDir: string;
  let deps: ObservabilityDeps;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-tenant-test-'));
    const traceStore = new PersistentTraceStore(tmpDir);
    const recorder = new ExecutionTraceRecorder(500, traceStore);
    deps = { recorder, traceStore, resolveTenant: () => 'tenant-a' };

    recorder.startRun('run-a', 'agent-a', undefined, 'trace-a', { tenantId: 'tenant-a' });
    recorder.startRun('run-b', 'agent-b', undefined, 'trace-b', { tenantId: 'tenant-b' });
    recorder.recordEvent('run-a', {
      type: 'llm_call',
      durationMs: 1,
      data: { output: 'tenant-a output' },
    });
    recorder.recordEvent('run-b', {
      type: 'llm_call',
      durationMs: 1,
      data: { output: 'tenant-b output' },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the owner trace and hides a foreign trace across direct and compare reads', async () => {
    const own = await handleObservabilityRequest(
      makeReq('GET'),
      deps,
      ['runs', 'run-a', 'timeline'],
      '',
    );
    assert.equal(own.status, 200);

    const foreign = await handleObservabilityRequest(
      makeReq('GET'),
      deps,
      ['runs', 'run-b', 'timeline'],
      '',
    );
    assert.equal(foreign.status, 404);

    const compare = await handleObservabilityRequest(
      makeReq('GET'),
      deps,
      ['compare', 'run-a', 'run-b'],
      '',
    );
    assert.equal(compare.status, 404);
  });

  it('rejects foreign feedback without mutation and accepts owner feedback', async () => {
    const foreignTrace = deps.recorder.getTrace('run-b');
    assert.ok(foreignTrace);
    const foreignEventCount = foreignTrace.events.length;

    const foreign = await handleObservabilityRequest(
      makeReq('POST', { rating: 'negative', comment: 'tamper' }),
      deps,
      ['runs', 'run-b', 'feedback'],
      '',
    );
    assert.equal(foreign.status, 404);
    assert.equal(foreignTrace.events.length, foreignEventCount);

    const own = await handleObservabilityRequest(
      makeReq('POST', { rating: 'positive', comment: 'legitimate' }),
      deps,
      ['runs', 'run-a', 'feedback'],
      '',
    );
    assert.equal(own.status, 200);
    assert.equal(deps.recorder.getTrace('run-a')?.events.length, 2);
  });

  it('reads a persisted owner trace through a tenant-scoped store', async () => {
    const tenantStore = new PersistentTraceStore(tmpDir, 'tenant-a');
    const writer = new ExecutionTraceRecorder(500, tenantStore);
    writer.startRun('run-persisted', 'agent-a', undefined, 'trace-persisted', {
      tenantId: 'tenant-a',
    });
    writer.recordEvent('run-persisted', {
      type: 'llm_call',
      durationMs: 1,
      data: { output: 'persisted tenant-a output' },
    });
    writer.completeRun('run-persisted');

    const observerDeps: ObservabilityDeps = {
      recorder: new ExecutionTraceRecorder(),
      traceStore: deps.traceStore,
      resolveTenant: () => 'tenant-a',
      resolveTraceStore: () => tenantStore,
    };
    const result = await handleObservabilityRequest(
      makeReq('GET'),
      observerDeps,
      ['runs', 'run-persisted', 'timeline'],
      '',
    );
    assert.equal(result.status, 200);
  });
});
