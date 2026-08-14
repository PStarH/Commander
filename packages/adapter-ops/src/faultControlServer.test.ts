import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startFaultControlServer } from './faultControlServer.js';

const command = {
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

describe('fault-control server', () => {
  it('rejects an unauthenticated mutation without calling the controller', async () => {
    let calls = 0;
    const server = await startFaultControlServer({
      port: 0,
      handler: {
        handle: async () => {
          calls += 1;
          return { accepted: true };
        },
      },
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/v1/fault-control/campaigns/campaign-a/execute`,
        { method: 'POST', body: '{}' },
      );
      assert.equal(response.status, 401);
      assert.equal(calls, 0);
    } finally {
      await server.close();
    }
  });

  it('forwards only the exact campaign-bound command to the authenticated controller', async () => {
    let received: unknown;
    const server = await startFaultControlServer({
      port: 0,
      handler: {
        handle: async (input) => {
          received = input;
          return { accepted: true };
        },
      },
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/v1/fault-control/campaigns/campaign-a/execute`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer capability-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify(command),
        },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(received, { token: 'capability-token', command });
    } finally {
      await server.close();
    }
  });
});
