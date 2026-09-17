import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { isKernelOpsReadyForTraffic, startOpsHealthServer } from './healthServer.js';

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
  // kernel-ops readiness covers process readiness, not whole-cell capability:
  // it owns reclaim / timer / outbox / compensation-probe loops + DB health.
  // EffectBroker compensation drain belongs to adapter-ops and is detail-only.
  it('fails traffic readiness when an owned loop is not healthy', () => {
    assert.equal(
      isKernelOpsReadyForTraffic({
        loopsReady: false,
        databaseOk: true,
      }),
      false,
    );
  });

  it('fails traffic readiness when the database probe fails', () => {
    assert.equal(
      isKernelOpsReadyForTraffic({
        loopsReady: true,
        databaseOk: false,
      }),
      false,
    );
  });

  it('allows traffic readiness when owned loops and db are ok (probe-only compensation)', () => {
    assert.equal(
      isKernelOpsReadyForTraffic({
        loopsReady: true,
        databaseOk: true,
      }),
      true,
    );
  });

  it('awaits bind success and serves /health', async () => {
    const port = await freePort();
    const health = await startOpsHealthServer({ port, isReady: () => true });
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/health');
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
      const res = await fetch('http://127.0.0.1:' + port + '/ready');
      assert.equal(res.status, 503);
    } finally {
      await health.close();
    }
  });

  it('keeps /ready 503 while /health stays 200 — /ready is a real gate, not an alias', async () => {
    // Guards against pointing /ready at the unconditional liveness handler.
    const port = await freePort();
    const health = await startOpsHealthServer({
      port,
      isReady: () =>
        isKernelOpsReadyForTraffic({
          loopsReady: false,
          databaseOk: true,
        }),
    });
    try {
      const ready = await fetch('http://127.0.0.1:' + port + '/ready');
      assert.equal(ready.status, 503);
      assert.equal((await ready.json()).status, 'not_ready');
      const live = await fetch('http://127.0.0.1:' + port + '/health');
      assert.equal(live.status, 200);
      assert.deepEqual(await live.json(), { status: 'ok' });
    } finally {
      await health.close();
    }
  });

  it('stays 503 on DB failure even when owned loops are ready', async () => {
    const port = await freePort();
    const health = await startOpsHealthServer({
      port,
      isReady: () =>
        isKernelOpsReadyForTraffic({
          loopsReady: true,
          databaseOk: false,
        }),
    });
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/ready');
      assert.equal(res.status, 503);
    } finally {
      await health.close();
    }
  });

  it('probe-only compensation is ready once owned loops are ready; drain stays explicit detail', async () => {
    // Mirrors main.ts: owned loops + DB ok → 200 even though compensation mode is
    // `probe` (drain is adapter-ops). Detail fields must not gate the status code.
    const port = await freePort();
    const health = await startOpsHealthServer({
      port,
      isReady: () =>
        isKernelOpsReadyForTraffic({
          loopsReady: true,
          databaseOk: true,
        }),
      getReadyDetails: () => ({
        compensationMode: 'probe',
        compensationDraining: false,
      }),
    });
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/ready');
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

  it('returns 200 from /ready when owned loops are ready and drain mode is wired', async () => {
    const port = await freePort();
    const health = await startOpsHealthServer({
      port,
      isReady: () =>
        isKernelOpsReadyForTraffic({
          loopsReady: true,
          databaseOk: true,
        }),
      getReadyDetails: () => ({
        compensationMode: 'drain',
        compensationDraining: true,
      }),
    });
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/ready');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        status: 'ready',
        compensationMode: 'drain',
        compensationDraining: true,
      });
    } finally {
      await health.close();
    }
  });
});
