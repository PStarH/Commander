import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { startOpsHealthServer } from './healthServer.js';

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (!addr || typeof addr === 'string') {
        probe.close();
        reject(new Error('failed to allocate ephemeral port'));
        return;
      }
      const { port } = addr;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
    probe.on('error', reject);
  });
}

describe('ops healthServer', () => {
  it('awaits bind success and serves /health', async () => {
    const port = await freePort();
    const health = await startOpsHealthServer({ port, isReady: () => true });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok' });
    } finally {
      await health.close();
    }
  });

  it('fails closed when the port is already bound', async () => {
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      // Bind the same wildcard family healthServer uses (listen(port) → ::/0.0.0.0).
      blocker.listen(port, () => resolve());
    });
    try {
      await assert.rejects(() => startOpsHealthServer({ port, isReady: () => true }), /EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('returns 503 from /ready when isReady is false', async () => {
    const port = await freePort();
    const health = await startOpsHealthServer({ port, isReady: () => false });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ready`);
      assert.equal(res.status, 503);
    } finally {
      await health.close();
    }
  });

  it('exposes compensationMode on /ready so probe is not mistaken for drain', async () => {
    const port = await freePort();
    const health = await startOpsHealthServer({
      port,
      isReady: () => true,
      getReadyDetails: () => ({
        compensationMode: 'probe',
        compensationDraining: false,
      }),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ready`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        status: 'ready',
        compensationMode: 'probe',
        compensationDraining: false,
      });
    } finally {
      await health.close();
    }
  });
});
