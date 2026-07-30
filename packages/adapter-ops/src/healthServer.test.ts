import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startAdapterOpsHealthServer } from './healthServer.js';

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
