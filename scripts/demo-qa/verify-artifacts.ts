#!/usr/bin/env node
/**
 * Artifact Verification — "查账" after the burn-in.
 *
 * Validates that the system actually persisted real state, not just UI theatre:
 *   - ~/.commander/memory/ contains non-empty JSON files
 *   - /metrics returns non-zero counters for at least one tracked activity
 *
 * The verifier is self-contained: it starts the API server, runs a deterministic
 * self-test that increments the truncation/cascade counters, then checks metrics.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

const ROOT = path.resolve(__dirname, '../..');
const MEMORY_DIR = path.join(process.env.HOME ?? '/tmp', '.commander', 'memory');
const API_PORT = 4000;
const API_URL = `http://localhost:${API_PORT}`;

function startApi(): ChildProcess {
  const child = spawn('npx', ['tsx', 'apps/api/src/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(API_PORT), WEB_PORT: '5173' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function waitForApiReady(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_URL}/health`);
      if (res.ok) return;
    } catch (err) {
      console.warn('[Catch]', err);
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API did not become ready within ${timeoutMs}ms`);
}

async function runSelfTest(): Promise<void> {
  const res = await fetch(`${API_URL}/api/runtime/self-test`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`Self-test endpoint returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  if (body.status !== 'success') {
    throw new Error(`Self-test did not succeed: ${JSON.stringify(body)}`);
  }
}

async function main() {
  // 1. Start API, run self-test, and verify metrics report real activity.
  const api = startApi();
  let metrics: Record<string, number>;
  try {
    await waitForApiReady();
    await runSelfTest();

    const res = await fetch(`${API_URL}/metrics`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    metrics = (await res.json()) as Record<string, number>;

    const tracked = [
      'tool_truncations_total',
      'cascade_escalations',
      'cascade_attempts_total',
      'cascade_pass_total',
      'cascade_fail_total',
      'active_runs',
    ];
    const anyNonZero = tracked.some((k) => typeof metrics[k] === 'number' && metrics[k] > 0);
    if (!anyNonZero) {
      throw new Error(
        `All tracked metrics are zero or missing: ${JSON.stringify(metrics, null, 2)}`,
      );
    }
  } catch (err) {
    api.kill('SIGKILL');
    throw err;
  }

  // 2. Memory directory must exist and contain non-empty JSON files.
  if (!fs.existsSync(MEMORY_DIR)) {
    api.kill('SIGKILL');
    throw new Error(`Memory directory does not exist: ${MEMORY_DIR}`);
  }

  const entries = fs.readdirSync(MEMORY_DIR, { withFileTypes: true });
  const jsonFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => path.join(MEMORY_DIR, e.name));

  if (jsonFiles.length === 0) {
    api.kill('SIGKILL');
    throw new Error(`No JSON files found in ${MEMORY_DIR}`);
  }

  let totalBytes = 0;
  for (const f of jsonFiles) {
    const stats = fs.statSync(f);
    if (stats.size === 0) {
      api.kill('SIGKILL');
      throw new Error(`Memory file is empty: ${f}`);
    }
    totalBytes += stats.size;
  }

  console.log('✅ Artifact verification passed');
  console.log(`   Memory files: ${jsonFiles.length} (total ${totalBytes} bytes)`);
  console.log(`   Metrics: ${JSON.stringify(metrics)}`);
  api.kill('SIGKILL');
  process.exit(0);
}

main().catch((err) => {
  console.error(
    '❌ Artifact verification failed:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
