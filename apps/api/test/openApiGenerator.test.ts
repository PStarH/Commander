import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import express, { type RequestHandler } from 'express';
import {
  registerRouter,
  resetRouterRegistry,
  type RouterRegistration,
} from '../src/routerRegistry.js';
import { generateOpenApiSpec, type OpenApiMeta } from '../src/openApiGenerator.js';

// ── Test helpers ────────────────────────────────────────────────────────────

function makeRouter(routes: Array<{ method: 'get' | 'post' | 'patch' | 'put' | 'delete'; path: string }>): RequestHandler {
  const router = express.Router();
  for (const r of routes) {
    router[r.method](r.path, (_req, res) => res.json({ ok: true }));
  }
  return router;
}

function reg(
  overrides: Partial<RouterRegistration> & { mountPath: string; factory: () => RequestHandler },
): void {
  registerRouter({
    name: overrides.name ?? 'test',
    mountPath: overrides.mountPath,
    factory: overrides.factory,
    openapi: overrides.openapi,
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('openApiGenerator — spec §4 authenticity', () => {
  beforeEach(() => resetRouterRegistry());

  describe('route extraction', () => {
    it('generates paths matching registered routes (no more, no less)', () => {
      reg({
        name: 'v1-runs',
        mountPath: '/v1',
        factory: () =>
          makeRouter([
            { method: 'get', path: '/runs/:runId' },
            { method: 'post', path: '/runs' },
            { method: 'get', path: '/runs/:runId/events' },
            { method: 'get', path: '/runs/:runId/status' },
            { method: 'post', path: '/runs/:runId/pause' },
            { method: 'post', path: '/runs/:runId/resume' },
            { method: 'post', path: '/runs/:runId/cancel' },
          ]),
      });

      const spec = generateOpenApiSpec({ title: 'Test', version: '1.0.0' });

      // Core /v1/runs surface from v1GatewayEndpoints
      assert.ok(spec.paths['/v1/runs'], '/v1/runs should exist');
      assert.ok(spec.paths['/v1/runs'].post, 'POST /v1/runs should exist');
      assert.ok(spec.paths['/v1/runs/{runId}'], '/v1/runs/{runId} should exist');
      assert.ok(spec.paths['/v1/runs/{runId}'].get, 'GET /v1/runs/{runId} should exist');
      assert.ok(spec.paths['/v1/runs/{runId}/events'], 'events path should exist');
      assert.ok(spec.paths['/v1/runs/{runId}/status'], 'status path should exist');
      assert.ok(spec.paths['/v1/runs/{runId}/pause'], 'pause path should exist');
      assert.ok(spec.paths['/v1/runs/{runId}/resume'], 'resume path should exist');
      assert.ok(spec.paths['/v1/runs/{runId}/cancel'], 'cancel path should exist');

      // Should NOT have any unregistered paths
      const expectedPaths = new Set([
        '/v1/runs',
        '/v1/runs/{runId}',
        '/v1/runs/{runId}/events',
        '/v1/runs/{runId}/status',
        '/v1/runs/{runId}/pause',
        '/v1/runs/{runId}/resume',
        '/v1/runs/{runId}/cancel',
        // Auto-injected metadata/health paths (§4.1 + §6.1)
        '/v1/openapi.json',
        '/v1/health',
      ]);
      const actualPaths = new Set(Object.keys(spec.paths));
      for (const p of actualPaths) {
        assert.ok(expectedPaths.has(p), `unexpected path in spec: ${p}`);
      }
      for (const p of expectedPaths) {
        assert.ok(actualPaths.has(p), `missing expected path: ${p}`);
      }
    });

    it('converts :param to {param} in OpenAPI paths', () => {
      reg({
        name: 'params',
        mountPath: '/v1',
        factory: () =>
          makeRouter([
            { method: 'get', path: '/projects/:projectId/memory/:memoryId' },
          ]),
      });

      const spec = generateOpenApiSpec({ title: 'Test', version: '1.0.0' });
      assert.ok(spec.paths['/v1/projects/{projectId}/memory/{memoryId}']);
    });

    it('handles root mountPath ("/") without double slashes', () => {
      reg({
        name: 'root-mounted',
        mountPath: '/',
        factory: () =>
          makeRouter([
            { method: 'get', path: '/projects' },
            { method: 'get', path: '/projects/:projectId/war-room' },
          ]),
      });

      const spec = generateOpenApiSpec({ title: 'Test', version: '1.0.0' });
      assert.ok(spec.paths['/projects'], 'should be /projects not //projects');
      assert.ok(spec.paths['/projects/{projectId}/war-room']);
    });
  });

  describe('metadata application', () => {
    it('applies registration-level openapi tags to all routes', () => {
      reg({
        name: 'tagged',
        mountPath: '/v1',
        openapi: { tags: ['Runs'] } as OpenApiMeta,
        factory: () =>
          makeRouter([
            { method: 'post', path: '/runs' },
            { method: 'get', path: '/runs/:runId' },
          ]),
      });

      const spec = generateOpenApiSpec({ title: 'Test', version: '1.0.0' });
      assert.deepEqual(spec.paths['/v1/runs'].post.tags, ['Runs']);
      assert.deepEqual(spec.paths['/v1/runs/{runId}'].get.tags, ['Runs']);
    });

    it('marks non-/v1 routes with x-legacy and deprecated', () => {
      reg({
        name: 'legacy',
        mountPath: '/api',
        factory: () =>
          makeRouter([
            { method: 'get', path: '/projects' },
          ]),
      });

      const spec = generateOpenApiSpec({ title: 'Test', version: '1.0.0' });
      const op = spec.paths['/api/projects'].get;
      assert.equal(op['x-legacy'], true, 'non-/v1 route should have x-legacy: true');
      assert.equal(op.deprecated, true, 'non-/v1 route should be deprecated');
    });

    it('does NOT mark /v1 routes as x-legacy or deprecated', () => {
      reg({
        name: 'v1',
        mountPath: '/v1',
        factory: () =>
          makeRouter([
            { method: 'post', path: '/runs' },
          ]),
      });

      const spec = generateOpenApiSpec({ title: 'Test', version: '1.0.0' });
      const op = spec.paths['/v1/runs'].post;
      assert.equal(op['x-legacy'], undefined, '/v1 route should not have x-legacy');
      assert.equal(op.deprecated, undefined, '/v1 route should not be deprecated');
    });

    it('does NOT mark ops paths (/health, /ready, /metrics) as x-legacy', () => {
      reg({
        name: 'ops',
        mountPath: '/',
        factory: () =>
          makeRouter([
            { method: 'get', path: '/health' },
            { method: 'get', path: '/ready' },
          ]),
      });

      const spec = generateOpenApiSpec({ title: 'Test', version: '1.0.0' });
      assert.equal(spec.paths['/health'].get['x-legacy'], undefined);
      assert.equal(spec.paths['/health'].get.deprecated, undefined);
      assert.equal(spec.paths['/ready'].get['x-legacy'], undefined);
    });
  });

  describe('built-in metadata paths', () => {
    it('includes /v1/openapi.json as a self-describing path', () => {
      const spec = generateOpenApiSpec({ title: 'Test', version: '1.0.0' });
      assert.ok(spec.paths['/v1/openapi.json']);
      assert.ok(spec.paths['/v1/openapi.json'].get);
      assert.equal(spec.paths['/v1/openapi.json'].get['x-legacy'], undefined);
    });

    it('includes /v1/health as a path', () => {
      const spec = generateOpenApiSpec({ title: 'Test', version: '1.0.0' });
      assert.ok(spec.paths['/v1/health']);
      assert.ok(spec.paths['/v1/health'].get);
    });
  });

  describe('OpenAPI document structure', () => {
    it('produces a valid OpenAPI 3.1 document', () => {
      const spec = generateOpenApiSpec({ title: 'Commander API', version: '2.0.0' });
      assert.equal(spec.openapi, '3.1.0');
      assert.equal(spec.info.title, 'Commander API');
      assert.equal(spec.info.version, '2.0.0');
      assert.ok(Array.isArray(spec.servers));
      assert.ok(spec.servers.length > 0);
      assert.ok(typeof spec.paths === 'object');
    });

    it('includes security scheme for Bearer JWT', () => {
      const spec = generateOpenApiSpec({ title: 'Test', version: '1.0.0' });
      assert.ok(spec.components?.securitySchemes?.bearerAuth);
      const scheme = spec.components!.securitySchemes!.bearerAuth as any;
      assert.equal(scheme.type, 'http');
      assert.equal(scheme.scheme, 'bearer');
      assert.equal(scheme.bearerFormat, 'JWT');
    });
  });

  describe('authenticity invariant (§4.2)', () => {
    it('no unregistered paths appear in the spec', () => {
      reg({
        name: 'v1',
        mountPath: '/v1',
        factory: () =>
          makeRouter([
            { method: 'post', path: '/runs' },
          ]),
      });

      const spec = generateOpenApiSpec({ title: 'Test', version: '1.0.0' });
      const paths = Object.keys(spec.paths);
      // Only registered route + auto-injected metadata paths
      for (const p of paths) {
        const isRegistered = p === '/v1/runs';
        const isMeta = p === '/v1/openapi.json' || p === '/v1/health';
        assert.ok(
          isRegistered || isMeta,
          `path ${p} is neither registered nor a known metadata path`,
        );
      }
    });

    it('skips middleware-only registrations (no routes in router)', () => {
      reg({
        name: 'middleware-only',
        mountPath: '/v1',
        factory: () => (_req, _res, next) => { next(); },
      });

      const spec = generateOpenApiSpec({ title: 'Test', version: '1.0.0' });
      // Should only have the auto-injected metadata paths
      const paths = Object.keys(spec.paths);
      for (const p of paths) {
        const isMeta = p === '/v1/openapi.json' || p === '/v1/health';
        assert.ok(isMeta, `unexpected non-meta path: ${p}`);
      }
    });
  });
});
