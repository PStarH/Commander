import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startAdapterOpsHealthServer } from './healthServer.js';

const faultControlCommand = {
  campaignId: 'campaign-a',
  tenantId: 'tenant-a',
  provider: 'kubernetes',
  destination: 'k8s://cluster-a/team-a/deployments/api',
  destinationHash: 'a'.repeat(64),
  effectId: 'effect-a',
  idempotencyKey: 'idem-a',
  faults: ['adapter.timeout-after-commit'],
  audience: 'commander.effect-broker',
  sourceCommit: 'a'.repeat(40),
  imageDigest: `sha256:${'a'.repeat(64)}`,
  expiresAt: '2030-01-01T00:01:00.000Z',
  nonce: 'nonce-a',
  issuer: 'commander',
  keyId: 'kid-a',
  workerId: 'compensation-daemon',
  workerGeneration: 1,
};

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

  it('rejects an unauthenticated fault-control mutation without invoking its handler', async () => {
    let calls = 0;
    const health = await startAdapterOpsHealthServer({
      port: 0,
      isReady: async () => true,
      faultControlHandler: {
        handle: async () => {
          calls += 1;
          return { accepted: true };
        },
      },
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${health.port}/v1/fault-control/campaigns/campaign-a/execute`,
        { method: 'PATCH', body: JSON.stringify(faultControlCommand) },
      );
      assert.equal(response.status, 401);
      assert.equal(calls, 0);
    } finally {
      await health.close();
    }
  });
});
