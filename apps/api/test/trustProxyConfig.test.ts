/**
 * AUDIT-E2 regressions: `trust proxy` must fail closed.
 *
 * Baseline defaulted to '1' — one trusted hop even with no proxy in front, so
 * a direct client spoofed req.ip via X-Forwarded-For (auth-failure lockout
 * bypass by IP rotation + targeted lockout DoS). Now: unset means trust
 * nothing; malformed values refuse to boot.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import express from 'express';

const { resolveTrustProxySetting, TrustProxyConfigError } = await import(
  '../src/trustProxyConfig'
);

describe('resolveTrustProxySetting (AUDIT-E2)', () => {
  test('unset TRUST_PROXY_HOPS trusts no proxy (fail closed)', () => {
    assert.equal(resolveTrustProxySetting({}), false);
  });

  test("'0' explicitly trusts nothing", () => {
    assert.equal(resolveTrustProxySetting({ TRUST_PROXY_HOPS: '0' }), false);
  });

  test('explicit hop counts are honored for real proxy deployments', () => {
    assert.equal(resolveTrustProxySetting({ TRUST_PROXY_HOPS: '1' }), 1);
    assert.equal(resolveTrustProxySetting({ TRUST_PROXY_HOPS: '2' }), 2);
  });

  for (const bad of ['-1', '1.5', 'one', '', ' ']) {
    test(`malformed TRUST_PROXY_HOPS ${JSON.stringify(bad)} refuses to boot`, () => {
      assert.throws(
        () => resolveTrustProxySetting({ TRUST_PROXY_HOPS: bad }),
        TrustProxyConfigError,
      );
    });
  }
});

describe('express integration: client X-Forwarded-For is ignored by default', () => {
  test('direct client cannot spoof req.ip when no proxy is trusted', async () => {
    const app = express();
    app.set('trust proxy', resolveTrustProxySetting({}));
    let seenIp = 'unset';
    app.get('/ip', (req, res) => {
      seenIp = req.ip ?? 'unset';
      res.json({ ip: seenIp });
    });

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ip`, {
        headers: { 'x-forwarded-for': '198.51.100.7' },
      });
      assert.equal(res.status, 200);
      // FAILING before the fix (default '1'): req.ip was 198.51.100.7.
      assert.equal(seenIp, '127.0.0.1', 'spoofed XFF must not become req.ip');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
