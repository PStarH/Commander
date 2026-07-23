import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startWorkerHealthServer } from './healthServer.js';

describe('worker health server', () => {
  it('keeps liveness independent from registration readiness', async () => {
    let ready = false;
    const health = await startWorkerHealthServer({ port: 0, isReady: () => ready });
    try {
      const live = await fetch(`http://127.0.0.1:${health.port}/health`);
      assert.equal(live.status, 200);

      const beforeRegistration = await fetch(`http://127.0.0.1:${health.port}/ready`);
      assert.equal(beforeRegistration.status, 503);

      ready = true;
      const afterRegistration = await fetch(`http://127.0.0.1:${health.port}/ready`);
      assert.equal(afterRegistration.status, 200);
    } finally {
      await health.close();
    }
  });

  it('fails readiness closed when the readiness callback rejects', async () => {
    const health = await startWorkerHealthServer({
      port: 0,
      isReady: async () => {
        throw new Error('registration unavailable');
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${health.port}/ready`);
      assert.equal(response.status, 503);
    } finally {
      await health.close();
    }
  });
});
