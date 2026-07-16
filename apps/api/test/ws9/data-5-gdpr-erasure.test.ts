/**
 * WS9 DATA-5 — /v1/privacy/erasure rejects cross-tenant Art.17 attempts.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import express, { type Request, type Response, type Application } from 'express';
import type { Server } from 'node:net';
import { createV1GatewayRouter } from '../../src/v1GatewayEndpoints';
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
  app.use(express.json());
  app.use((req: Request, _res: Response, next) => {
    (req as Request & { tenantId?: string; apiKeyId?: string }).tenantId = principalTenant;
    (req as Request & { apiKeyId?: string }).apiKeyId = 'ws9-test-key';
    next();
  });
  app.use(tenantContextMiddleware);
  app.use('/v1', createV1GatewayRouter(() => null));
  return app;
}

test('DATA-5: tenant-a cannot erase tenant-b via body.tenantId', async () => {
  const app = buildApp('tenant-a');
  const { server, port } = await startServer(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/privacy/erasure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjectUserId: 'user-b', tenantId: 'tenant-b' }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'TENANT_ISOLATION');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('DATA-5: tenant-a cannot erase tenant-b:user via subject prefix', async () => {
  const app = buildApp('tenant-a');
  const { server, port } = await startServer(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/privacy/erasure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjectUserId: 'tenant-b:user-b' }),
    });
    assert.equal(res.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('DATA-5: same-tenant erasure returns 200 with auditEventId', async () => {
  const app = buildApp('tenant-a');
  const { server, port } = await startServer(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/privacy/erasure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjectUserId: 'user-a' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      erased: boolean;
      tenantId: string;
      auditEventId: string;
    };
    assert.equal(body.erased, true);
    assert.equal(body.tenantId, 'tenant-a');
    assert.ok(body.auditEventId.startsWith('gdpr_erase_'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
