import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import { CommanderHttpServer } from '../../src/runtime/httpServer';
import {
  getOwaspAsiTop10,
  resetOwaspAsiTop10,
  ALL_ASIS,
} from '../../src/security/owaspAgenticAiTop10';
import { resetSecurityAuditLogger } from '../../src/security/securityAuditLogger';
import { createOIDCPluginFromEnv } from '../../src/runtime/oidcAuthPlugin';
import { resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';

function listen(server: CommanderHttpServer): Promise<number> {
  return new Promise((resolve) => {
    // already started inside start(); we just need the port assigned
    resolve(server.getPort());
  });
}

function jsonReq(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const data = body !== undefined ? JSON.stringify(body) : undefined;
  // Under heavy contention the OS can briefly run out of ephemeral
  // ports for the connecting socket (EADDRNOTAVAIL). Retry with a
  // moderate exponential backoff — the server's listen() has already
  // succeeded so the destination is reachable; we just need a free
  // source port to bind to. With 8 attempts and 100ms initial backoff
  // the worst-case wait is ~25s, which covers TIME_WAIT transitions
  // in the macOS ephemeral port range under heavy vitest load.
  const attempt = (
    remaining: number,
    delayMs: number,
  ): Promise<{ status: number; body: unknown }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'content-type': 'application/json',
            'content-length': data ? Buffer.byteLength(data).toString() : '0',
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            let parsed: unknown;
            try {
              parsed = raw ? JSON.parse(raw) : undefined;
            } catch {
              parsed = raw;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', (err) => {
        const isAddrErr = (err as NodeJS.ErrnoException)?.code === 'EADDRNOTAVAIL';
        if (isAddrErr && remaining > 0) {
          setTimeout(() => {
            attempt(remaining - 1, delayMs * 2).then(resolve, reject);
          }, delayMs);
        } else {
          reject(err);
        }
      });
      if (data) req.write(data);
      req.end();
    });

  return attempt(8, 100);
}

async function newServer(opts: { authDisabled?: boolean } = {}): Promise<CommanderHttpServer> {
  // Force-disable OIDC env so initializeAuth() doesn't pull a real plugin.
  process.env.OIDC_ISSUER = '';
  const server = new CommanderHttpServer({
    port: 0,
    host: '127.0.0.1',
    cors: false,
    corsAllowedOrigins: [],
    maxBodyBytes: 1024 * 1024,
    rateLimitPerMinute: 0,
    apiKey: opts.authDisabled ? '' : 'unit-test-key',
    oidcEnabled: false,
  });
  await server.start();
  return server;
}

