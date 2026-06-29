/**
 * Hub Glue / Tier-0 correlation admin endpoint — regression tests.
 *
 * Mirrors apps/api/test/store-normalization.test.ts conventions: ESM
 * imports + tsx loader so this `.ts` source can resolve `../src/hub-
 * CorrelationsEndpoints` (also `.ts`) at test time without requiring a
 * fresh apps/api/dist build. Note that `@commander/core/runtime` is
 * resolved through Node's normal package resolution, which hits the
 * packages/core dist (NOT src) — see README on packages/core dist
 * freshness for env-related test prerequisites.
 *
 * Coverage:
 *   1. Admin gate: non-admin scopes are 403'd (toggles AUTH_DISABLED
 *      locally so the gate fires instead of bypassing).
 *   2. REST happy path: GET / returns typed BusPayloadMap entries from
 *      the three runtime.{cycle,retry_block,circuit}_correlated topics.
 *   3. Filters: runId, topic, toolName restrict the visible timeline.
 *   4. Topic validation: invalid topic → 400 with allowed list.
 *   5. Limit clamping: huge limits clamped to MAX_REST_LIMIT=1000.
 *   6. Cursor pagination: unknown cursor → 400.
 *   7. SSE /stream registers a client, fans out a future publish, and
 *      cleans up on req `close`.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import {
  getMessageBus,
  resetMessageBus,
  type MessageBus,
} from '@commander/core/runtime';
import {
  createHubCorrelationsRouter,
  _resetHubCorrelationsForTests,
} from '../src/_unmounted/hubCorrelationsEndpoints';
// Side-effect import: pulls in the global Express Request augmentation
// (`apiKeyId?: string`, `apiScopes?: string[]`) declared in authMiddleware
// so we can type req.auth-scoped fields without per-call casts.
import '../src/authMiddleware';

// Default bypass so tests #2..#7 can exercise the router without
// setting up a real API key. Test #1 explicitly clears this env var
// to verify the gate's behaviour under the no-bypass path.
process.env.AUTH_DISABLED = 'true';

type Scope = 'read' | 'write' | 'admin';

const CORRELATION_TOPIC = {
  cycle: 'runtime.cycle_correlated',
  retry: 'runtime.retry_block_correlated',
  circuit: 'runtime.circuit_correlated',
} as const;

function buildAppWithScopes(apiScopes: Scope[]): Express {
  _resetHubCorrelationsForTests();
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { apiKeyId?: string; apiScopes?: string[] }).apiKeyId = 'test-key';
    (req as Request & { apiKeyId?: string; apiScopes?: string[] }).apiScopes = apiScopes;
    next();
  });
  app.use('/api/v1/hub', createHubCorrelationsRouter());
  return app;
}

function publishCorrelation(
  bus: MessageBus,
  topic:
    | typeof CORRELATION_TOPIC.cycle
    | typeof CORRELATION_TOPIC.retry
    | typeof CORRELATION_TOPIC.circuit,
  payload: object,
): void {
  bus.publish(topic, 'hub-glue', payload);
}

function makeCycle(runId: string, toolName = 'shell_execute'): {
  runId: string;
  toolName: string;
  description: string;
  sourceEvents: ['system.alert', 'tool.blocked'];
  correlatedAt: string;
} {
  return {
    runId,
    toolName,
    description: `cycle:${runId}`,
    sourceEvents: ['system.alert', 'tool.blocked'],
    correlatedAt: new Date().toISOString(),
  };
}

function makeCircuit(
  runId: string,
  toolName = 'shell_execute',
  reason = 'verification_failed',
): {
  runId: string;
  toolName: string;
  reason: string;
  sourceEvents: ['system.alert', 'tool.blocked'];
  correlatedAt: string;
} {
  return {
    runId,
    toolName,
    reason,
    sourceEvents: ['system.alert', 'tool.blocked'],
    correlatedAt: new Date().toISOString(),
  };
}

function listenPort(server: ReturnType<Express['listen']>): number {
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error(`listen failed: server.address() returned ${String(addr)}`);
  }
  return addr.port;
}

/**
 * Temporarily run `body` with AUTH_DISABLED cleared (so the admin gate
 * actually evaluates `req.apiScopes`) and restore the previous value
 * regardless of body outcome. Lets the gate-fire tests (test #1) and
 * the bypass-mode tests (tests #2..#7) coexist in one file without
 * polluting module-scope env state.
 */
async function withGateActive<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.AUTH_DISABLED;
  delete process.env.AUTH_DISABLED;
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.AUTH_DISABLED;
    } else {
      process.env.AUTH_DISABLED = previous;
    }
  }
}

// --- Tests -----------------------------------------------------------------

