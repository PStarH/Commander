/**
 * LM-24 / api-management#L22 — `GET /checkpoints/stats` was shadowed by the
 * dynamic `GET /checkpoints/:id` route.
 *
 * Because `stats` is a valid `:id` segment, the dynamic route matched first and
 * `checkpointManager.get('stats')` returned nothing, so the statistics endpoint
 * answered 404 "Checkpoint not found". The static route was unreachable — a
 * route that exists in the source but can never be selected.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { CheckpointManager } from '../src/governanceCheckpoint';
import { createGovernanceRouter } from '../src/governanceEndpoints.js';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

function injectPrincipal(principalId: string, tenantId = 'tenant-a') {
  return (req: Request, _res: Response, next: () => void) => {
    req.user = { id: principalId, username: principalId, role: 'admin', tenantId };
    req.tenantId = tenantId;
    next();
  };
}

function buildApp(manager: CheckpointManager): express.Express {
  const app = express();
  app.use(express.json());
  app.use(injectPrincipal('admin-a'));
  app.use('/api/governance', createGovernanceRouter(manager));
  return app;
}

describe('LM-24: GET /checkpoints/stats is reachable', () => {
  it('answers with statistics rather than the dynamic-route 404', async () => {
    const manager = new CheckpointManager();
    manager.create(
      'mission-stats',
      'task-1',
      'agent-1',
      'executor',
      'deploy',
      'MANUAL',
      80,
      'HIGH',
      [],
      ['approver-a'],
      undefined,
      'tenant-a',
    );

    const { port, close } = await listen(buildApp(manager));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/governance/checkpoints/stats`);
      assert.equal(res.status, 200, 'the static /checkpoints/stats route must be selected');
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(
        Object.prototype.hasOwnProperty.call(body, 'error'),
        false,
        'the response must not be the dynamic route error body',
      );
      // `getStats` returns a statistics summary, not a single checkpoint.
      assert.equal(
        Object.prototype.hasOwnProperty.call(body, 'id'),
        false,
        'a single-checkpoint payload means the dynamic route matched',
      );
    } finally {
      await close();
    }
  });

  it('still serves a real checkpoint id through the dynamic route', async () => {
    const manager = new CheckpointManager();
    // `canViewCheckpoint` requires the caller to be a required approver (or the
    // owning agent), so the fixture names the injected principal.
    const created = manager.create(
      'mission-detail',
      'task-2',
      'agent-2',
      'executor',
      'deploy',
      'MANUAL',
      80,
      'HIGH',
      [],
      ['admin-a'],
      undefined,
      'tenant-a',
    );

    const { port, close } = await listen(buildApp(manager));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/governance/checkpoints/${created.id}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { id: string };
      assert.equal(body.id, created.id);
    } finally {
      await close();
    }
  });

  it('source: /checkpoints/stats is declared before /checkpoints/:id', () => {
    const src = fs.readFileSync(path.join(srcDir, 'governanceEndpoints.ts'), 'utf-8');
    const statsAt = src.indexOf("router.get('/checkpoints/stats'");
    const dynamicAt = src.indexOf("router.get('/checkpoints/:id'");
    assert.ok(statsAt > -1, "router.get('/checkpoints/stats') must exist");
    assert.ok(dynamicAt > -1, "router.get('/checkpoints/:id') must exist");
    assert.ok(
      statsAt < dynamicAt,
      'the static /checkpoints/stats route must be registered before the dynamic /checkpoints/:id route',
    );
  });
});
