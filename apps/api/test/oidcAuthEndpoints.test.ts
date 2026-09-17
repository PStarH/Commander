/**
 * OIDC settings security unit tests.
 *
 * Exercises the PRODUCTION `validateOidcIssuer` export and the PRODUCTION
 * `createOIDCAuthRouter` (mounted on a real Express server) for the admin-only
 * GET/PUT /api/auth/oidc/settings contract.
 *
 * AUDIT F-A-1/F-A-2: this file previously defined a local
 * `validateOidcIssuerLocal` mirror and asserted on that copy, so weakening the
 * real validator kept every test green. It now imports the real function, and
 * the route-level assertions are behavioural (status codes through the real
 * router) rather than substring matches on the source text.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'node:net';
import { createOIDCAuthRouter, validateOidcIssuer, getOIDCConfig } from '../src/oidcAuthEndpoints';
import type { UserRole } from '../src/userStore';

type Principal = { id: string; username: string; role: UserRole; tenantId?: string } | null;

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startOidc(principal: Principal): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = principal;
    next();
  });
  app.use(createOIDCAuthRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

const ADMIN: Principal = { id: 'admin-1', username: 'admin', role: 'admin' };
const VIEWER: Principal = { id: 'viewer-1', username: 'viewer', role: 'viewer' };

describe('validateOidcIssuer (production export, OIDC settings P0.1)', () => {
  afterEach(() => {
    delete process.env.OIDC_ISSUER_HOST_ALLOWLIST;
  });

  it('rejects http://evil issuer', () => {
    assert.match(validateOidcIssuer('http://evil.example.com') ?? '', /https/);
  });

  it('accepts https issuer', () => {
    assert.equal(validateOidcIssuer('https://idp.example.com'), undefined);
  });

  it('rejects malformed URL', () => {
    assert.match(validateOidcIssuer('not-a-url') ?? '', /valid URL/);
  });

  it('enforces OIDC_ISSUER_HOST_ALLOWLIST when set', () => {
    process.env.OIDC_ISSUER_HOST_ALLOWLIST = 'idp.example.com';
    assert.equal(validateOidcIssuer('https://idp.example.com'), undefined);
    assert.match(validateOidcIssuer('https://other.example.com') ?? '', /hostname/);
  });
});

describe('OIDC settings auth contract (real router, P0.1)', () => {
  for (const method of ['GET', 'PUT'] as const) {
    it(`${method} /api/auth/oidc/settings returns 401 without a principal`, async () => {
      const server = await startOidc(null);
      try {
        const res = await fetch(`${server.baseUrl}/api/auth/oidc/settings`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(method === 'PUT' ? { body: JSON.stringify({}) } : {}),
        });
        assert.equal(res.status, 401);
      } finally {
        await server.close();
      }
    });

    it(`${method} /api/auth/oidc/settings returns 403 for a viewer`, async () => {
      const server = await startOidc(VIEWER);
      try {
        const res = await fetch(`${server.baseUrl}/api/auth/oidc/settings`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(method === 'PUT' ? { body: JSON.stringify({}) } : {}),
        });
        assert.equal(res.status, 403);
      } finally {
        await server.close();
      }
    });

    it(`${method} /api/auth/oidc/settings reaches the handler for an admin`, async () => {
      const server = await startOidc(ADMIN);
      try {
        const res = await fetch(`${server.baseUrl}/api/auth/oidc/settings`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(method === 'PUT' ? { body: JSON.stringify({}) } : {}),
        });
        // F-A-2: assert the route is bound to the guard by observing that an
        // admin gets past it (401/403 must not appear) instead of grepping the
        // source for `requireRole('admin')`.
        assert.notEqual(res.status, 401);
        assert.notEqual(res.status, 403);
        assert.notEqual(res.status, 404);
      } finally {
        await server.close();
      }
    });
  }

  it('PUT rejects a non-https issuer through the production validator', async () => {
    const server = await startOidc(ADMIN);
    try {
      const res = await fetch(`${server.baseUrl}/api/auth/oidc/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          issuer: 'http://idp.example.com',
          clientId: 'cid',
          redirectUri: 'http://localhost:5173/login',
        }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { details?: Array<{ message?: string }> };
      assert.ok(
        (body.details ?? []).some((d) => /https/.test(d.message ?? '')),
        'the production issuer validator must reject the http:// issuer',
      );
    } finally {
      await server.close();
    }
  });
});

describe('getOIDCConfig reads .commander config', () => {
  afterEach(() => {
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
  });

  it('honours OIDC_ISSUER/OIDC_CLIENT_ID from the environment', () => {
    process.env.OIDC_ISSUER = 'https://idp.example.com';
    process.env.OIDC_CLIENT_ID = 'client-abc';
    // Without the env pair the accessor reads a persisted .commander file, so
    // this asserts the env precedence branch only (never "unknown === ok").
    const config = getOIDCConfig();
    assert.ok(config, 'expected a config when OIDC_ISSUER + OIDC_CLIENT_ID are set');
    assert.equal(config.issuer, 'https://idp.example.com');
    assert.equal(config.clientId, 'client-abc');
  });
});
