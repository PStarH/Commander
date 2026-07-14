/**
 * V2 Worker Auto-Scaling Simulation Tests
 *
 * Verifies that the execution kernel correctly responds to scaling events:
 *   a) Scale up: 1→5 workers improves throughput
 *   b) Scale down: 10→2 workers, queue still drains
 *   c) Tenant concurrency limit enforced during scaling
 *   d) Worker registration/departure doesn't lose in-flight work
 *   e) Priority scheduling respected under scale
 *
 * Uses InMemoryKernelRepository to avoid Postgres dependency.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

import { InMemoryKernelRepository } from '../../../kernel/src/testing/inMemoryRepository.js';
import type { KernelRepository } from '../../../kernel/src/repository.js';

// ---------------------------------------------------------------------------
// Helpers (adapted from v2-worker-load.test.ts)
// ---------------------------------------------------------------------------

interface ClaimedStep {
  id: string;
  runId: string;
  tenantId: string;
  kind: string;
  version: number;
  attempt: number;
  priority: number;
  input: Record<string, unknown>;
  lease: { workerId: string; token: string; fencingEpoch: number; expiresAt: string };
}

class TimedExecutor {
  readonly executions: ClaimedStep[] = [];
  private readonly delayMs: number;

  constructor(delayMs = 10) {
    this.delayMs = delayMs;
  }

  async execute(step: ClaimedStep): Promise<Record<string, unknown>> {
    this.executions.push(step);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return { status: 'success', summary: `Executed ${step.kind}`, runId: step.runId };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Worker that drains all available steps. Returns completed/failed counts and
 * wall-clock duration.
 */
async function drainWorker(
  kernel: KernelRepository,
  workerId: string,
  executor: TimedExecutor,
  options: { leaseTtlMs?: number; idleTimeoutMs?: number } = {},
): Promise<{ completed: number; failed: number; durationMs: number }> {
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 500;
  let completed = 0;
  let failed = 0;
  const start = Date.now();
  let lastWork = start;

  while (true) {
    const claimed = await kernel.claimNextStep({
      workerId,
      leaseTtlMs,
      tenantIds: [],
      capabilities: [],
    });
    if (!claimed) {
      if (Date.now() - lastWork > idleTimeoutMs) break;
      await sleep(5);
      continue;
    }
    lastWork = Date.now();

    const step: ClaimedStep = {
      id: claimed.id,
      runId: claimed.runId,
      tenantId: claimed.tenantId,
      kind: claimed.kind,
      version: claimed.version,
      attempt: claimed.attempt,
      priority: claimed.priority,
      input: claimed.input,
      lease: claimed.lease!,
    };
    try {
      const output = await executor.execute(step);
      await kernel.completeStep({
        stepId: step.id,
        tenantId: step.tenantId,
        lease: step.lease,
        expectedVersion: step.version,
        output,
        actor: workerId,
      });
      completed++;
    } catch (error) {
      await kernel.failStep({
        stepId: step.id,
        tenantId: step.tenantId,
        lease: step.lease,
        expectedVersion: step.version,
        error: {
          code: 'FAILED',
          message: error instanceof Error ? error.message : 'error',
          retryable: false,
        },
        actor: workerId,
      });
      failed++;
    }
  }

  return { completed, failed, durationMs: Date.now() - start };
}

/**
 * Worker that processes steps until a shared counter reaches a target.
 * Used for scale-down simulation: N workers process up to T steps collectively.
 */
