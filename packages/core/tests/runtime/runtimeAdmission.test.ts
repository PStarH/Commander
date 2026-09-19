import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  setAdmissionControlEnabled,
  acquireRuntimeAdmission,
  releaseRuntimeAdmission,
  canAdmitSchedulerWork,
} from '../../src/runtime/runtimeAdmission';
import {
  BackpressureController,
  setGlobalBackpressureController,
} from '../../src/runtime/backpressureController';
import {
  handleExecuteRoute,
  type HttpExecuteRouteDeps,
  type RuntimeSessionEntry,
} from '../../src/runtime/httpExecuteRoute';

function fakeRequest(payload: unknown): IncomingMessage {
  const req = Readable.from([JSON.stringify(payload)]);
  Object.assign(req, {
    method: 'POST',
    url: '/api/v1/execute',
    headers: { 'content-type': 'application/json' },
  });
  return req as unknown as IncomingMessage;
}

function fakeResponse(): ServerResponse {
  const res = {
    writableEnded: false,
    writeHead: () => res,
    end: () => {
      res.writableEnded = true;
    },
    setHeader: () => res,
  };
  return res as unknown as ServerResponse;
}

describe('runtimeAdmission', () => {
  beforeEach(() => {
    setAdmissionControlEnabled(true);
    setGlobalBackpressureController(
      new BackpressureController({
        maxTokens: 1,
        refillRatePerSecond: 0.01,
        bufferSize: 1,
        maxWaitMs: 1,
      }),
    );
  });

  it('rejects when token bucket is exhausted', async () => {
    expect(await acquireRuntimeAdmission('http_execute')).toBe(true);
    expect(await acquireRuntimeAdmission('http_execute')).toBe(false);
    releaseRuntimeAdmission();
    expect(await acquireRuntimeAdmission('http_execute')).toBe(true);
    releaseRuntimeAdmission();
  });

  it('canAdmitSchedulerWork probes without consuming tokens', async () => {
    expect(canAdmitSchedulerWork()).toBe(true);
    expect(await acquireRuntimeAdmission('http_execute')).toBe(true);
    expect(canAdmitSchedulerWork()).toBe(false);
    releaseRuntimeAdmission();
    expect(canAdmitSchedulerWork()).toBe(true);
  });

  // EH-02: the admission token acquired by POST /api/v1/execute was released
  // only by a `finally` that started around `execute()`, so a throwing runtime
  // factory leaked the slot permanently. With maxTokens=1 that turns every
  // later execute into a 503.
  it('releases the admission slot when runtime construction throws', async () => {
    expect(await acquireRuntimeAdmission('http_execute')).toBe(true);
    releaseRuntimeAdmission();

    let factoryCalls = 0;
    const deps: HttpExecuteRouteDeps = {
      maxBodyBytes: 4096,
      maxSessions: 10,
      runtimes: new Map<string, RuntimeSessionEntry>(),
      tenantApiKeyHashes: new Map<string, string>(),
      createRuntime: () => {
        factoryCalls += 1;
        throw new Error('runtime factory exploded');
      },
      evictStaleSessions: () => {},
      requireTenant: () => 'tenant-a',
    };

    await expect(
      handleExecuteRoute(fakeRequest({ prompt: 'hello' }), fakeResponse(), deps),
    ).rejects.toThrow('runtime factory exploded');
    expect(factoryCalls).toBe(1);

    // The slot must be back: this acquire only succeeds if the finally ran.
    expect(await acquireRuntimeAdmission('http_execute')).toBe(true);
    releaseRuntimeAdmission();
  });
});
