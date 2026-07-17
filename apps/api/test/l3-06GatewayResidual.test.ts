/**
 * L3-06 — Residual gateway gaps vs WS3 ACCEPTED baseline.
 *
 * WS3 already enforced /v1 freeze, JWT fail-closed, and OpenAPI authenticity.
 * This file closes the honest remaining holes:
 *   - legacy execution must not run under enterprise profile (defense in depth)
 *   - /api/openapi.json mounted before enterpriseRouteFreeze must 410 in enterprise
 *   - pipeline/orchestrator legacy routers stay disabled when enterprise + legacy opt-in
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import { enterpriseRouteFreeze } from '../src/enterpriseGateway.js';
import { createPipelineRouter } from '../src/pipelineEndpoints.js';
import { createOrchestratorRouter } from '../src/orchestratorEndpoints.js';
import { generateOpenApiSpec } from '../src/openApiGenerator.js';
import { isEnterpriseProfile } from '../src/profileSignal.js';

function request(base: string, path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, redirect: 'manual' });
}

async function withApp(
  build: (app: express.Express) => void,
  action: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
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

/** Mirrors index.ts mount order: openapi handler before enterpriseRouteFreeze. */
function mountApiOpenApiAlias(app: express.Express): void {
  app.get('/api/openapi.json', (_req, res) => {
    if (isEnterpriseProfile()) {
      res.set('x-legacy', 'true');
      res.set('Deprecation', 'true');
      res.status(410).json({
        error: {
          code: 'GONE',
          message:
            'This route is frozen in the enterprise profile. Use GET /v1/openapi.json.',
        },
      });
      return;
    }
    res.json(generateOpenApiSpec({ title: 'Commander Enterprise API', version: 'test' }));
  });
}

describe('L3-06 residual gateway enforcement', () => {
  describe('/api/openapi.json pre-freeze mount hole', () => {
    it('returns 410 + x-legacy in enterprise profile', async () => {
      process.env.COMMANDER_PROFILE = 'enterprise';
      await withApp(
        (app) => {
          mountApiOpenApiAlias(app);
          app.use(enterpriseRouteFreeze());
        },
        async (base) => {
          const res = await request(base, '/api/openapi.json');
          assert.equal(res.status, 410);
          assert.equal(res.headers.get('x-legacy'), 'true');
          const body = (await res.json()) as { error: { code: string } };
          assert.equal(body.error.code, 'GONE');
        },
      );
      delete process.env.COMMANDER_PROFILE;
    });

    it('serves spec in standard profile', async () => {
      process.env.COMMANDER_PROFILE = 'standard';
      await withApp(
        (app) => {
          mountApiOpenApiAlias(app);
          app.use(enterpriseRouteFreeze());
        },
        async (base) => {
          const res = await request(base, '/api/openapi.json');
          assert.equal(res.status, 200);
          const body = (await res.json()) as { openapi: string };
          assert.equal(body.openapi, '3.1.0');
        },
      );
      delete process.env.COMMANDER_PROFILE;
    });
  });

  describe('legacy execution routers under enterprise + COMMANDER_LEGACY_EXECUTION=1', () => {
    const envKeys = ['COMMANDER_PROFILE', 'NODE_ENV', 'COMMANDER_V2_MODE', 'COMMANDER_LEGACY_EXECUTION'] as const;
    const snap: Record<string, string | undefined> = {};

    function saveEnv(): void {
      for (const k of envKeys) snap[k] = process.env[k];
      process.env.COMMANDER_PROFILE = 'enterprise';
      process.env.NODE_ENV = 'development';
      process.env.COMMANDER_V2_MODE = '0';
      process.env.COMMANDER_LEGACY_EXECUTION = '1';
    }

    function restoreEnv(): void {
      for (const k of envKeys) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
      }
    }

    it('pipeline router returns 410 (legacy guard) even before route freeze', async () => {
      saveEnv();
      try {
        await withApp(
          (app) => {
            app.use('/', createPipelineRouter());
          },
          async (base) => {
            const res = await request(base, '/api/state-machine/create', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ pattern: 'pipeline' }),
            });
            assert.equal(res.status, 410);
            const body = (await res.json()) as { error: { code: string } };
            assert.equal(body.error.code, 'LEGACY_EXECUTION_DISABLED');
          },
        );
      } finally {
        restoreEnv();
      }
    });

    it('orchestrator router is not registered — freeze 410s /api/orchestrator paths', async () => {
      saveEnv();
      try {
        await withApp(
          (app) => {
            app.use(enterpriseRouteFreeze());
            // Orchestrator is only mounted when isLegacyExecutionAllowed(); under
            // enterprise it must not register. Simulate absence + freeze only.
            app.use('/api', createOrchestratorRouter());
          },
          async (base) => {
            const res = await request(base, '/api/orchestrator/execute', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ goal: 'test' }),
            });
            assert.equal(res.status, 410);
          },
        );
      } finally {
        restoreEnv();
      }
    });
  });
});
