import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it, before, after } from 'node:test';
import express from 'express';
import {
  probeDatabase,
  probeKernel,
  probeEffectBroker,
  probeReadiness,
  type ReadinessProbeDeps,
} from '../src/healthProbes.js';

/**
 * WS3 §6 health check honesty tests.
 *
 * Verifies:
 * - /ready returns 503 when any hard gate (database/kernel) fails.
 * - /ready returns 200 only when all hard gates pass.
 * - effectBroker is a soft indicator: null → `unknown` (API does not host broker).
 * - /ready marks non-gated deps as 'degraded'/'unknown' (not 'ok') when unwired.
 * - /ready never returns 'ok' for an unprobed dependency (§6.2 invariant).
 * - /v1/health reflects only /v1 subtree deps (kernel, effectBroker).
 */

function noop() {}

async function withReadyApp(
  deps: ReadinessProbeDeps,
  action: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.get('/ready', async (_req, res) => {
    const result = await probeReadiness(deps);
    res.status(result.status === 'ready' ? 200 : 503).json(result);
  });
  app.get('/v1/health', async (_req, res) => {
    const result = await probeReadiness({
      database: deps.database,
      kernel: deps.kernel,
      effectBroker: deps.effectBroker,
    });
    res.status(result.status === 'ready' ? 200 : 503).json({
      status: result.status,
      checks: {
        kernel: result.checks.kernel,
        effectBroker: result.checks.effectBroker,
      },
    });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe('WS3 §6 health probes — individual', () => {
  it('probeDatabase returns ok when probe resolves', async () => {
    const result = await probeDatabase(async () => 'ok');
    assert.equal(result, 'ok');
  });

  it('probeDatabase returns fail when probe rejects', async () => {
    const result = await probeDatabase(async () => {
      throw new Error('connection refused');
    });
    assert.equal(result, 'fail');
  });

  it('probeDatabase returns unknown when no probe wired', async () => {
    const result = await probeDatabase(undefined);
    assert.equal(result, 'unknown');
  });

  it('probeKernel returns ok when gateway is non-null', async () => {
    const result = await probeKernel(() => ({}) as never);
    assert.equal(result, 'ok');
  });

  it('probeKernel returns fail when gateway is null', async () => {
    const result = await probeKernel(() => null);
    assert.equal(result, 'fail');
  });

  it('probeEffectBroker returns ok when broker is non-null', async () => {
    const result = await probeEffectBroker(() => ({}) as never);
    assert.equal(result, 'ok');
  });

  it('probeEffectBroker returns unknown when broker is null (API does not host worker broker)', async () => {
    const result = await probeEffectBroker(() => null);
    assert.equal(result, 'unknown');
  });
});

describe('WS3 §6 /ready — honesty invariants', () => {
  it('returns 503 not_ready when kernel is not initialized (hard gate)', async () => {
    await withReadyApp(
      {
        database: async () => 'ok',
        kernel: () => null,
        effectBroker: () => ({} as never),
      },
      async (base) => {
        const res = await fetch(`${base}/ready`);
        assert.equal(res.status, 503);
        const body = (await res.json()) as { status: string; checks: Record<string, string> };
        assert.equal(body.status, 'not_ready');
        assert.equal(body.checks.kernel, 'fail');
      },
    );
  });

  it('returns 503 not_ready when database probe fails', async () => {
    await withReadyApp(
      {
        database: async () => {
          throw new Error('ECONNREFUSED');
        },
        kernel: () => ({} as never),
        effectBroker: () => ({} as never),
      },
      async (base) => {
        const res = await fetch(`${base}/ready`);
        assert.equal(res.status, 503);
        const body = (await res.json()) as { status: string; checks: Record<string, string> };
        assert.equal(body.status, 'not_ready');
        assert.equal(body.checks.database, 'fail');
      },
    );
  });

  it('reports effectBroker unknown when unwired and does NOT gate readiness', async () => {
    await withReadyApp(
      {
        database: async () => 'ok',
        kernel: () => ({} as never),
        effectBroker: () => null,
      },
      async (base) => {
        const res = await fetch(`${base}/ready`);
        // API process does not host the worker-plane broker; null is expected
        // and must surface as unknown (not permanent fail).
        assert.equal(res.status, 200);
        const body = (await res.json()) as { status: string; checks: Record<string, string> };
        assert.equal(body.status, 'ready');
        assert.equal(body.checks.effectBroker, 'unknown');
      },
    );
  });

  it('returns 200 ready when all hard gates pass', async () => {
    await withReadyApp(
      {
        database: async () => 'ok',
        kernel: () => ({} as never),
        effectBroker: () => ({} as never),
        warRoomStore: () => true,
        memoryHeap: () => 0.5,
      },
      async (base) => {
        const res = await fetch(`${base}/ready`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { status: string; checks: Record<string, string> };
        assert.equal(body.status, 'ready');
        assert.equal(body.checks.database, 'ok');
        assert.equal(body.checks.kernel, 'ok');
        assert.equal(body.checks.effectBroker, 'ok');
      },
    );
  });

  it('marks unprobed dependencies as unknown, never ok (§6.2)', async () => {
    await withReadyApp(
      {
        database: undefined,
        kernel: () => ({} as never),
        effectBroker: () => ({} as never),
      },
      async (base) => {
        const res = await fetch(`${base}/ready`);
        // database unknown is NOT a hard gate failure — only fail is.
        assert.equal(res.status, 200);
        const body = (await res.json()) as { status: string; checks: Record<string, string> };
        assert.equal(body.checks.database, 'unknown');
        assert.notEqual(body.checks.database, 'ok');
      },
    );
  });

  it('marks warRoomStore as degraded (not a hard gate)', async () => {
    await withReadyApp(
      {
        database: async () => 'ok',
        kernel: () => ({} as never),
        effectBroker: () => ({} as never),
        warRoomStore: () => false,
      },
      async (base) => {
        const res = await fetch(`${base}/ready`);
        // warRoomStore degraded does NOT gate readiness (§6.1).
        assert.equal(res.status, 200);
        const body = (await res.json()) as { status: string; checks: Record<string, string> };
        assert.equal(body.checks.warRoomStore, 'degraded');
      },
    );
  });
});

describe('WS3 §6 /v1/health — subtree-only deps', () => {
  it('returns 503 when kernel is null', async () => {
    await withReadyApp(
      {
        database: async () => 'ok',
        kernel: () => null,
        effectBroker: () => ({} as never),
      },
      async (base) => {
        const res = await fetch(`${base}/v1/health`);
        assert.equal(res.status, 503);
        const body = (await res.json()) as {
          status: string;
          checks: { kernel: string; effectBroker: string };
        };
        assert.equal(body.status, 'not_ready');
        assert.equal(body.checks.kernel, 'fail');
        assert.equal(body.checks.effectBroker, 'ok');
      },
    );
  });

  it('returns 200 when kernel and effectBroker are ready', async () => {
    await withReadyApp(
      {
        database: async () => 'ok',
        kernel: () => ({} as never),
        effectBroker: () => ({} as never),
      },
      async (base) => {
        const res = await fetch(`${base}/v1/health`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          status: string;
          checks: { kernel: string; effectBroker: string };
        };
        assert.equal(body.status, 'ready');
        assert.equal(body.checks.kernel, 'ok');
        assert.equal(body.checks.effectBroker, 'ok');
      },
    );
  });
});
