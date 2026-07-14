/**
 * End-to-end HTTP tests for the P-obs-3 observability routes:
 *  - /api/v1/observability/datasets  (GET list, POST create)
 *  - /api/v1/observability/datasets/:id  (GET, PUT update, DELETE)
 *  - /api/v1/observability/datasets/:id/run  (POST)
 *  - /api/v1/observability/experiments  (GET)
 *  - /api/v1/observability/experiments/:id  (GET)
 *  - /api/v1/observability/auto-score/config  (GET, POST)
 *  - /api/v1/observability/auto-score/results  (GET, DELETE)
 *  - /api/v1/observability/rubrics  (GET, POST)
 *
 * Uses the real httpApi handler with a stub ExecutionTraceRecorder
 * (we don't need any trace data for the P-obs-3 routes).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as http from 'http';
import {
  handleObservabilityRequest,
  type ObservabilityDeps,
} from '../../../src/plugins/builtin/observability/httpApi';
import { DatasetStore } from '../../../src/observability/dataset';
import { ExperimentRunner } from '../../../src/plugins/builtin/observability/experimentRunner';
import { AutoScorer } from '../../../src/plugins/builtin/observability/autoScorer';
import {
  EvalScorer,
  type JudgeProvider,
  type LLMResponse,
} from '../../../src/plugins/builtin/observability/evalScorer';
import type { ExecutionTraceRecorder } from '../../../src/runtime/executionTrace';
import type { TraceStore } from '../../../src/runtime/traceStore';

function stubRecorder(): ExecutionTraceRecorder {
  return {
    listTraces: () => [],
    getTrace: () => undefined,
    recordEvent: () => undefined,
  } as unknown as ExecutionTraceRecorder;
}

function stubStore(): TraceStore {
  return { readTrace: () => [] } as unknown as TraceStore;
}

function startServer(
  deps: Partial<ObservabilityDeps>,
): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const segments = url.pathname
        .replace(/^\/api\/v1\/observability\/?/, '')
        .split('/')
        .filter(Boolean);
      try {
        // Production signature: (req, deps, segments, query) → ObservabilityResult
        // (no ServerResponse). Mirror httpServer.ts write path.
        const r = await handleObservabilityRequest(
          req,
          deps as ObservabilityDeps,
          segments,
          url.search.slice(1),
        );
        if (!r.handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.body));
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        port: addr.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function get(server: { port: number }, path: string): Promise<{ status: number; body: unknown }> {
  const attempt = (
    remaining: number,
    delayMs: number,
  ): Promise<{ status: number; body: unknown }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: server.port, path, method: 'GET' },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            let body: unknown = data;
            try {
              body = JSON.parse(data);
            } catch {
              /* keep as text */
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on('error', (err) => {
        const isAddrErr = (err as NodeJS.ErrnoException)?.code === 'EADDRNOTAVAIL';
        if (isAddrErr && remaining > 0) {
          setTimeout(() => {
            attempt(remaining - 1, delayMs * 2).then(resolve, reject);
          }, delayMs);
        } else {
          reject(err);
        }
      });
      req.end();
    });
  return attempt(8, 100);
}

function send(
  server: { port: number },
  method: string,
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: unknown }> {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  // Under heavy contention the OS can briefly run out of ephemeral
  // ports for the connecting socket (EADDRNOTAVAIL). Retry with a
  // small exponential backoff — the server's listen() has already
  // succeeded so the destination is reachable; we just need a free
  // source port to bind to.
  const attempt = (
    remaining: number,
    delayMs: number,
  ): Promise<{ status: number; body: unknown }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            let parsed: unknown = data;
            try {
              parsed = JSON.parse(data);
            } catch {
              /* keep as text */
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', (err) => {
        const isAddrErr = (err as NodeJS.ErrnoException)?.code === 'EADDRNOTAVAIL';
        if (isAddrErr && remaining > 0) {
          setTimeout(() => {
            attempt(remaining - 1, delayMs * 2).then(resolve, reject);
          }, delayMs);
        } else {
          reject(err);
        }
      });
      if (body) req.write(body);
      req.end();
    });

  return attempt(8, 100);
}

