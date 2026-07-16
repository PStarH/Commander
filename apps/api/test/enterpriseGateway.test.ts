import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it, before, after } from 'node:test';
import express from 'express';
import {
  enterpriseRouteFreeze,
  legacyHeader,
  isEnterpriseReachablePath,
} from '../src/enterpriseGateway.js';

function request(base: string, path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, redirect: 'manual' });
}

async function withApp(
  build: (app: express.Express) => void,
  action: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  build(app);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe('enterpriseRouteFreeze', () => {
  it('rejects non-/v1 product routes with 410 Gone + x-legacy when enterprise', async () => {
    process.env.COMMANDER_PROFILE = 'enterprise';
    await withApp(
      (app) => {
        app.use(enterpriseRouteFreeze());
        app.get('/projects', (_req, res) => res.json({ served: true }));
        app.get('/v1/runs', (_req, res) => res.json({ served: true }));
      },
      async (base) => {
        const res = await request(base, '/projects');
        assert.equal(res.status, 410);
        assert.equal(res.headers.get('x-legacy'), 'true');
        const body = (await res.json()) as { error: { code: string } };
        assert.equal(body.error.code, 'GONE');
      },
    );
    delete process.env.COMMANDER_PROFILE;
  });

  it('allows /v1 paths and ops paths through in enterprise profile', async () => {
    process.env.COMMANDER_PROFILE = 'enterprise';
    await withApp(
      (app) => {
        app.use(enterpriseRouteFreeze());
        app.get('/v1/runs', (_req, res) => res.json({ served: true }));
        app.get('/health', (_req, res) => res.json({ served: true }));
        app.get('/ready', (_req, res) => res.json({ served: true }));
        app.get('/metrics', (_req, res) => res.json({ served: true }));
        app.get('/system/status', (_req, res) => res.json({ served: true }));
      },
      async (base) => {
        for (const path of ['/v1/runs', '/health', '/ready', '/metrics', '/system/status']) {
          const res = await request(base, path);
          assert.equal(res.status, 200, `${path} should be reachable`);
          assert.equal(res.headers.get('x-legacy'), null, `${path} must not be x-legacy`);
        }
      },
    );
    delete process.env.COMMANDER_PROFILE;
  });

  it('passes every route through when standard profile (no 410)', async () => {
    process.env.COMMANDER_PROFILE = 'standard';
    await withApp(
      (app) => {
        app.use(enterpriseRouteFreeze());
        app.get('/projects', (_req, res) => res.json({ served: true }));
      },
      async (base) => {
        const res = await request(base, '/projects');
        assert.equal(res.status, 200);
        assert.equal(((await res.json()) as { served: boolean }).served, true);
      },
    );
    delete process.env.COMMANDER_PROFILE;
  });
});

describe('legacyHeader', () => {
  it('adds x-legacy: true to non-/v1 product routes in standard profile', async () => {
    process.env.COMMANDER_PROFILE = 'standard';
    await withApp(
      (app) => {
        app.use(legacyHeader());
        app.get('/projects', (_req, res) => res.json({ ok: true }));
        app.get('/v1/runs', (_req, res) => res.json({ ok: true }));
        app.get('/health', (_req, res) => res.json({ ok: true }));
      },
      async (base) => {
        const legacy = await request(base, '/projects');
        assert.equal(legacy.headers.get('x-legacy'), 'true');
        const v1 = await request(base, '/v1/runs');
        assert.equal(v1.headers.get('x-legacy'), null);
        const health = await request(base, '/health');
        assert.equal(health.headers.get('x-legacy'), null);
      },
    );
    delete process.env.COMMANDER_PROFILE;
  });

  it('does not double-mark in enterprise profile (freeze already handles 410)', async () => {
    process.env.COMMANDER_PROFILE = 'enterprise';
    await withApp(
      (app) => {
        app.use(enterpriseRouteFreeze());
        app.use(legacyHeader());
        app.get('/v1/runs', (_req, res) => res.json({ ok: true }));
      },
      async (base) => {
        const v1 = await request(base, '/v1/runs');
        assert.equal(v1.headers.get('x-legacy'), null);
      },
    );
    delete process.env.COMMANDER_PROFILE;
  });
});

describe('isEnterpriseReachablePath', () => {
  it('classifies paths by prefix', () => {
    assert.equal(isEnterpriseReachablePath('/v1/runs'), true);
    assert.equal(isEnterpriseReachablePath('/v1/openapi.json'), true);
    assert.equal(isEnterpriseReachablePath('/health'), true);
    assert.equal(isEnterpriseReachablePath('/health/detailed'), true);
    assert.equal(isEnterpriseReachablePath('/ready'), true);
    assert.equal(isEnterpriseReachablePath('/metrics'), true);
    assert.equal(isEnterpriseReachablePath('/system/status'), true);
    assert.equal(isEnterpriseReachablePath('/projects'), false);
    assert.equal(isEnterpriseReachablePath('/api/runtime/execute'), false);
    assert.equal(isEnterpriseReachablePath('/api/v1/observability'), false);
  });
});
