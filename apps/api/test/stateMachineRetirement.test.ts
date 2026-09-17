/**
 * LM-23 — legacy state-machine retirement.
 *
 * The apps/api task `StateMachine` is **not** the V2 run/step authority
 * (contracts + kernel own that). LM-23 decides it must be retired as an
 * execution surface rather than repaired into a second approval/execution
 * chain: every legacy execution route answers 410 with a pointer to the
 * canonical resource, and `GET /types` must not be swallowed by the dynamic
 * `/:taskId` route (API-C03).
 *
 * Auth semantics are preserved: an anonymous approve/reject still fails closed
 * with 401 *before* the retirement 410 is advertised.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import stateMachineRouter from '../src/stateMachineEndpoints';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const STATE_MACHINE_DIR = path.resolve(srcDir, '../data/state-machines');

function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/state-machine', stateMachineRouter);
  // Sentinel: an unrelated router must stay reachable. The retirement gate must
  // be scoped to this router, never a root catch-all.
  app.get('/api/sentinel', (_req, res) => res.json({ ok: true }));
  return app;
}

async function listen(app: Express): Promise<{ server: http.Server; base: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

const ENV_KEYS = [
  'NODE_ENV',
  'COMMANDER_V2_MODE',
  'COMMANDER_LEGACY_EXECUTION',
  'COMMANDER_PROFILE',
  'COMMANDER_ENV',
] as const;

const snapshot: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) snapshot[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

/** Apply a deployment mode; none of these may enable legacy execution. */
function applyRetiredMode(mode: 'default' | 'v2' | 'production' | 'enterprise'): void {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NODE_ENV = 'development';
  if (mode === 'v2') process.env.COMMANDER_V2_MODE = '1';
  if (mode === 'production') process.env.NODE_ENV = 'production';
  if (mode === 'enterprise') process.env.COMMANDER_PROFILE = 'enterprise';
}

const RETIRED_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  {
    method: 'POST',
    path: '/api/state-machine/create',
    body: { taskId: 't', projectId: 'p', agentId: 'a' },
  },
  { method: 'POST', path: '/api/state-machine/t/transition', body: { toState: 'done' } },
  { method: 'POST', path: '/api/state-machine/t/resume', body: { checkpointId: 'c' } },
  { method: 'GET', path: '/api/state-machine/t' },
  { method: 'GET', path: '/api/state-machine/t/summary' },
  { method: 'GET', path: '/api/state-machine/t/memory' },
  { method: 'POST', path: '/api/state-machine/t/memory', body: { key: 'k', value: 'v' } },
  { method: 'GET', path: '/api/state-machine/types' },
];

describe('LM-23: legacy state machine is retired, not re-implemented', () => {
  for (const mode of ['default', 'v2', 'production', 'enterprise'] as const) {
    it(`retires every execution route in mode "${mode}" with 410 and writes no state`, async () => {
      applyRetiredMode(mode);
      const { server, base } = await listen(createApp());
      const before = fs.existsSync(STATE_MACHINE_DIR)
        ? new Set(fs.readdirSync(STATE_MACHINE_DIR))
        : new Set<string>();
      try {
        for (const route of RETIRED_ROUTES) {
          const res = await fetch(`${base}${route.path}`, {
            method: route.method,
            headers: { 'content-type': 'application/json' },
            body: route.body === undefined ? undefined : JSON.stringify(route.body),
          });
          assert.equal(
            res.status,
            410,
            `${route.method} ${route.path} must be retired in mode "${mode}"`,
          );
          const body = (await res.json()) as { error: { code: string; replacement: string } };
          assert.equal(body.error.code, 'LEGACY_EXECUTION_DISABLED');
          assert.equal(body.error.replacement, 'POST /v1/runs');
        }
      } finally {
        server.close();
      }

      const after = fs.existsSync(STATE_MACHINE_DIR)
        ? new Set(fs.readdirSync(STATE_MACHINE_DIR))
        : new Set<string>();
      const added = [...after].filter((f) => !before.has(f));
      assert.deepEqual(added, [], 'a retired route must not persist task state');
    });
  }

  it('fails closed with 401 for anonymous approve before advertising 410', async () => {
    applyRetiredMode('default');
    const { server, base } = await listen(createApp());
    try {
      for (const action of ['approve', 'reject']) {
        const res = await fetch(`${base}/api/state-machine/t/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision: 'approve' }),
        });
        assert.equal(res.status, 401, `${action} must fail closed on auth first`);
        assert.equal(res.status === 410, false);
      }
    } finally {
      server.close();
    }
  });

  it('keeps an unrelated router reachable (no root catch-all)', async () => {
    applyRetiredMode('default');
    const { server, base } = await listen(createApp());
    try {
      const res = await fetch(`${base}/api/sentinel`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    } finally {
      server.close();
    }
  });

  it('GET /types is not captured by the dynamic /:taskId route', async () => {
    // Enable legacy execution so routing order is observable at all: with the
    // gate active every route is 410 and the ordering bug stays hidden.
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = 'development';
    process.env.COMMANDER_LEGACY_EXECUTION = '1';

    const { server, base } = await listen(createApp());
    try {
      const typesRes = await fetch(`${base}/api/state-machine/types`);
      assert.equal(typesRes.status, 200, 'the static /types route must be reachable');
      const typesBody = (await typesRes.json()) as { success: boolean; types: unknown[] };
      assert.equal(typesBody.success, true);
      assert.ok(Array.isArray(typesBody.types), 'types must be a catalogue array');

      // The exact pre-fix symptom: /types answered as a missing task.
      const unknownRes = await fetch(`${base}/api/state-machine/definitely-not-a-task`);
      assert.equal(unknownRes.status, 404);
      const unknownBody = (await unknownRes.json()) as { error: string };
      assert.equal(unknownBody.error, 'State machine not found');
      assert.notDeepEqual(typesBody, unknownBody, '/types must not be the missing-task response');
    } finally {
      server.close();
    }
  });

  it('source: /types is declared before the dynamic /:taskId route', () => {
    const src = fs.readFileSync(path.join(srcDir, 'stateMachineEndpoints.ts'), 'utf-8');
    const typesAt = src.indexOf("router.get('/types'");
    const dynamicAt = src.indexOf("router.get('/:taskId'");
    assert.ok(typesAt > -1, "router.get('/types') must exist");
    assert.ok(dynamicAt > -1, "router.get('/:taskId') must exist");
    assert.ok(
      typesAt < dynamicAt,
      'the static /types route must be registered before the dynamic /:taskId route',
    );
  });
});