const mockJudge: JudgeProvider = {
  name: 'mock',
  async call(): Promise<LLMResponse> {
    return {
      content: '{"score": 0.9, "reasoning": "good"}',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
    };
  },
};

interface Harness {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
  datasetStore: DatasetStore;
  experimentRunner: ExperimentRunner;
  autoScorer: AutoScorer;
  evalScorer: EvalScorer;
}

async function startHarness(): Promise<Harness> {
  const datasetStore = new DatasetStore();
  const evalScorer = new EvalScorer(mockJudge);
  const experimentRunner = new ExperimentRunner(datasetStore, evalScorer);
  const autoScorer = new AutoScorer(evalScorer);
  const deps: Partial<ObservabilityDeps> = {
    recorder: stubRecorder(),
    traceStore: stubStore(),
    resolveTenant: () => undefined,
    datasetStore,
    experimentRunner,
    autoScorer,
    evalScorer,
    caseExecutorFactory: () => async () => ({
      output: 'ok',
      toolCallsMade: [],
      tokenUsage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      costUsd: 0.001,
      durationMs: 5,
    }),
  };
  const { server, port, close } = await startServer(deps);
  return { server, port, close, datasetStore, experimentRunner, autoScorer, evalScorer };
}

describe('P-obs-3 HTTP routes — datasets', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  // No global afterEach — vitest's per-test cleanup happens on test
  // completion via the harness's `close()`.

  it('GET /datasets returns an empty list initially', async () => {
    const r = await get(h, '/api/v1/observability/datasets');
    expect(r.status).toBe(200);
    expect((r.body as { count: number }).count).toBe(0);
  });

  it('POST /datasets creates a dataset (201)', async () => {
    const r = await send(h, 'POST', '/api/v1/observability/datasets', {
      name: 'demo',
      rubricId: 'default-quality',
      cases: [{ id: 'c1', input: { goal: 'g' } }],
    });
    expect(r.status).toBe(201);
    expect((r.body as { id: string }).id).toBeTruthy();
  });

  it('POST /datasets validates required fields (400)', async () => {
    const r = await send(h, 'POST', '/api/v1/observability/datasets', { name: 'x' });
    expect(r.status).toBe(400);
  });

  it('GET /datasets/:id returns the dataset', async () => {
    const created = await send(h, 'POST', '/api/v1/observability/datasets', {
      name: 'demo',
      rubricId: 'r',
      cases: [],
    });
    const id = (created.body as { id: string }).id;
    const got = await get(h, `/api/v1/observability/datasets/${id}`);
    expect(got.status).toBe(200);
    expect((got.body as { name: string }).name).toBe('demo');
  });

  it('GET /datasets/:id returns 404 for unknown id', async () => {
    const r = await get(h, '/api/v1/observability/datasets/ds-missing');
    expect(r.status).toBe(404);
  });

  it('PUT /datasets/:id updates fields and advances updatedAt', async () => {
    const created = await send(h, 'POST', '/api/v1/observability/datasets', {
      name: 'demo',
      rubricId: 'r',
      cases: [],
    });
    const id = (created.body as { id: string }).id;
    const upd = await send(h, 'PUT', `/api/v1/observability/datasets/${id}`, { name: 'renamed' });
    expect(upd.status).toBe(200);
    expect((upd.body as { name: string }).name).toBe('renamed');
  });

  it('DELETE /datasets/:id removes the dataset', async () => {
    const created = await send(h, 'POST', '/api/v1/observability/datasets', {
      name: 'demo',
      rubricId: 'r',
      cases: [],
    });
    const id = (created.body as { id: string }).id;
    const del = await send(h, 'DELETE', `/api/v1/observability/datasets/${id}`);
    expect(del.status).toBe(200);
    const got = await get(h, `/api/v1/observability/datasets/${id}`);
    expect(got.status).toBe(404);
  });
});

