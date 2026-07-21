import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startAdapterOpsHealthServer } from './healthServer.js';

describe('adapter-ops healthServer', () => {
  it('GET /health returns 200', async () => {
    const health = await startAdapterOpsHealthServer({ port: 0, isReady: async () => true });
    const port = health.port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
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