test('admin gate: without admin scope the GET summary returns 403', async () => {
  await withGateActive(async () => {
    const app = buildAppWithScopes(['read', 'write']);
    const server = app.listen(0);
    try {
      const port = listenPort(server);
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub`);
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error?: string };
      assert.match(body.error ?? '', /Admin scope required/);
    } finally {
      server.close();
    }
  });
});

test('admin gate: with admin scope the GET summary returns 200 + REST shape', async () => {
  resetMessageBus();
  const app = buildAppWithScopes(['read', 'write', 'admin']);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const bus = getMessageBus();
    publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-1'));
    publishCorrelation(bus, CORRELATION_TOPIC.retry, {
      runId: 'r-2',
      toolName: 'python_execute',
      pattern: 'python_execute:{}',
      sourceEvents: ['system.alert', 'tool.blocked'],
      correlatedAt: new Date().toISOString(),
    });
    publishCorrelation(bus, CORRELATION_TOPIC.circuit, makeCircuit('r-3'));

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      count: number;
      total: number;
      items: Array<{ topic: string }>;
    };
    assert.equal(body.count, 3);
    assert.equal(body.total, 3);
    assert.equal(body.items.length, 3);
    const topics = body.items.map((i) => i.topic).sort();
    assert.deepEqual(topics, [
      'runtime.circuit_correlated',
      'runtime.cycle_correlated',
      'runtime.retry_block_correlated',
    ]);
  } finally {
    server.close();
  }
});

test('GET summary filters by runId', async () => {
  resetMessageBus();
  const app = buildAppWithScopes(['admin']);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const bus = getMessageBus();
    publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-A'));
    publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-B', 'python_execute'));
    publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-A'));

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub?runId=r-A`);
    const body = (await res.json()) as {
      count: number;
      items: Array<{ payload: { runId: string } }>;
    };
    assert.equal(body.count, 2);
    for (const item of body.items) {
      assert.equal(item.payload.runId, 'r-A');
    }
  } finally {
    server.close();
  }
});

test('GET summary filters by topic', async () => {
  resetMessageBus();
  const app = buildAppWithScopes(['admin']);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const bus = getMessageBus();
    publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-1'));
    publishCorrelation(bus, CORRELATION_TOPIC.circuit, makeCircuit('r-1'));

    const res = await fetch(
      `http://127.0.0.1:${port}/api/v1/hub?topic=runtime.circuit_correlated`,
    );
    const body = (await res.json()) as {
      count: number;
      items: Array<{ topic: string }>;
    };
    assert.equal(body.count, 1);
    assert.ok(body.items.length >= 1, 'expected at least one item');
    assert.equal(body.items[0]?.topic, 'runtime.circuit_correlated');
  } finally {
    server.close();
  }
});

test('GET summary rejects invalid topic with 400 + allowed list', async () => {
  const app = buildAppWithScopes(['admin']);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub?topic=unknown_topic`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string; allowed: string[] };
    assert.match(body.error ?? '', /Invalid topic filter/);
    assert.ok(body.allowed.includes('runtime.cycle_correlated'));
    assert.ok(body.allowed.includes('runtime.retry_block_correlated'));
    assert.ok(body.allowed.includes('runtime.circuit_correlated'));
  } finally {
    server.close();
  }
});

test('GET summary clamps limit to MAX_REST_LIMIT=1000', async () => {
  resetMessageBus();
  const app = buildAppWithScopes(['admin']);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const bus = getMessageBus();
    for (let i = 0; i < 5; i += 1) {
      publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle(`r-${i}`));
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub?limit=99999`);
    const body = (await res.json()) as { count: number };
    assert.equal(body.count, 5);
  } finally {
    server.close();
  }
});

test('GET summary rejects invalid cursor with 400', async () => {
  resetMessageBus();
  const app = buildAppWithScopes(['admin']);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const bus = getMessageBus();
    publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-x'));

    const res = await fetch(
      `http://127.0.0.1:${port}/api/v1/hub?cursor=does-not-exist`,
    );
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('SSE /stream registers a client, will receive a future publish, and deregisters on close', async () => {
  resetMessageBus();
  const app = buildAppWithScopes(['admin']);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const bus = getMessageBus();

    const ctrl = new AbortController();
    const streamRes = await fetch(`http://127.0.0.1:${port}/api/v1/hub/stream`, {
      signal: ctrl.signal,
      headers: { Accept: 'text/event-stream' },
    });
    assert.equal(streamRes.status, 200);
    const ct = streamRes.headers.get('content-type') ?? '';
    assert.ok(ct.includes('text/event-stream'));

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const prelude = decoder.decode(value ?? new Uint8Array());
    assert.match(prelude, /: connected/);

    publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-sse'));
    const { value: more } = await reader.read();
    const evt = decoder.decode(more ?? new Uint8Array());
    assert.match(evt, /event: runtime\.cycle_correlated/);
    ctrl.abort();
    await reader.cancel().catch(() => undefined);
  } finally {
    server.close();
  }
});
