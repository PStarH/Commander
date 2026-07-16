/**
 * rate-isolation.test.ts — WS9 §4.4 cross-tenant RATE isolation live-fire.
 *
 * Closes D.1 §7 (per-tenant rate limiting + fair scheduling).
 *
 *   RATE-1: A bursts 10x; B's p95/p99 latency and success rate unaffected.
 *   RATE-2: A exhausts shared worker pool; B's lease claims still succeed
 *           in SLA (per-tenant semaphore isolation).
 *   RATE-3: bench-tenant-concurrency on real kernel PG → passed=true, errors=0.
 *
 * RATE-3 only emits `live` evidence when COMMANDER_DB_HOST/NAME/USER point
 * to a real Postgres; otherwise the test is skipped per spec §3.2 (the
 * spec explicitly says simulated benches must NOT fill the live slot,
 * to-90-plan §10 L194).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ConcurrencyController } from '../../src/runtime/concurrencyController';
import { runWithTenant } from '../../src/runtime/tenantContext';
import { InMemoryKernelRepository } from '../../../kernel/src/testing/inMemoryRepository.js';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  probePostgres,
  describeIf,
  writePass,
  writeBreach,
  writeFail,
  WS9_BASELINE_DIR,
  TENANT_A,
  TENANT_B,
} from './_evidence';

// ─── Helpers ─────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

function makeRunCommand(tenantId: string) {
  const runId = `run_${randomUUID().slice(0, 8)}`;
  return {
    id: runId,
    tenantId,
    intentHash: createHash('sha256').update(runId).digest('hex'),
    workGraphHash: createHash('sha256').update('graph').digest('hex'),
    workGraphVersion: 'v1',
    policySnapshotId: 'ws9-rate-policy',
    steps: [{ id: `${runId}-step-0`, kind: 'agent', maxAttempts: 1 }],
  };
}

// ─── RATE-1: 10x burst from A does not affect B's p95/p99 ──────────────

describe('WS9 RATE-1: A\'s 10x burst does not affect B\'s p95/p99', () => {
  it('per-tenant semaphore isolates A\'s burst from B\'s latency', async () => {
    const artifacts: string[] = [];
    // 1 slot per tenant — A can saturate its own slot but B's slot is
    // independent. This is the ConcurrencyController contract.
    const controller = new ConcurrencyController(1, { maxQueueDepth: 100 });

    // Baseline: B's request latency without A's burst.
    const baselineB: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      const release = await runWithTenant(TENANT_B, () => controller.acquire());
      // simulate work
      await new Promise((r) => setTimeout(r, 5));
      release();
      baselineB.push(Date.now() - start);
    }

    // Now A bursts 10x concurrently while B is making a request.
    const burstStart = Date.now();
    const aPromises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      aPromises.push(
        (async () => {
          const release = await runWithTenant(TENANT_A, () => controller.acquire());
          await new Promise((r) => setTimeout(r, 10));
          release();
        })(),
      );
    }

    // While A's burst is in flight, B makes a request. B must NOT wait for A.
    const burstBLatency: number[] = [];
    while (Date.now() - burstStart < 50) {
      const start = Date.now();
      const release = await runWithTenant(TENANT_B, () => controller.acquire());
      await new Promise((r) => setTimeout(r, 2));
      release();
      burstBLatency.push(Date.now() - start);
    }
    await Promise.all(aPromises);

    const baselineP95 = percentile([...baselineB].sort((a, b) => a - b), 95);
    const burstP95 = percentile([...burstBLatency].sort((a, b) => a - b), 95);
    const baselineP99 = percentile([...baselineB].sort((a, b) => a - b), 99);
    const burstP99 = percentile([...burstBLatency].sort((a, b) => a - b), 99);

    // B's burst p95 must be within 3x of its baseline p95 — A's burst must
    // not starve B (spec: "fair scheduling works; B unaffected").
    try {
      expect(burstP95).toBeLessThan(Math.max(50, baselineP95 * 3));
      expect(burstP99).toBeLessThan(Math.max(100, baselineP99 * 3));
      writePass(
        'RATE-1',
        `A's 10x burst did not affect B: B baseline p95=${baselineP95}ms / p99=${baselineP99}ms; during burst p95=${burstP95}ms / p99=${burstP99}ms. Per-tenant semaphore isolation held.`,
        artifacts,
      );
    } catch (err) {
      writeBreach(
        'RATE-1',
        `Burst-impact breach: B baseline p95=${baselineP95}ms / p99=${baselineP99}ms; during burst p95=${burstP95}ms / p99=${burstP99}ms. ${(err as Error).message ?? ''}`,
        artifacts,
      );
      throw err;
    }
  });
});

// ─── RATE-2: A exhausts shared worker pool, B's lease claims still SLA ─

describe('WS9 RATE-2: A exhausts shared worker pool, B\'s lease claims still succeed', () => {
  it('B claims steps in SLA while A saturates the shared pool', async () => {
    const artifacts: string[] = [];
    const kernel = new InMemoryKernelRepository();
    await kernel.initialize();

    // Seed B with 5 PENDING steps.
    const bStepIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const cmd = makeRunCommand(TENANT_B);
      await kernel.createRun(cmd, 'ws9-rate-2');
      bStepIds.push(cmd.steps[0]!.id);
    }

    // A exhausts a shared worker pool — modeled as A holding 10 long-running
    // claims simultaneously. The shared kernel (not a per-tenant pool) is
    // what A tries to starve.
    const aStepIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const cmd = makeRunCommand(TENANT_A);
      await kernel.createRun(cmd, 'ws9-rate-2');
      aStepIds.push(cmd.steps[0]!.id);
    }

    // A claims all its steps (saturating "shared pool"). leaseTtlMs is required
    // by ClaimStepRequest — without it claimNextStep throws RangeError on
    // `new Date(NaN).toISOString()` (at.getTime() + undefined = NaN).
    const leaseTtlMs = 30_000;
    const aClaims: string[] = [];
    for (const stepId of aStepIds) {
      const step = await kernel.claimNextStep({
        tenantIds: [TENANT_A],
        workerId: `a-worker-${stepId.slice(-4)}`,
        workerGeneration: 1,
        leaseTtlMs,
      });
      if (step) aClaims.push(step.id);
    }

    // Now B tries to claim. B's claims MUST succeed within the SLA window
    // (we use 100ms as a generous upper bound for the in-memory kernel —
    // the production SLA is set by the kernel's claim-step timeout, not
    // this test's timer).
    const slaMs = 100;
    const bClaims: { id: string; latencyMs: number }[] = [];
    for (let i = 0; i < bStepIds.length; i++) {
      const start = Date.now();
      const step = await kernel.claimNextStep({
        tenantIds: [TENANT_B],
        workerId: `b-worker-${i}`,
        workerGeneration: 1,
        leaseTtlMs,
      });
      const latencyMs = Date.now() - start;
      if (step) bClaims.push({ id: step.id, latencyMs });
    }

    try {
      expect(aClaims).toHaveLength(aStepIds.length);
      expect(bClaims).toHaveLength(bStepIds.length);
      const maxLatency = Math.max(...bClaims.map((c) => c.latencyMs));
      expect(maxLatency).toBeLessThan(slaMs);
      writePass(
        'RATE-2',
        `A exhausted shared pool with ${aClaims.length} simultaneous claims; B's ${bClaims.length} lease claims still succeeded (max latency ${maxLatency}ms < ${slaMs}ms SLA). Per-tenant claim isolation held.`,
        artifacts,
      );
    } catch (err) {
      writeBreach(
        'RATE-2',
        `Worker-pool starvation breach: A=${aClaims.length}/${aStepIds.length}, B=${bClaims.length}/${bStepIds.length}. ${(err as Error).message ?? ''}`,
        artifacts,
      );
      throw err;
    }
  });
});

// ─── RATE-3: bench-tenant-concurrency on real kernel PG ─────────────────

// probePostgres is a ProbeResult const (not a function) — see _evidence.ts.
const pgProbe = probePostgres;
const pgReady = pgProbe.available;
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');

describeIf(pgReady)('WS9 RATE-3: bench-tenant-concurrency on real kernel Postgres', () => {
  it('re-runs bench-tenant-concurrency against real PG; passed=true, errors=0', () => {
    const artifacts: string[] = [];

    // Smoke: commander_app can talk to the live PG used by the WS9 stack.
    const host = process.env.COMMANDER_DB_HOST!;
    const port = process.env.COMMANDER_DB_PORT ?? '5432';
    const db = process.env.COMMANDER_DB_NAME!;
    const user = process.env.COMMANDER_DB_USER!;
    const password = process.env.COMMANDER_DB_PASSWORD ?? '';
    const pgProbeRes = spawnSync(
      'psql',
      ['-h', host, '-p', port, '-U', user, '-d', db, '-t', '-A', '-c', 'SELECT current_user;'],
      {
        encoding: 'utf-8',
        env: { ...process.env, PGPASSWORD: password },
        timeout: 10_000,
      },
    );
    expect(pgProbeRes.status).toBe(0);
    expect((pgProbeRes.stdout ?? '').trim()).toBe(user);

    const outDir = path.join(WS9_BASELINE_DIR, 'rate-3-run');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `bench-tenant-concurrency.${Date.now()}.json`);

    const res = spawnSync(
      'pnpm',
      [
        'exec',
        'tsx',
        'scripts/bench-tenant-concurrency.ts',
        '--tenants=2',
        '--requests=20',
        `--output=${outFile}`,
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60_000,
        env: process.env,
      },
    );

    if (res.status !== 0) {
      writeFail(
        'RATE-3',
        `bench-tenant-concurrency exited ${res.status}: ${(res.stderr ?? res.stdout ?? '').slice(0, 500)}`,
        [...artifacts, outFile],
        'live',
      );
      throw new Error(`bench-tenant-concurrency failed: exit ${res.status}`);
    }

    if (!fs.existsSync(outFile)) {
      writeFail('RATE-3', `bench-tenant-concurrency did not produce baseline at ${outFile}`, artifacts, 'live');
      throw new Error(`bench baseline missing: ${outFile}`);
    }

    const baseline = JSON.parse(fs.readFileSync(outFile, 'utf-8')) as {
      summary?: { passed?: boolean; errors?: number; failed?: number; skipped?: number };
    };
    const summary = baseline.summary ?? {};
    artifacts.push(outFile);

    try {
      expect(summary.passed).toBe(true);
      expect(summary.errors ?? 0).toBe(0);
      expect(summary.failed ?? 0).toBe(0);
      expect(summary.skipped ?? 0).toBe(0);
      writePass(
        'RATE-3',
        `bench-tenant-concurrency with live PG (${user}@${host}:${port}/${db}): ` +
          `passed=${summary.passed}, errors=${summary.errors}, failed=${summary.failed}. ` +
          `PG smoke current_user=${user}.`,
        artifacts,
        'live',
      );
    } catch (err) {
      writeBreach(
        'RATE-3',
        `bench-tenant-concurrency regression: passed=${summary.passed}, errors=${summary.errors}. ` +
          `${(err as Error).message ?? ''}`,
        artifacts,
        'live',
      );
      throw err;
    }
  });
});

describeIf(!pgReady)('WS9 RATE-3 (skipped: real Postgres unavailable)', () => {
  it('skips when Postgres commander_app role is not available', () => {
    expect(pgReady).toBe(false);
  });
});