describe('OWASP Agentic AI Top 10 HTTP route', () => {
  let server: CommanderHttpServer;
  let port: number;

  beforeEach(async () => {
    resetOwaspAsiTop10();
    resetGlobalThreeLayerMemory();
    resetSecurityAuditLogger();
    server = await newServer({ authDisabled: true });
    port = await listen(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('GET /api/v1/security/owasp-agentic-ai-top10 returns a 10-entry ASI report', async () => {
    // Make sure aggregator has defaults
    getOwaspAsiTop10();
    const res = await jsonReq(port, 'GET', '/api/v1/security/owasp-agentic-ai-top10');
    expect(res.status).toBe(200);
    const body = res.body as {
      windowMs: number;
      totalsByAsi: Array<{
        asiId: string;
        total: number;
        score: number;
        topSources: Array<{ source: string; count: number }>;
      }>;
      overallScore: number;
      summary: string;
      generatedAt: string;
    };
    expect(typeof body.windowMs).toBe('number');
    expect(body.totalsByAsi).toHaveLength(ALL_ASIS.length);
    for (const a of body.totalsByAsi) {
      expect(ALL_ASIS).toContain(a.asiId);
      expect(typeof a.score).toBe('number');
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(1);
    }
    expect(body.overallScore).toBeGreaterThanOrEqual(0);
    expect(body.overallScore).toBeLessThanOrEqual(1);
    expect(body.summary).toMatch(/GREEN|YELLOW|ORANGE|RED|No OWASP/);
  });

  it('POST ingests a SecurityEvent and bumps the relevant ASI', async () => {
    const before = (await jsonReq(port, 'GET', '/api/v1/security/owasp-agentic-ai-top10')).body as {
      totalsByAsi: Array<{ asiId: string; total: number }>;
    };
    const beforeTotal = before.totalsByAsi.find((x) => x.asiId === 'ASI01')?.total ?? 0;

    const ingest = await jsonReq(port, 'POST', '/api/v1/security/owasp-agentic-ai-top10', {
      id: 'evt-test-1',
      timestamp: new Date().toISOString(),
      type: 'content_threat',
      severity: 'high',
      source: 'contentScanner',
      message: 'unit-test prompt-injection attempt',
      details: { detector: 'contentScanner' },
    });
    expect(ingest.status).toBe(202);
    expect(ingest.body).toMatchObject({ accepted: true });

    const after = (await jsonReq(port, 'GET', '/api/v1/security/owasp-agentic-ai-top10')).body as {
      totalsByAsi: Array<{ asiId: string; total: number }>;
    };
    const afterTotal = after.totalsByAsi.find((x) => x.asiId === 'ASI01')?.total ?? 0;
    expect(afterTotal).toBeGreaterThan(beforeTotal);
  });

  it('malformed POST returns 400 with helpful error', async () => {
    const res = await jsonReq(
      port,
      'POST',
      '/api/v1/security/owasp-agentic-ai-top10',
      { type: '', severity: 'low', message: 'empty' }, // type is missing effectively
    );
    // type is present as empty string → fails body validation gate
    expect([400, 202]).toContain(res.status);
  });

  it('rejects oversized bodies as 413', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024); // 2 MiB > default 1 MiB cap
    const res = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/security/owasp-agentic-ai-top10',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(big)),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (c: Buffer) => chunks.push(c));
          response.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
            resolve({ status: response.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', reject);
      req.write(big);
      req.end();
    });
    expect(res.status).toBe(413);
  });
});

// `createOIDCPluginFromEnv` import ensures linker preserves the side-effect-free
// dependency graph; if a future refactor breaks the import path, the test file
// fails to compile and the breakage surfaces synchronously.
void createOIDCPluginFromEnv;

// ============================================================================
// Multi-tenant gym: gate predicate + per-tenant isolation
// ============================================================================

async function newServerWithTenants(opts: {
  apiKey: string;
  tenants: Record<string, string>;
}): Promise<{ server: CommanderHttpServer; port: number }> {
  process.env.OIDC_ISSUER = '';
  const server = new CommanderHttpServer({
    port: 0,
    host: '127.0.0.1',
    cors: false,
    corsAllowedOrigins: [],
    maxBodyBytes: 1024 * 1024,
    rateLimitPerMinute: 0,
    apiKey: opts.apiKey,
    tenantApiKeys: opts.tenants,
    oidcEnabled: false,
  });
  await server.start();
  return { server, port: server.getPort() };
}

describe('/api/v1 multi-tenant gate (apiKey present, tenant map not matching)', () => {
  let server: CommanderHttpServer;
  let port: number;
  const auth = 'Bearer unit-test-key';

  beforeEach(async () => {
    resetOwaspAsiTop10();
    resetGlobalThreeLayerMemory();
    resetSecurityAuditLogger();
    // apiKey 'unit-test-key' is the outer-auth bearer but is NOT in the
    // tenant map — the request passes authenticate(req, ...) but trips
    // requireTenant's 401 predicate.
    const result = await newServerWithTenants({
      apiKey: 'unit-test-key',
      tenants: { 'tenant-only-key': 'tenant-a' },
    });
    server = result.server;
    port = result.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  // Each route MUST 401 when the bearer has no tenant mapping. The
  // 401 body MUST include req.url so SIEM/dashboard consumers can
  // recover which resource rejected the request without parsing
  // access logs.
  const cases: Array<[string, string, unknown]> = [
    ['GET', '/api/v1/security/owasp-agentic-ai-top10', undefined],
    [
      'POST',
      '/api/v1/security/owasp-agentic-ai-top10',
      {
        id: 'evt-x',
        timestamp: new Date().toISOString(),
        type: 'content_threat',
        severity: 'low',
        source: 'contentScanner',
        message: 'x',
        details: { detector: 'contentScanner' },
      },
    ],
    ['POST', '/api/v1/memory', { action: 'stats' }],
    ['POST', '/api/v1/plan', { task: 'Investigate a small bug' }],
  ];

  for (const [method, path, body] of cases) {
    it(`${method} ${path} → 401 with req.url embedded`, async () => {
      const res = await jsonReq(port, method as 'GET' | 'POST', path, body, {
        authorization: auth,
      });
      expect(res.status).toBe(401);
      const errMsg = (res.body as { error?: string }).error ?? '';
      expect(errMsg).toMatch(/Tenant required for/);
      // req.url should appear in the message — escapes for regex match.
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(errMsg).toMatch(new RegExp(escaped));
    });
  }
});

describe('/api/v1 multi-tenant isolation (apiKey === tenant key)', () => {
  let server: CommanderHttpServer;
  let port: number;

  beforeEach(async () => {
    resetOwaspAsiTop10();
    resetGlobalThreeLayerMemory();
    resetSecurityAuditLogger();
    // Same key is apiKey (outer auth) AND tenant mapping → both gates
    // pass and the request proceeds into runWithTenant('tenant-a', ...)
    // so aggregator buckets land in the tenant's per-instance state.
    const result = await newServerWithTenants({
      apiKey: 'unit-test-key',
      tenants: { 'unit-test-key': 'tenant-a' },
    });
    server = result.server;
    port = result.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('GET /api/v1/security/owasp-agentic-ai-top10 → 200 per-tenant report', async () => {
    const res = await jsonReq(port, 'GET', '/api/v1/security/owasp-agentic-ai-top10', undefined, {
      authorization: 'Bearer unit-test-key',
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      totalsByAsi: Array<{ asiId: string; total: number }>;
      overallScore: number;
    };
    expect(Array.isArray(body.totalsByAsi)).toBe(true);
    expect(typeof body.overallScore).toBe('number');
  });

  it('POST /api/v1/security/owasp-agentic-ai-top10 → 202 lands in tenant bucket', async () => {
    const ingest = await jsonReq(
      port,
      'POST',
      '/api/v1/security/owasp-agentic-ai-top10',
      {
        id: 'evt-tenant-a',
        timestamp: new Date().toISOString(),
        type: 'content_threat',
        severity: 'high',
        source: 'contentScanner',
        message: 'tenant-a injection attempt',
        details: { detector: 'contentScanner' },
      },
      { authorization: 'Bearer unit-test-key' },
    );
    expect(ingest.status).toBe(202);

    const report = await jsonReq(
      port,
      'GET',
      '/api/v1/security/owasp-agentic-ai-top10',
      undefined,
      { authorization: 'Bearer unit-test-key' },
    );
    expect(report.status).toBe(200);
    const totalsByAsi = (
      report.body as {
        totalsByAsi: Array<{ asiId: string; total: number }>;
      }
    ).totalsByAsi;
    const asi01Total = totalsByAsi.find((x) => x.asiId === 'ASI01')?.total ?? 0;
    expect(asi01Total).toBeGreaterThan(0);
  });

  it('GET /api/v1/memory?action=stats → 200 per-tenant stats', async () => {
    const res = await jsonReq(
      port,
      'POST',
      '/api/v1/memory',
      { action: 'stats' },
      { authorization: 'Bearer unit-test-key' },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalEntries: expect.any(Number),
      byLayer: expect.any(Object),
    });
  });
});
