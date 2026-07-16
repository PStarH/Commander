/**
 * P0.2 — mission approve admin-only; approver from req.user.
 *
 * Avoid importing createProjectRouter (pulls @commander/core under tsx).
 * Assert source wiring + exercise isomorphic middleware + approve log handler.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { hasRole, type UserRole } from '../src/userStore';

const srcPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/projectEndpoints.ts',
);

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

function requireRole(requiredRole: UserRole = 'admin') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !hasRole(req.user.role, requiredRole)) {
      res.status(403).json({ error: 'Insufficient privileges' });
      return;
    }
    next();
  };
}

function injectUser(user: { id: string; username: string; role: UserRole } | null) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.user = user;
    next();
  };
}

/** Mirrors projectEndpoints approve handler security-relevant logic */
function createApproveApp(logs: string[]): Express {
  const app = express();
  app.use(express.json());
  app.post(
    '/missions/:missionId/approve',
    requireAuth,
    requireRole('admin'),
    (req, res) => {
      const { comment } = req.body as { comment?: string; approver?: string };
      const approver = req.user!.username;
      logs.push(`Mission approved by ${approver}${comment ? `: ${comment}` : ''}`);
      res.json({ id: req.params.missionId, status: 'DONE' });
    },
  );
  return app;
}

async function listen(app: Express): Promise<{ server: http.Server; base: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe('mission approve source contract (P0.2)', () => {
  it('requires admin and uses req.user.username as approver', () => {
    const src = fs.readFileSync(srcPath, 'utf-8');
    assert.match(
      src,
      /router\.post\(\s*['"]\/missions\/:missionId\/approve['"]\s*,\s*requireAuth\s*,\s*requireRole\(['"]admin['"]\)/,
    );
    assert.match(src, /const approver = req\.user!\.username/);
    assert.doesNotMatch(
      src,
      /const \{ approver,\s*comment \} = req\.body/,
    );
    assert.match(src, /bypassGovernance:\s*true/);
  });
});

describe('POST /missions/:missionId/approve behavior (P0.2)', () => {
  it('returns 401 without authentication', async () => {
    const logs: string[] = [];
    const app = express();
    app.use(express.json());
    app.use(injectUser(null));
    app.use(createApproveApp(logs));
    const { server, base } = await listen(app);
    try {
      const res = await fetch(`${base}/missions/m-1/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approver: 'forged-admin' }),
      });
      assert.equal(res.status, 401);
      assert.equal(logs.length, 0);
    } finally {
      server.close();
    }
  });

  it('returns 403 for non-admin', async () => {
    const logs: string[] = [];
    const app = express();
    app.use(express.json());
    app.use(injectUser({ id: 'u1', username: 'viewer1', role: 'viewer' }));
    app.use(createApproveApp(logs));
    const { server, base } = await listen(app);
    try {
      const res = await fetch(`${base}/missions/m-1/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approver: 'forged-admin' }),
      });
      assert.equal(res.status, 403);
      assert.equal(logs.length, 0);
    } finally {
      server.close();
    }
  });

  it('admin succeeds and logs req.user.username (ignores body.approver)', async () => {
    const logs: string[] = [];
    const app = express();
    app.use(express.json());
    app.use(injectUser({ id: 'a1', username: 'real-admin', role: 'admin' }));
    app.use(createApproveApp(logs));
    const { server, base } = await listen(app);
    try {
      const res = await fetch(`${base}/missions/m-1/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approver: 'forged-admin', comment: 'lgtm' }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status: string };
      assert.equal(body.status, 'DONE');
      assert.equal(logs.length, 1);
      assert.match(logs[0]!, /Mission approved by real-admin: lgtm/);
      assert.doesNotMatch(logs[0]!, /forged-admin/);
    } finally {
      server.close();
    }
  });
});