async function sharedLimitWorker(
  kernel: KernelRepository,
  workerId: string,
  shared: { completed: number; target: number },
  delayMs: number,
): Promise<number> {
  let completed = 0;
  while (true) {
    if (shared.completed >= shared.target) break;
    const claimed = await kernel.claimNextStep({
      workerId,
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    if (!claimed) {
      if (shared.completed >= shared.target) break;
      await sleep(5);
      continue;
    }
    if (delayMs > 0) await sleep(delayMs);
    await kernel.completeStep({
      stepId: claimed.id,
      tenantId: claimed.tenantId,
      lease: claimed.lease!,
      expectedVersion: claimed.version,
      output: { status: 'success' },
      actor: workerId,
    });
    shared.completed++;
    completed++;
  }
  return completed;
}

/**
 * Worker that tracks the maximum number of concurrently running executions.
 * Used for concurrency-limit verification.
 */
async function trackingDrainWorker(
  kernel: KernelRepository,
  workerId: string,
  tracker: { current: number; max: number },
  delayMs: number,
  options: { leaseTtlMs?: number; idleTimeoutMs?: number } = {},
): Promise<number> {
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 500;
  let completed = 0;
  let lastWork = Date.now();

  while (true) {
    const claimed = await kernel.claimNextStep({
      workerId,
      leaseTtlMs,
      tenantIds: [],
      capabilities: [],
    });
    if (!claimed) {
      if (Date.now() - lastWork > idleTimeoutMs) break;
      await sleep(5);
      continue;
    }
    lastWork = Date.now();
    tracker.current++;
    tracker.max = Math.max(tracker.max, tracker.current);
    if (delayMs > 0) await sleep(delayMs);
    await kernel.completeStep({
      stepId: claimed.id,
      tenantId: claimed.tenantId,
      lease: claimed.lease!,
      expectedVersion: claimed.version,
      output: { status: 'success' },
      actor: workerId,
    });
    tracker.current--;
    completed++;
  }
  return completed;
}

function createBatchRun(tenantId: string, stepCount: number, kindPrefix = 'task') {
  const runId = randomUUID();
  const steps = Array.from({ length: stepCount }, (_, i) => ({
    id: `${runId}-s${i}`,
    kind: `${kindPrefix}-${i % 3}`,
    input: { goal: `Task ${i}`, agentId: 'agent' },
    maxAttempts: 3,
  }));
  return {
    id: runId,
    tenantId,
    intentHash: createHash('sha256').update(runId).digest('hex'),
    workGraphHash: createHash('sha256').update(JSON.stringify(steps)).digest('hex'),
    workGraphVersion: 'v1',
    policySnapshotId: 'autoscale-test',
    steps,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V2 Worker Auto-Scaling — Simulation Tests', () => {
  let kernel: InMemoryKernelRepository;

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  // ── a) Scale up: 1→5 workers improves throughput ──

  it('scale up: 5 workers have higher throughput than 1 worker', async () => {
    const tenantId = 'tenant-scaleup';
    const totalSteps = 100;
    const executorDelay = 10; // 10ms per step

    // --- Baseline: 1 worker ---
    const kernel1 = new InMemoryKernelRepository();
    await kernel1.createRun(createBatchRun(tenantId, totalSteps), 'gateway');
    const executor1 = new TimedExecutor(executorDelay);
    const result1 = await drainWorker(kernel1, 'w-solo', executor1, { idleTimeoutMs: 200 });
    assert.equal(result1.completed, totalSteps, 'Solo worker should complete all 100 steps');
    const soloThroughput = result1.completed / (result1.durationMs / 1000);

    // --- Scale: 5 workers ---
    const kernel5 = new InMemoryKernelRepository();
    await kernel5.createRun(createBatchRun(tenantId, totalSteps), 'gateway');
    const executor5 = new TimedExecutor(executorDelay);
    const workerPromises = Array.from({ length: 5 }, (_, i) =>
      drainWorker(kernel5, `w-${i}`, executor5, { idleTimeoutMs: 200 }),
    );
    const results5 = await Promise.all(workerPromises);

    const totalCompleted5 = results5.reduce((sum, r) => sum + r.completed, 0);
    const maxDuration5 = Math.max(...results5.map((r) => r.durationMs));
    const parallelThroughput = totalCompleted5 / (maxDuration5 / 1000);

    assert.equal(totalCompleted5, totalSteps, '5 workers should complete all 100 steps');
    assert.equal(
      results5.reduce((s, r) => s + r.failed, 0),
      0,
      'No failures expected',
    );

    // 5-worker throughput must exceed 1-worker throughput
    assert.ok(
      parallelThroughput > soloThroughput,
      `5-worker throughput (${parallelThroughput.toFixed(1)} steps/s) should exceed ` +
        `1-worker throughput (${soloThroughput.toFixed(1)} steps/s)`,
    );

    // No step should be executed twice
    const executedIds = executor5.executions.map((s) => s.id);
    assert.equal(new Set(executedIds).size, executedIds.length, 'No duplicate executions');
  });

  // ── b) Scale down: 10→2 workers, queue still drains ──

  it('scale down: 10 workers process 25 steps, then 2 workers drain remaining 25', async () => {
    const tenantId = 'tenant-scaledown';
    const totalSteps = 50;
    const phase1Target = 25;

    await kernel.createRun(createBatchRun(tenantId, totalSteps), 'gateway');

    // Phase 1: 10 workers process up to 25 steps collectively
    const shared = { completed: 0, target: phase1Target };
    const phase1Promises = Array.from({ length: 10 }, (_, i) =>
      sharedLimitWorker(kernel, `w-phase1-${i}`, shared, 3),
    );
    const phase1Results = await Promise.all(phase1Promises);
    const phase1Total = phase1Results.reduce((s, r) => s + r, 0);

    assert.ok(
      phase1Total >= phase1Target,
      `Phase 1 should process at least ${phase1Target} steps, got ${phase1Total}`,
    );

    // Phase 2: 2 workers drain the remaining steps
    const executor2 = new TimedExecutor(3);
    const phase2Promises = [
      drainWorker(kernel, 'w-phase2-0', executor2, { idleTimeoutMs: 300 }),
      drainWorker(kernel, 'w-phase2-1', executor2, { idleTimeoutMs: 300 }),
    ];
    const phase2Results = await Promise.all(phase2Promises);
    const phase2Total = phase2Results.reduce((s, r) => s + r.completed, 0);

    // All 50 steps must be completed
    assert.equal(
      phase1Total + phase2Total,
      totalSteps,
      `All ${totalSteps} steps should be completed (phase1=${phase1Total}, phase2=${phase2Total})`,
    );

    // No duplicate executions
    const executedIds = executor2.executions.map((s) => s.id);
    assert.equal(
      new Set(executedIds).size,
      executedIds.length,
      'No duplicate executions in phase 2',
    );

    // No steps should remain
    const remaining = await kernel.claimNextStep({
      workerId: 'w-check',
      leaseTtlMs: 1000,
      tenantIds: [],
      capabilities: [],
    });
    assert.equal(remaining, null, 'No steps should remain after scale-down drain');
  });

  // ── c) Tenant concurrency limit enforced during scaling ──

  it('tenant concurrency limit: max 2 concurrent steps with 10 workers', async () => {
    const tenantId = 'tenant-concurrency';
    const totalSteps = 20;
    const concurrencyLimit = 2;

    await kernel.setTenantConcurrencyLimit(tenantId, concurrencyLimit);
    await kernel.createRun(createBatchRun(tenantId, totalSteps), 'gateway');

    const tracker = { current: 0, max: 0 };
    const workerPromises = Array.from({ length: 10 }, (_, i) =>
      trackingDrainWorker(kernel, `w-${i}`, tracker, 10, { idleTimeoutMs: 500 }),
    );
    const results = await Promise.all(workerPromises);

    const totalCompleted = results.reduce((s, r) => s + r, 0);

    assert.equal(totalCompleted, totalSteps, `All ${totalSteps} steps should be completed`);

    // At no point should more than `concurrencyLimit` steps be running
    assert.ok(
      tracker.max <= concurrencyLimit,
      `Max concurrent steps (${tracker.max}) should not exceed limit (${concurrencyLimit})`,
    );

    // The limit should have been reached (at least 2 concurrent at some point)
    assert.ok(
      tracker.max >= 2,
      `Concurrency limit should have been reached (max=${tracker.max}, expected ≥ 2)`,
    );
  });

  // ── d) Worker registration/departure doesn't lose in-flight work ──

  it('worker crash: orphaned steps are reclaimed and completed by new worker', async () => {
    const tenantId = 'tenant-crash';
    const totalSteps = 20;

    // Create 20-step run with maxAttempts=3 so reclaimed steps go to RETRY_WAIT
    const runId = randomUUID();
    await kernel.createRun(
      {
        id: runId,
        tenantId,
        intentHash: createHash('sha256').update(runId).digest('hex'),
        workGraphHash: createHash('sha256').update(runId).digest('hex'),
        workGraphVersion: 'v1',
        policySnapshotId: 'crash-test',
        steps: Array.from({ length: totalSteps }, (_, i) => ({
          id: `${runId}-step-${i}`,
          kind: 'agent',
          input: { goal: `Task ${i}` },
          maxAttempts: 3,
        })),
      },
      'gateway',
    );

    // 3 workers each claim a step with a short lease (50ms) but never complete
    const orphanedStepIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const claimed = await kernel.claimNextStep({
        workerId: `w-crash-${i}`,
        leaseTtlMs: 50,
        tenantIds: [tenantId],
        capabilities: [],
      });
      assert.ok(claimed, `Crash worker ${i} should claim a step`);
      orphanedStepIds.push(claimed!.id);
    }

    assert.equal(orphanedStepIds.length, 3, '3 workers should have claimed 3 steps');

    // Wait for the leases to expire
    await sleep(80);

    // Reclaim expired leases — orphaned steps go to RETRY_WAIT
    const reclaimed = await kernel.reclaimExpiredLeases(new Date(), 100);
    assert.ok(
      reclaimed.length >= 3,
      `At least 3 steps should be reclaimed, got ${reclaimed.length}`,
    );
    for (const step of reclaimed) {
      assert.equal(
        step.state,
        'RETRY_WAIT',
        `Reclaimed step ${step.id} should be in RETRY_WAIT (attempt=${step.attempt} < maxAttempts)`,
      );
    }

    // New worker drains all remaining steps (3 reclaimed + 17 pending = 20)
    const executor = new TimedExecutor(2);
    const result = await drainWorker(kernel, 'w-recovery', executor, { idleTimeoutMs: 300 });

    assert.equal(
      result.completed,
      totalSteps,
      `Recovery worker should complete all ${totalSteps} steps (got ${result.completed})`,
    );
    assert.equal(result.failed, 0, 'No failures expected during recovery');

    // Verify no duplicate executions
    const executedIds = executor.executions.map((s) => s.id);
    assert.equal(new Set(executedIds).size, executedIds.length, 'No duplicate executions');

    // Verify the orphaned steps were reclaimed and completed
    for (const orphanedId of orphanedStepIds) {
      assert.ok(
        executedIds.includes(orphanedId),
        `Orphaned step ${orphanedId} should be completed by recovery worker`,
      );
    }

    // No steps should remain
    const remaining = await kernel.claimNextStep({
      workerId: 'w-check',
      leaseTtlMs: 1000,
      tenantIds: [],
      capabilities: [],
    });
    assert.equal(remaining, null, 'No steps should remain after recovery');
  });

  // ── e) Priority scheduling respected under scale ──

  it('priority scheduling: high-priority steps claimed before low-priority', async () => {
    const tenantId = 'tenant-priority';
    const runId = randomUUID();

    // Create a run with mixed priorities: 5 high (priority=10), 5 low (priority=0)
    await kernel.createRun(
      {
        id: runId,
        tenantId,
        intentHash: createHash('sha256').update(runId).digest('hex'),
        workGraphHash: createHash('sha256').update(runId).digest('hex'),
        workGraphVersion: 'v1',
        policySnapshotId: 'priority-test',
        steps: [
          ...Array.from({ length: 5 }, (_, i) => ({
            id: `${runId}-high-${i}`,
            kind: 'task',
            input: { goal: `High priority task ${i}` },
            priority: 10,
          })),
          ...Array.from({ length: 5 }, (_, i) => ({
            id: `${runId}-low-${i}`,
            kind: 'task',
            input: { goal: `Low priority task ${i}` },
            priority: 0,
          })),
        ],
      },
      'gateway',
    );

    // Use a simulated time far in the future so that the aging boost
    // (Math.max(priority + age, 1000)) differentiates by base priority.
    // With age=2000 minutes:
    //   high: max(10 + 2000, 1000) = 2010
    //   low:  max(0 + 2000, 1000)  = 2000
    // Higher boosted priority is claimed first.
    const futureNow = new Date(Date.now() + 2000 * 60 * 1000);

    // Single worker claims steps one at a time, recording the priority order
    const claimedPriorities: number[] = [];
    const claimedIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const claimed = await kernel.claimNextStep({
        workerId: 'w-priority',
        leaseTtlMs: 30_000,
        tenantIds: [tenantId],
        capabilities: [],
        now: futureNow,
      });
      assert.ok(claimed, `Should claim step ${i}`);
      claimedPriorities.push(claimed!.priority);
      claimedIds.push(claimed!.id);

      await kernel.completeStep({
        stepId: claimed!.id,
        tenantId: claimed!.tenantId,
        lease: claimed!.lease!,
        expectedVersion: claimed!.version,
        output: { status: 'success' },
        actor: 'w-priority',
      });
    }

    // All 10 steps should be claimed
    assert.equal(claimedPriorities.length, 10, 'All 10 steps should be claimed');

    // All high-priority steps (priority=10) should be claimed before any low-priority (priority=0)
    const firstLowIndex = claimedPriorities.indexOf(0);
    const lastHighIndex = claimedPriorities.lastIndexOf(10);

    assert.ok(
      firstLowIndex === -1 || lastHighIndex < firstLowIndex,
      `All high-priority steps should be claimed before low-priority ones ` +
        `(last high at index ${lastHighIndex}, first low at index ${firstLowIndex}), ` +
        `order: [${claimedPriorities.join(', ')}]`,
    );

    // Verify: first 5 should all be priority 10, last 5 should all be priority 0
    assert.deepEqual(
      claimedPriorities.slice(0, 5),
      [10, 10, 10, 10, 10],
      'First 5 claimed steps should be high priority (10)',
    );
    assert.deepEqual(
      claimedPriorities.slice(5),
      [0, 0, 0, 0, 0],
      'Last 5 claimed steps should be low priority (0)',
    );

    // No steps should remain
    const remaining = await kernel.claimNextStep({
      workerId: 'w-check',
      leaseTtlMs: 1000,
      tenantIds: [tenantId],
      capabilities: [],
    });
    assert.equal(remaining, null, 'No steps should remain after priority drain');
  });
});
