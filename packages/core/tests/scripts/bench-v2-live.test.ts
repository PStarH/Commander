import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  run,
  assertLiveBenchWorkerTenants,
  defaultWorkerTenantsForCount,
} from '../../../../scripts/bench-v2-live.ts';
import { validateBaseline, type BaselineDocument } from '../../src/benchmarks/baselineSchema';
import { getCurrentBaseline } from '../../../../scripts/check-readiness.ts';

describe('bench-v2-live worker tenant gate', () => {
  it('allows live mode at the five-tenant default without COMMANDER_WORKER_TENANTS', () => {
    expect(() =>
      assertLiveBenchWorkerTenants(5, 'live', {} as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('allows simulated mode with any tenant count without COMMANDER_WORKER_TENANTS', () => {
    expect(() =>
      assertLiveBenchWorkerTenants(3, 'simulated', {} as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('fail-closes live mode when --tenants≠5 and COMMANDER_WORKER_TENANTS is unset', () => {
    expect(() =>
      assertLiveBenchWorkerTenants(3, 'live', {} as NodeJS.ProcessEnv),
    ).toThrow(/COMMANDER_WORKER_TENANTS/);
  });

  it('fail-closes live mode when COMMANDER_WORKER_TENANTS is empty or *', () => {
    expect(() =>
      assertLiveBenchWorkerTenants(3, 'live', {
        COMMANDER_WORKER_TENANTS: '',
      } as NodeJS.ProcessEnv),
    ).toThrow(/COMMANDER_WORKER_TENANTS/);
    expect(() =>
      assertLiveBenchWorkerTenants(3, 'live', {
        COMMANDER_WORKER_TENANTS: '*',
      } as NodeJS.ProcessEnv),
    ).toThrow(/COMMANDER_WORKER_TENANTS/);
  });

  it('allows live mode when COMMANDER_WORKER_TENANTS is explicitly set', () => {
    expect(() =>
      assertLiveBenchWorkerTenants(3, 'live', {
        COMMANDER_WORKER_TENANTS: defaultWorkerTenantsForCount(3),
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

describe('bench-v2-live baseline output', () => {
  it('writes a valid simulated baseline when no live topology is available', async () => {
    const { report, baselinePath, passed } = await run([
      '--runs=10',
      '--rate=5',
      '--base-url=http://127.0.0.1:65535',
    ]);

    expect(passed).toBe(true);
    expect(report.summary.passed).toBe(true);
    expect(report.mode).toBe('simulated');
    expect(report.evidenceLevel ?? report.env?.evidence).toBe('simulated');
    expect(baselinePath).toMatch(/bench-v2-live\.[^/]+\.json$/);

    const raw = readFileSync(baselinePath, 'utf-8');
    const doc = JSON.parse(raw) as BaselineDocument;

    expect(doc.schemaVersion).toBe(2);
    expect(doc.evidenceLevel).toBe('simulated');
    expect(doc.baseline).toBeDefined();
    expect(doc.baseline?.gitSha).toBeDefined();
    expect(doc.summary).toMatchObject({
      passed: true,
      errors: 0,
      failed: 0,
      skipped: 0,
    });
    expect(doc.measurements).toMatchObject({
      runs: 10,
      rate: 5,
      live: false,
    });

    const current = getCurrentBaseline();
    const validation = validateBaseline(doc, current);
    expect(validation.ok).toBe(true);
    expect(validation.reasons).toEqual([]);

    rmSync(baselinePath);
  });
});

interface MockRun {
  runId: string;
  tenantId: string;
  state: string;
  terminal: boolean;
  events: Array<{
    type: string;
    tenantId: string;
    runId: string;
    stepId?: string;
    actor: string;
    aggregateType: 'run' | 'step' | 'effect' | 'interaction' | 'worker';
    payload?: Record<string, unknown>;
  }>;
}

function startMockV1KernelServer(): Promise<{ server: Server; baseUrl: string; stop: () => Promise<void> }> {
  let counter = 0;
  const runs = new Map<string, MockRun>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const tenantId = req.headers['x-tenant-id'] as string | undefined;

    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url === '/health' && req.method === 'GET') {
      return sendJson(200, { status: 'healthy' });
    }

    if (url === '/v1/runs' && req.method === 'POST') {
      const idempotencyKey = req.headers['idempotency-key'];
      if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
        return sendJson(400, { error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
      }
      if (!tenantId) {
        return sendJson(401, { error: { code: 'TENANT_IDENTITY_REQUIRED' } });
      }

      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        counter++;
        const runId = `run_${counter}_${tenantId}`;
        const stepId = `step_${counter}`;
        const run: MockRun = {
          runId,
          tenantId,
          state: 'SUCCEEDED',
          terminal: true,
          events: [
            {
              aggregateType: 'run',
              type: 'run.created',
              tenantId,
              runId,
              actor: 'gateway.bench',
            },
            {
              aggregateType: 'step',
              type: 'step.claimed',
              tenantId,
              runId,
              stepId,
              actor: 'worker-1',
            },
            {
              aggregateType: 'step',
              type: 'step.succeeded',
              tenantId,
              runId,
              stepId,
              actor: 'worker-1',
            },
            {
              aggregateType: 'run',
              type: 'run.succeeded',
              tenantId,
              runId,
              actor: 'worker-1',
            },
          ],
        };
        runs.set(runId, run);
        sendJson(202, {
          run: {
            id: runId,
            state: run.state,
            tenantId,
          },
          idempotentReplay: false,
        });
      });
      return;
    }

    const statusMatch = url.match(/^\/v1\/runs\/([^/]+)\/status$/);
    if (statusMatch && req.method === 'GET') {
      const runId = decodeURIComponent(statusMatch[1]!);
      const run = runs.get(runId);
      if (!run) return sendJson(404, { error: { code: 'RUN_NOT_FOUND' } });
      return sendJson(200, {
        runId: run.runId,
        state: run.state,
        tenantId: run.tenantId,
        terminal: run.terminal,
      });
    }

    const eventsMatch = url.match(/^\/v1\/runs\/([^/]+)\/events$/);
    if (eventsMatch && req.method === 'GET') {
      const runId = decodeURIComponent(eventsMatch[1]!);
      const run = runs.get(runId);
      if (!run) return sendJson(404, { error: { code: 'RUN_NOT_FOUND' } });
      return sendJson(200, { events: run.events });
    }

    sendJson(404, { error: 'not found' });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        return reject(new Error('invalid server address'));
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      resolve({
        server,
        baseUrl,
        stop: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

describe('bench-v2-live live mode', () => {
  let mock: { server: Server; baseUrl: string; stop: () => Promise<void> } | undefined;

  beforeAll(async () => {
    try {
      mock = await startMockV1KernelServer();
    } catch {
      // If we cannot start the mock server, tests will skip live mode.
    }
  });

  afterAll(async () => {
    await mock?.stop();
  });

  it('exercises the live /v1/runs path against a local in-memory kernel server', async () => {
    if (!mock) return;

    const { report, baselinePath, passed } = await run([
      '--mode=live',
      `--base-url=${mock.baseUrl}`,
      '--runs=10',
      '--rate=5',
    ]);

    expect(passed).toBe(true);
    expect(report.mode).toBe('live');
    expect(report.live).toBe(true);
    expect(report.seeded).toBe(true);
    expect(report.drained).toBe(true);
    expect(report.failedRuns).toBe(0);
    expect(report.duplicateClaims).toBe(0);
    expect(report.tenantLeaks).toBe(0);
    expect(report.verdict).toBe('PASS');

    const raw = readFileSync(baselinePath, 'utf-8');
    const doc = JSON.parse(raw) as BaselineDocument;
    expect(doc.evidenceLevel).toBe('live');
    expect(doc.summary?.passed).toBe(true);

    const current = getCurrentBaseline();
    // Mock kernel has no real image; host docker digests must not gate this test.
    const validation = validateBaseline(doc, { ...current, imageDigest: undefined });
    expect(validation.reasons, `baseline validation failed: ${validation.reasons.join('; ')}`).toEqual(
      [],
    );
    expect(validation.ok).toBe(true);

    rmSync(baselinePath);
  });

  it('fails gracefully in live mode when no kernel server is reachable', async () => {
    const { report, baselinePath, passed } = await run([
      '--mode=live',
      '--base-url=http://127.0.0.1:65535',
      '--runs=10',
      '--rate=5',
    ]);

    expect(passed).toBe(false);
    expect(report.mode).toBe('live');
    expect(report.live).toBe(true);
    expect(report.verdict).toBe('FAIL');
    expect(report.failures).toEqual(
      expect.arrayContaining([expect.stringMatching(/kernel not reachable/i)]),
    );

    const raw = readFileSync(baselinePath, 'utf-8');
    const doc = JSON.parse(raw) as BaselineDocument;
    expect(doc.evidenceLevel).toBe('live');
    expect(doc.summary?.passed).toBe(false);

    rmSync(baselinePath);
  });
});
