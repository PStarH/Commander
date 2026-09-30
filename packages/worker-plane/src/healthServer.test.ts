import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { describe, it } from 'node:test';
import { startWorkerHealthServer } from './healthServer.js';

/** True when a TCP connection to host:port is accepted within `timeoutMs`. */
function canConnect(port: number, host: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

describe('worker health server', () => {
  it('binds only the explicit host instead of silently binding all interfaces', async () => {
    // An unresolvable hostname only proves DNS failure — it never showed that an
    // accepted host is actually honoured. Bind to IPv4 loopback and prove the
    // listener is *not* reachable where a wildcard (`::`/dual-stack) bind would
    // answer, since a wildcard listener answers on IPv6 loopback too.
    const health = await startWorkerHealthServer({
      host: '127.0.0.1',
      port: 0,
      isReady: () => true,
    });
    try {
      assert.equal(
        await canConnect(health.port, '127.0.0.1'),
        true,
        'must answer on IPv4 loopback',
      );
      assert.equal(
        await canConnect(health.port, '::1'),
        false,
        'must not answer on an unbound host',
      );
    } finally {
      await health.close();
    }
  });

  it('binds loopback when no host is configured (WP-15)', async () => {
    // main.ts starts the server without a host, and /health + /ready have no
    // authentication: an omitted host must not expose them on every interface.
    const external = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;
    const probeHost = external ?? '::1';

    const health = await startWorkerHealthServer({ port: 0, isReady: () => true });
    try {
      assert.equal(await canConnect(health.port, '127.0.0.1'), true, 'must answer on loopback');
      assert.equal(
        await canConnect(health.port, probeHost),
        false,
        `must not answer on ${probeHost} without an explicit host`,
      );
    } finally {
      await health.close();
    }
  });

  it('rejects an unresolvable explicit bind host', async () => {
    await assert.rejects(
      () =>
        startWorkerHealthServer({
          host: 'does-not-exist.invalid',
          port: 0,
          isReady: () => true,
        }),
      /ENOTFOUND|EAI_AGAIN|ENETUNREACH|EADDRNOTAVAIL/,
    );
  });

  it('keeps liveness independent from registration readiness', async () => {
    let ready = false;
    const health = await startWorkerHealthServer({
      host: '127.0.0.1',
      port: 0,
      isReady: () => ready,
    });
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
      host: '127.0.0.1',
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
