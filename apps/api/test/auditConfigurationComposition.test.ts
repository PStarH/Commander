/**
 * LM-24 — audit authorization scope and configuration-event mapping
 * (api-completion#API-C04 / API-C05).
 *
 * API-C05: `createAuditLogRouter()` is mounted at `/` ahead of the onboarding
 * and saga routers. A root-level `router.use(requireAuditReader)` therefore ran
 * on *every* request that reached the mount point and rejected unrelated routes
 * for non-auditors. The guard must be attached per handler, and an unrelated
 * route registered after the audit router must still be served.
 *
 * API-C04: `config_change` records written by the approval-config producer use
 * top-level `type`/`action`/`actor`/`detail`, which the approval-audit reader
 * did not recognise — configuration changes were invisible in the audit view.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import express, { type Request, type Response } from 'express';
import { createAuditLogRouter } from '../src/auditLogEndpoints';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');

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

type Principal = { id: string; role: string; tenantId: string; scopes?: string[] } | null;

function inject(principal: Principal) {
  return (req: Request, _res: Response, next: () => void) => {
    if (principal) {
      req.user = {
        id: principal.id,
        username: principal.id,
        role: principal.role as never,
        tenantId: principal.tenantId,
      };
      req.apiScopes = principal.scopes;
      req.tenantId = principal.tenantId;
    }
    next();
  };
}

/** The eight audit handlers this router exposes. */
const AUDIT_ROUTES: Array<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/audit/logs' },
  { method: 'GET', path: '/api/audit/logs/export' },
  { method: 'GET', path: '/api/audit/stats' },
  { method: 'GET', path: '/api/audit/sources' },
  { method: 'GET', path: '/api/audit-logs' },
  { method: 'GET', path: '/api/audit-logs/stats' },
  { method: 'GET', path: '/api/audit-logs/export' },
  { method: 'GET', path: '/api/audit-logs/categories' },
];

/**
 * `viewer` sits below `auditor` in ROLE_HIERARCHY, so it is the role that must
 * be refused. (`operator` and above satisfy the auditor requirement by the
 * project's level-based hierarchy.)
 */
const NON_AUDITOR: Principal = { id: 'viewer-1', role: 'viewer', tenantId: 't-a' };

function buildApp(principal: Principal): express.Express {
  const app = express();
  app.use(express.json());
  app.use(inject(principal));
  app.use('/', createAuditLogRouter());
  // Sentinel mounted AFTER the audit router at the same root — the shape that
  // a root-level guard would have blocked.
  app.get('/api/saga/sentinel', (_req, res) => res.json({ reached: true }));
  app.get('/api/onboarding/sentinel', (_req, res) => res.json({ reached: true }));
  return app;
}

describe('LM-24: audit guard is scoped per handler', () => {
  it('does not block unrelated routes mounted after the audit router', async () => {
    const { port, close } = await listen(buildApp(NON_AUDITOR));
    try {
      for (const p of ['/api/saga/sentinel', '/api/onboarding/sentinel']) {
        const res = await fetch(`http://127.0.0.1:${port}${p}`);
        assert.equal(res.status, 200, `${p} must reach its handler for a non-auditor`);
        assert.deepEqual(await res.json(), { reached: true });
      }
    } finally {
      await close();
    }
  });

  it('rejects anonymous callers with 401 on all eight handlers', async () => {
    const { port, close } = await listen(buildApp(null));
    try {
      for (const route of AUDIT_ROUTES) {
        const res = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method });
        assert.equal(res.status, 401, `${route.path} must require authentication`);
      }
    } finally {
      await close();
    }
  });

  it('rejects a non-auditor with 403 on all eight handlers', async () => {
    const { port, close } = await listen(buildApp(NON_AUDITOR));
    try {
      for (const route of AUDIT_ROUTES) {
        const res = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method });
        assert.equal(res.status, 403, `${route.path} must require audit authority`);
      }
    } finally {
      await close();
    }
  });

  it('admits an auditor (guard passes, not 401/403)', async () => {
    const { port, close } = await listen(
      buildApp({ id: 'aud-1', role: 'auditor', tenantId: 't-a' }),
    );
    try {
      for (const route of AUDIT_ROUTES) {
        const res = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method });
        assert.notEqual(res.status, 401, `${route.path} must admit an auditor`);
        assert.notEqual(res.status, 403, `${route.path} must admit an auditor`);
      }
    } finally {
      await close();
    }
  });

  it('rejects an auditor with no tenant binding (403)', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: () => void) => {
      req.user = { id: 'aud-1', username: 'aud-1', role: 'auditor' as never };
      next();
    });
    app.use('/', createAuditLogRouter());
    const { port, close } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/audit/logs`);
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });

  it('source: no root-level router.use(requireAuditReader)', () => {
    const raw = fs.readFileSync(path.join(testDir, '../src/auditLogEndpoints.ts'), 'utf-8');
    // Strip comments first: the module documents the removed root guard in a
    // comment, and a naive match would flag that prose.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(
      code,
      /router\.use\(/,
      'a root-level guard would block unrelated routers mounted after this one',
    );
  });
});

describe('LM-24: config_change records are visible to the approval-audit reader', () => {
  it('maps actor/action/detail and keeps tenant scoping', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lm24-audit-'));
    try {
      // Run the fixture from an owned temp cwd so the audit log it writes lands
      // outside the repository, while `tsx` and the fixture resolve from the
      // repo. The fixture's own imports are relative to its real location.
      const stdout = execFileSync(
        path.join(repoRoot, 'node_modules/.bin/tsx'),
        [path.join(testDir, '_helpers/auditConfigCompositionChild.ts')],
        { cwd: tmp, encoding: 'utf-8', env: { ...process.env, NODE_OPTIONS: '' } },
      );
      const parsed = JSON.parse(stdout.trim().split('\n').pop() as string) as {
        status: number;
        entries: Array<{ event?: string; userId?: string; tenantId?: string; details?: unknown }>;
        total: number;
      };

      assert.equal(parsed.status, 200);
      assert.equal(parsed.total, 2, 'the foreign-tenant record must be excluded');

      const configChange = parsed.entries.find((e) => e.event === 'config_change');
      assert.ok(configChange, 'the config_change record must be surfaced');
      assert.equal(configChange.userId, 'user-actor', 'actor must map to userId');
      assert.equal(configChange.tenantId, 'tenant-a');
      assert.deepEqual(configChange.details, {
        action: 'approval.mode.set',
        detail: { mode: 'manual' },
      });

      const legacy = parsed.entries.find((e) => e.event === 'approval.decision');
      assert.ok(legacy, 'legacy approval records must still pass through');

      assert.equal(
        parsed.entries.some((e) => e.userId === 'other-tenant-actor'),
        false,
        'a caller-supplied tenantId must not widen the scope',
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
