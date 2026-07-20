import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import { deprecatedPathMetrics, getDeprecatedPathCount, resetDeprecatedPathCounters } from '../src/deprecatedMetrics.js';

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

describe('deprecatedMetrics', () => {
  it('increments counter for inventory route', async () => {
    resetDeprecatedPathCounters();
    await withApp(
      (app) => {
        app.use(deprecatedPathMetrics());
        app.get('/api/runs', (_req, res) => res.json({ ok: true }));
      },
      async (base) => {
        const res = await fetch(`${base}/api/runs`);
        assert.equal(res.status, 200);
        assert.equal(getDeprecatedPathCount('legacy-api-runs'), 1);
      },
    );
  });

  it('does not count non-inventory routes', async () => {
    resetDeprecatedPathCounters();
    await withApp(
      (app) => {
        app.use(deprecatedPathMetrics());
        app.get('/v1/runs', (_req, res) => res.json({ ok: true }));
      },
      async (base) => {
        await fetch(`${base}/v1/runs`);
        assert.equal(getDeprecatedPathCount('legacy-api-runs'), 0);
      },
    );
  });
});
