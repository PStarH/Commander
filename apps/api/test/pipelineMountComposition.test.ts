/**
 * Composition test: the pipeline router must not answer for routes it does not
 * own.
 *
 * `index.ts` registers `{ name: 'pipeline', mountPath: '/' }` *before* workflow,
 * namespaced-memory, a2a, a2a-v2, mcp, mcp-client, stream, cost, replay, team,
 * dlq, approval-config, hallucination and every registration after them. Because
 * the pipeline router's legacy-execution guard used to be a bare
 * `router.use((req, res, next) => …)` with no path, it matched **every** request
 * that reached it and answered 410 whenever legacy execution was disabled —
 * which is the default, since `isLegacyExecutionAllowed()` requires an explicit
 * `COMMANDER_LEGACY_EXECUTION=1`. Every later router was therefore unreachable
 * under standard defaults, V2 mode and production.
 *
 * Router-only tests cannot catch this: they mount `createPipelineRouter()` alone
 * (see l3-06GatewayResidual.test.ts), so no later registration exists to be
 * shadowed. This file reproduces the real registry ordering with a sentinel
 * handler mounted where the later routers go.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { createPipelineRouter } from '../src/pipelineEndpoints.js';
import {
  mountRegisteredRouters,
  registerRouter,
  resetRouterRegistry,
} from '../src/routerRegistry.js';

/** Sentinel body marker, so a pass-through is unambiguous. */
const SENTINEL = { reached: 'sentinel-router' };

const ENV_KEYS = ['COMMANDER_LEGACY_EXECUTION', 'COMMANDER_V2_MODE', 'NODE_ENV'] as const;
let savedEnv: Record<string, string | undefined> = {};

function saveEnv(): void {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

/** Legacy execution OFF — the default configuration. */
function withLegacyDisabled(): void {
  delete process.env.COMMANDER_LEGACY_EXECUTION;
  delete process.env.COMMANDER_V2_MODE;
  process.env.NODE_ENV = 'test';
}

/** Legacy execution explicitly ON (local compatibility mode). */
function withLegacyEnabled(): void {
  process.env.COMMANDER_LEGACY_EXECUTION = '1';
  delete process.env.COMMANDER_V2_MODE;
  process.env.NODE_ENV = 'test';
}

async function withRegistryApp(action: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  // Exactly the real ordering: pipeline first (mounted at '/'), then a router
  // standing in for the registrations that follow it.
  registerRouter({ name: 'pipeline', mountPath: '/', factory: () => createPipelineRouter() });
  registerRouter({
    name: 'sentinel',
    mountPath: '/',
    factory: () => {
      const router = express.Router();
      router.use((_req, res) => res.json(SENTINEL));
      return router;
    },
  });
  mountRegisteredRouters(app);

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

async function status(base: string, path: string, method = 'GET'): Promise<number> {
  const res = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    ...(method === 'POST'
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pattern: 'pipeline' }),
        }
      : {}),
  });
  return res.status;
}

describe('pipeline router mount composition', () => {
  beforeEach(() => {
    saveEnv();
    resetRouterRegistry();
  });

  afterEach(() => {
    restoreEnv();
    resetRouterRegistry();
  });

  describe('legacy execution disabled (default)', () => {
    it('lets unrelated later routes reach their own handler', async () => {
      withLegacyDisabled();
      await withRegistryApp(async (base) => {
        // Each of these is registered after `pipeline` in the real manifest.
        for (const path of [
          '/api/settings',
          '/api/teams/run-1/status',
          '/api/outgoing-webhooks',
          '/projects/p1/events',
          '/mcp',
        ]) {
          const res = await fetch(`${base}${path}`, { redirect: 'manual' });
          assert.strictEqual(
            res.status,
            200,
            `${path} must reach the later router, not be answered by the pipeline guard`,
          );
          assert.deepStrictEqual(await res.json(), SENTINEL);
        }
      });
    });

    it('still answers 410 for the legacy pipeline surface it owns', async () => {
      withLegacyDisabled();
      await withRegistryApp(async (base) => {
        for (const path of [
          '/api/state-machine/create',
          '/api/state-machine/sm-1',
          '/api/pipeline/runs',
          '/api/pipeline/execute',
        ]) {
          const method = path.endsWith('create') || path.endsWith('execute') ? 'POST' : 'GET';
          const res = await fetch(`${base}${path}`, {
            method,
            redirect: 'manual',
            ...(method === 'POST'
              ? {
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ pattern: 'pipeline' }),
                }
              : {}),
          });
          assert.strictEqual(res.status, 410, `${path} must stay gone`);
          const body = (await res.json()) as { error?: { code?: string } };
          assert.strictEqual(body.error?.code, 'LEGACY_EXECUTION_DISABLED');
        }
      });
    });

    it('does not swallow paths that merely share a prefix string', async () => {
      withLegacyDisabled();
      await withRegistryApp(async (base) => {
        // Prefix matching must be segment-aware: '/api/state-machineXYZ' is not
        // part of the legacy surface and must not be 410'd.
        for (const path of ['/api/state-machineXYZ', '/api/pipelineish']) {
          const res = await fetch(`${base}${path}`, { redirect: 'manual' });
          assert.strictEqual(res.status, 200, `${path} is not owned by the pipeline router`);
        }
      });
    });
  });

  it('keeps unrelated routes reachable in production', async () => {
    delete process.env.COMMANDER_LEGACY_EXECUTION;
    delete process.env.COMMANDER_V2_MODE;
    process.env.NODE_ENV = 'production';
    await withRegistryApp(async (base) => {
      assert.strictEqual(await status(base, '/api/settings'), 200);
      assert.strictEqual(await status(base, '/api/state-machine/create', 'POST'), 410);
    });
  });

  it('passes the legacy surface through to its own routes when explicitly enabled', async () => {
    withLegacyEnabled();
    await withRegistryApp(async (base) => {
      // The guard must not 410 in compatibility mode. A path the router itself
      // does not define falls through to Express' 404 — the point is only that
      // the pipeline guard let it past.
      const status404 = await status(base, '/api/pipeline/does-not-exist');
      assert.notStrictEqual(
        status404,
        410,
        'the legacy guard must not reject when legacy execution is enabled',
      );
    });
  });
});
