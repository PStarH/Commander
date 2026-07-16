/**
 * WS9 DATA-2 — authenticated tenant binding rejects forged X-Tenant-ID.
 *
 * Local Express stack with a stand-in for authMiddleware (sets req.tenantId).
 * Live evidence is produced only by packages/core/tests/ws9 against the
 * compose API + COMMANDER_WS9_API_KEY_A — this file does not write baselines.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import express, { type Request, type Response, type Application } from 'express';
import type { Server } from 'node:net';
import { tenantContextMiddleware } from '../../src/tenantContextMiddleware';

function startServer(app: Application): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object' && 'port' in addr) {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
    server.on('error', reject);
  });
}

function buildApp(principalTenant: string) {
  const app = express();
  app.use((req: Request, _res: Response, next) => {
    (req as Request & { tenantId?: string }).tenantId = principalTenant;
    next();
  });
  app.use(tenantContextMiddleware);
  app.get('/probe', (req: Request, res: Response) => {
    res.json({ tenantId: req.tenantId });
  });
  return app;
}

test('DATA-2: tenant-a principal + forged X-Tenant-ID:tenant-b → 403', async () => {
  const app = buildApp('tenant-a');
  const { server, port } = await startServer(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/probe`, {
      headers: { 'X-Tenant-ID': 'tenant-b' },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'TenantIsolationError');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('DATA-2: tenant-a principal + matching X-Tenant-ID → binds tenant-a', async () => {
  const app = buildApp('tenant-a');
  const { server, port } = await startServer(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/probe`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tenantId: string };
    assert.equal(body.tenantId, 'tenant-a');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