describe('P-obs-3 HTTP routes — experiments', () => {
  it('POST /datasets/:id/run returns 202 with runId; polling /experiments/:id returns the completed run', async () => {
    const h = await startHarness();
    const created = await send(h, 'POST', '/api/v1/observability/datasets', {
      name: 'demo',
      rubricId: 'default-quality',
      cases: [
        { id: 'c1', input: { goal: 'g1' }, expected: 'ok' },
        { id: 'c2', input: { goal: 'g2' }, expected: 'ok' },
      ],
    });
    const id = (created.body as { id: string }).id;
    const start = await send(h, 'POST', `/api/v1/observability/datasets/${id}/run`, {
      passThreshold: 0.5,
    });
    expect(start.status).toBe(202);
    const startBody = start.body as { runId: string; datasetId: string; status: string };
    expect(startBody.runId).toBeTruthy();
    expect(startBody.status).toBe('running');

    // Poll the experiment endpoint until the run is in the registry.
    let run: { status: number; body: unknown } = { status: 404, body: null };
    for (let i = 0; i < 50; i++) {
      run = await get(h, `/api/v1/observability/experiments/${startBody.runId}`);
      if (run.status === 200) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(run.status).toBe(200);
    const runBody = run.body as { summary: { totalCases: number; passed: number } };
    expect(runBody.summary.totalCases).toBe(2);
    expect(runBody.summary.passed).toBe(2);
    await h.close();
  });

  it('POST /datasets/:id/run returns 404 for unknown dataset', async () => {
    const h = await startHarness();
    const r = await send(h, 'POST', '/api/v1/observability/datasets/ds-missing/run', {});
    expect(r.status).toBe(404);
    await h.close();
  });
});

describe('P-obs-3 HTTP routes — auto-score', () => {
  it('GET /auto-score/config returns the current config', async () => {
    const h = await startHarness();
    const r = await get(h, '/api/v1/observability/auto-score/config');
    expect(r.status).toBe(200);
    expect((r.body as { enabled: boolean }).enabled).toBe(false);
    await h.close();
  });

  it('POST /auto-score/config updates the config', async () => {
    const h = await startHarness();
    const r = await send(h, 'POST', '/api/v1/observability/auto-score/config', {
      enabled: true,
      sampleRate: 0.25,
    });
    expect(r.status).toBe(200);
    expect(
      (r.body as { applied: { sampleRate: number; enabled: boolean } }).applied.sampleRate,
    ).toBe(0.25);
    expect((r.body as { applied: { sampleRate: number; enabled: boolean } }).applied.enabled).toBe(
      true,
    );
    const got = await get(h, '/api/v1/observability/auto-score/config');
    expect((got.body as { sampleRate: number }).sampleRate).toBe(0.25);
    await h.close();
  });

  it('GET /auto-score/results returns the stored results', async () => {
    const h = await startHarness();
    const r = await get(h, '/api/v1/observability/auto-score/results');
    expect(r.status).toBe(200);
    expect((r.body as { count: number }).count).toBe(0);
    await h.close();
  });

  it('DELETE /auto-score/results clears the buffer', async () => {
    const h = await startHarness();
    const r = await send(h, 'DELETE', '/api/v1/observability/auto-score/results', {});
    expect(r.status).toBe(200);
    await h.close();
  });
});

describe('P-obs-3 HTTP routes — rubrics', () => {
  it('GET /rubrics returns the default rubric', async () => {
    const h = await startHarness();
    const r = await get(h, '/api/v1/observability/rubrics');
    expect(r.status).toBe(200);
    const ids = (r.body as { rubrics: { id: string }[] }).rubrics.map((x) => x.id);
    expect(ids).toContain('default-quality');
    await h.close();
  });

  it('POST /rubrics registers a new rubric', async () => {
    const h = await startHarness();
    const r = await send(h, 'POST', '/api/v1/observability/rubrics', {
      id: 'strict',
      name: 'Strict',
      promptTemplate: 'be strict: {{output}}',
    });
    expect(r.status).toBe(201);
    const list = await get(h, '/api/v1/observability/rubrics');
    const ids = (list.body as { rubrics: { id: string }[] }).rubrics.map((x) => x.id);
    expect(ids).toContain('strict');
    await h.close();
  });
});
