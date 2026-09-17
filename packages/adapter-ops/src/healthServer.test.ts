import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAdapterOpsLoopHealthy, startAdapterOpsHealthServer } from './healthServer.js';
import type { OpsLoopHealth } from './reconciliationDaemon.js';

describe('adapter-ops healthServer', () => {
  it('GET /health returns both authoritative loop details', async () => {
    const reconciliation = {
      mode: 'draining' as const,
      running: true,
      inFlight: false,
      lastSucceededAt: '2026-07-23T00:00:00.000Z',
      claimed: 2,
      completed: 1,
      escalated: 1,
      rescheduled: 0,
      skippedOverlappingTicks: 0,
    };
    const compensation = {
      ...reconciliation,
      claimed: 1,
      completed: 1,
      escalated: 0,
    };
    const health = await startAdapterOpsHealthServer({
      port: 0,
      isReady: async () => true,
      getLoopHealth: () => ({ reconciliation, compensation }),
    });
    const port = health.port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: 'ok',
      loops: { reconciliation, compensation },
    });
    await health.close();
  });

  it('GET /ready returns 503 when not ready', async () => {
    const health = await startAdapterOpsHealthServer({ port: 0, isReady: async () => false });
    const port = health.port;
    const res = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(res.status, 503);
    await health.close();
  });
});

/**
 * AO-02: `/health` used to answer 200 {"status":"ok"} unconditionally, so a pod
 * whose loops had never run reported healthy forever. It is now a real loop gate
 * (process-only liveness lives at `/livez`, see AO-03 below).
 */
describe('adapter-ops healthServer reflects real state (AO-02)', () => {
  const healthyLoop: OpsLoopHealth = {
    mode: 'draining',
    running: true,
    inFlight: false,
    lastSucceededAt: '2026-07-23T00:00:00.000Z',
    claimed: 0,
    completed: 0,
    escalated: 0,
    rescheduled: 0,
    skippedOverlappingTicks: 0,
  };

  async function healthFor(
    reconciliation: OpsLoopHealth,
    compensation: OpsLoopHealth,
  ): Promise<{ status: number; body: { status: string } }> {
    const health = await startAdapterOpsHealthServer({
      port: 0,
      isReady: async () => true,
      getLoopHealth: () => ({ reconciliation, compensation }),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${health.port}/health`);
      return { status: res.status, body: (await res.json()) as { status: string } };
    } finally {
      await health.close();
    }
  }

  it('reports 503 when a loop has not started', async () => {
    const result = await healthFor(healthyLoop, {
      ...healthyLoop,
      running: false,
      lastSucceededAt: undefined,
    });
    assert.equal(result.status, 503);
    assert.equal(result.body.status, 'degraded');
  });

  it('reports 503 when the last tick failed after the last success', async () => {
    const result = await healthFor(
      { ...healthyLoop, lastFailedAt: '2026-07-23T00:00:05.000Z' },
      healthyLoop,
    );
    assert.equal(result.status, 503);
    assert.equal(result.body.status, 'degraded');
  });

  it('reports 200 while a later success has recovered the loop', async () => {
    const result = await healthFor(
      { ...healthyLoop, lastFailedAt: '2026-07-22T00:00:00.000Z' },
      healthyLoop,
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ok');
  });

  it('falls back to the readiness predicate when no loop telemetry is wired', async () => {
    const health = await startAdapterOpsHealthServer({ port: 0, isReady: async () => false });
    try {
      const res = await fetch(`http://127.0.0.1:${health.port}/health`);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { status: 'degraded' });
    } finally {
      await health.close();
    }
  });
});

/**
 * AO-03: liveness must not be driven by ops-loop or dependency state. Kubernetes
 * `livenessPath` now points at the process-only `/livez`, so a stopped or failed
 * loop degrades traffic (via /health, /ready) without restarting the Pod and
 * never converging. `/ready` remains the real drain gate.
 */
describe('adapter-ops process liveness vs drain gates (AO-03)', () => {
  const healthyLoop: OpsLoopHealth = {
    mode: 'draining',
    running: true,
    inFlight: false,
    lastSucceededAt: '2026-07-23T00:00:00.000Z',
    claimed: 0,
    completed: 0,
    escalated: 0,
    rescheduled: 0,
    skippedOverlappingTicks: 0,
  };

  async function probe(
    reconciliation: OpsLoopHealth,
    compensation: OpsLoopHealth,
  ): Promise<{ livez: number; health: number; ready: number }> {
    const health = await startAdapterOpsHealthServer({
      port: 0,
      // Mirrors main.ts: /ready is gated on the loops that own real drain.
      isReady: () =>
        isAdapterOpsLoopHealthy(reconciliation) && isAdapterOpsLoopHealthy(compensation),
      getLoopHealth: () => ({ reconciliation, compensation }),
    });
    try {
      const [livez, healthRes, ready] = await Promise.all([
        fetch(`http://127.0.0.1:${health.port}/livez`),
        fetch(`http://127.0.0.1:${health.port}/health`),
        fetch(`http://127.0.0.1:${health.port}/ready`),
      ]);
      return { livez: livez.status, health: healthRes.status, ready: ready.status };
    } finally {
      await health.close();
    }
  }

  it('serves /livez 200 while stopped loops keep /health and /ready at 503', async () => {
    const stopped: OpsLoopHealth = {
      ...healthyLoop,
      running: false,
      lastSucceededAt: undefined,
    };
    assert.deepEqual(await probe(stopped, stopped), { livez: 200, health: 503, ready: 503 });
  });

  it('serves /livez 200 while a failed tick keeps /health and /ready at 503', async () => {
    const failed: OpsLoopHealth = {
      ...healthyLoop,
      lastFailedAt: '2026-07-23T00:00:05.000Z',
    };
    assert.deepEqual(await probe(failed, healthyLoop), { livez: 200, health: 503, ready: 503 });
  });

  it('recovers /health and /ready after a later success while /livez stays 200', async () => {
    const recovered: OpsLoopHealth = {
      ...healthyLoop,
      lastFailedAt: '2026-07-22T00:00:00.000Z',
    };
    assert.deepEqual(await probe(recovered, healthyLoop), { livez: 200, health: 200, ready: 200 });
  });

  it('answers /livez with the process-only body even when readiness is false', async () => {
    const health = await startAdapterOpsHealthServer({ port: 0, isReady: async () => false });
    try {
      const res = await fetch(`http://127.0.0.1:${health.port}/livez`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'alive' });
    } finally {
      await health.close();
    }
  });
});
