#!/usr/bin/env tsx
/**
 * P0 kernel e2e scaffold — Architecture V2 closure probe.
 *
 * What this script proves TODAY (wiring):
 *   - Optional: API /health is reachable
 *   - Optional: POST /v1/runs is accepted when kernel is configured
 *
 * What this script does NOT yet prove (owned by Claude C1/C2):
 *   - workerGeneration fencing on claim/complete/fail
 *   - kill worker → reclaim without double execution
 *   - run reaches a terminal state via real worker execution
 *
 * Usage:
 *   pnpm p0:kernel-e2e
 *   P0_API_BASE=http://localhost:4000 P0_API_KEY=... pnpm p0:kernel-e2e
 *   P0_REQUIRE_TERMINAL=1 pnpm p0:kernel-e2e   # fail if run never terminals
 *
 * Exit codes:
 *   0 — probes that were requested and available passed
 *   2 — configuration missing (API down / kernel 503) — expected pre-C1
 *   3 — submission succeeded but terminal state not observed (C1/C2 gap)
 *   1 — unexpected error
 */

const API_BASE = (process.env.P0_API_BASE ?? 'http://localhost:4000').replace(/\/$/, '');
const API_KEY = process.env.P0_API_KEY ?? process.env.COMMANDER_API_KEY ?? '';
const TENANT = process.env.P0_TENANT_ID ?? process.env.COMMANDER_DEFAULT_TENANT_ID ?? 'tenant-local';
const REQUIRE_TERMINAL = process.env.P0_REQUIRE_TERMINAL === '1';
const POLL_MS = Number(process.env.P0_POLL_MS ?? 1000);
const TIMEOUT_MS = Number(process.env.P0_TIMEOUT_MS ?? 60_000);

type Json = Record<string, unknown>;

async function http(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Json | null; text: string }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}`, 'x-api-key': API_KEY } : {}),
      'x-tenant-id': TENANT,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Json | null = null;
  try {
    json = text ? (JSON.parse(text) as Json) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function log(step: string, detail?: unknown): void {
  const suffix = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`[p0-kernel-e2e] ${step}${suffix}`);
}

async function main(): Promise<void> {
  log('config', { API_BASE, TENANT, REQUIRE_TERMINAL, hasApiKey: Boolean(API_KEY) });

  // 1) Health
  let health: Awaited<ReturnType<typeof http>>;
  try {
    health = await http('GET', '/health');
  } catch (err) {
    log('FAIL health unreachable', String(err));
    log('HINT start stack: docker compose -f docker-compose.yml -f docker-compose.v2.yml --profile v2 up -d --build');
    process.exit(2);
  }
  log('health', { status: health.status, body: health.json ?? health.text.slice(0, 200) });
  if (health.status >= 500) {
    process.exit(2);
  }

  if (!API_KEY) {
    log('SKIP submit — set P0_API_KEY or COMMANDER_API_KEY to exercise /v1/runs');
    log('RESULT wiring-only pass (no auth key)');
    process.exit(0);
  }

  // 2) Submit run
  const idempotencyKey = `p0-e2e-${Date.now()}`;
  const submit = await http(
    'POST',
    '/v1/runs',
    {
      goal: 'P0 kernel e2e probe — no external side effects',
      // Prefer server defaults for agentId/definitionVersion/providerSnapshot when steps omitted.
    },
    { 'Idempotency-Key': idempotencyKey },
  );
  log('submit', { status: submit.status, body: submit.json ?? submit.text.slice(0, 400) });

  if (submit.status === 503) {
    log('KERNEL_UNAVAILABLE — Gateway is up but shared kernel is not configured (expected on default compose)');
    log('HINT use docker-compose.v2.yml and COMMANDER_KERNEL_ENABLED=1');
    process.exit(2);
  }

  if (submit.status !== 202 && submit.status !== 200) {
    log('FAIL unexpected submit status');
    process.exit(1);
  }

  const run = (submit.json?.run ?? null) as { id?: string; state?: string } | null;
  if (!run?.id) {
    log('FAIL submit response missing run.id');
    process.exit(1);
  }
  log('run accepted', run);

  // 3) Poll for terminal (may hang until Claude C1/C2 lands)
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'completed', 'error', 'aborted']);
  const started = Date.now();
  let lastState = run.state ?? 'unknown';

  while (Date.now() - started < TIMEOUT_MS) {
    const got = await http('GET', `/v1/runs/${run.id}`);
    const current = (got.json?.run ?? null) as { id?: string; state?: string } | null;
    lastState = current?.state ?? lastState;
    log('poll', { status: got.status, state: lastState });
    if (current?.state && terminal.has(String(current.state).toLowerCase())) {
      log('RESULT terminal reached', current);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  log('TIMEOUT waiting for terminal state', { lastState, timeoutMs: TIMEOUT_MS });
  log('NOT YET PROVEN: worker execution + fencing + reclaim (Claude C1/C2)');
  if (REQUIRE_TERMINAL) {
    process.exit(3);
  }
  log('RESULT soft-pass: submit accepted; terminal deferred');
  process.exit(0);
}

main().catch((err) => {
  console.error('[p0-kernel-e2e] unexpected', err);
  process.exit(1);
});
