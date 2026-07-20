import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import { deprecatedPathMetrics, resetDeprecatedPathCounters } from '../src/deprecatedMetrics.js';

async function withApp(
  build: (app: express.Express) => void,
  action: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
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

describe('deprecatedHeaders', () => {
  it('sets Deprecation, Sunset, Link, x-legacy on inventory legacy route', async () => {
    resetDeprecatedPathCounters();
    await withApp(
      (app) => {
        app.use(deprecatedPathMetrics());
        app.get('/api/runs', (_req, res) => res.json({ ok: true }));
      },
      async (base) => {
        const res = await fetch(`${base}/api/runs`);
        assert.equal(res.headers.get('deprecation'), 'true');
        assert.equal(res.headers.get('x-legacy'), 'true');
        assert.ok(res.headers.get('sunset'));
        assert.ok(String(res.headers.get('link')).includes('successor-version'));
      },
    );
  });

  it('sets headers on warroom run-context route', async () => {
    resetDeprecatedPathCounters();
    await withApp(
      (app) => {
        app.use(deprecatedPathMetrics());
        app.get('/v1/projects/:projectId/run-context', (_req, res) => res.json({ ok: true }));
      },
      async (base) => {
        const res = await fetch(`${base}/v1/projects/proj-1/run-context`);
        assert.equal(res.headers.get('deprecation'), 'true');
        assert.ok(String(res.headers.get('link')).includes('/v1/runs'));
      },
    );
  });
});
