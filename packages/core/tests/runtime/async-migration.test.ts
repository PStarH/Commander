/**
 * async-migration regression suite.
 *
 * Covers the 5 specific contracts added by the sync-I/O → fs.promises migration:
 *
 *  (a) buildHealthSources() returns LIVE event-bus + DLQ values that
 *      reflect bus.subscribe / bus.publish / dlq.enqueue activity.
 *  (b) compensationService mkdir compensation handler is a no-op on a
 *      non-empty directory (and removes an empty directory otherwise).
 *  (c) FreezeDryManager.freezeAsync + detectFreezeAsync round-trip
 *      preserves run info on disk.
 *  (d) PersistentTraceStore.flushAsync handles the access-ENOENT cold-start
 *      path AND the access-success append path correctly.
 *  (e) CheckpointWriter.writeCheckpoint awaits persist() on its caller
 *      path so the persisted file is observable immediately post-await.
 *
 * These tests guard the "no event-loop blocking, no TOCTOU probes,
 * no missed visibility on real errors" contract that motivated the
 * migration.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithTenant } from '../../src/runtime/tenantContext';

// ============================================================================
// (a) buildHealthSources — live bus + DLQ values
// ============================================================================

describe('async-migration / buildHealthSources returns live values', () => {
  it('reflects bus.subscribe + bus.publish activity in getEventBusInfo()', async () => {
    const { buildHealthSources } = await import('../../src/runtime/healthCheck');
    const { getMessageBus } = await import('../../src/runtime/messageBus');
    const bus = getMessageBus();
    const sources = buildHealthSources();

    expect(sources.getEventBusInfo).toBeDefined();
    expect(sources.getDLQInfo).toBeDefined();

    const before = sources.getEventBusInfo!();
    expect(before.activeTopics).toBeGreaterThanOrEqual(0);
    expect(before.subscriberCount).toBeGreaterThanOrEqual(0);

    // Fresh topic name per test so other tests' subscribers don't leak in.
    const topic = `test.async.bus.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    let received = 0;
    const unsub = bus.subscribe(topic, () => {
      received++;
    });
    bus.publish(topic, 'test-publisher', { payload: 'hello' });

    const after = sources.getEventBusInfo!();
    expect(after.activeTopics).toBeGreaterThanOrEqual(1);
    expect(after.subscriberCount).toBeGreaterThan(before.subscriberCount);
    expect(received).toBe(1);

    unsub();
  });

  it('reflects dlq.enqueue activity in getDLQInfo()', async () => {
    await runWithTenant('test-tenant', async () => {
      const { buildHealthSources } = await import('../../src/runtime/healthCheck');
      const { getDeadLetterQueue } = await import('../../src/runtime/deadLetterQueueSingleton');
      const sources = buildHealthSources();
      const dlq = getDeadLetterQueue();

      // Use a unique category per test so other tests' enqueues don't pollute
      // the count. Compensation category is fine — it accepts arbitrary ops.
      const uniqueOp = `op-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      const baseline = await sources.getDLQInfo!();
      const baselineCompensation =
        baseline.byCategory.find((c) => c.category === 'compensation')?.count ?? 0;

      dlq.enqueue({
        category: 'compensation',
        operationName: uniqueOp,
        errorMessage: 'async-migration test entry',
        tags: ['async-migration'],
        failureMode: 'unknown',
        failureModeNumber: 0,
      });

      const after = await sources.getDLQInfo!();
      const afterCompensation =
        after.byCategory.find((c) => c.category === 'compensation')?.count ?? 0;

      expect(afterCompensation).toBeGreaterThanOrEqual(baselineCompensation + 1);
      expect(after.totalEntries).toBeGreaterThanOrEqual(baseline.totalEntries + 1);
    });
  });

  it('getters swallow errors and fall back to zero/empty', async () => {
    // Direct fallback path: simulate the "singleton throws" branch by
    // calling the getter after monkey-patching one of the underlying
    // methods to throw. The getter must catch and return defaults.
    const { buildHealthSources } = await import('../../src/runtime/healthCheck');
    const { getMessageBus } = await import('../../src/runtime/messageBus');
    const bus = getMessageBus();
    const sources = buildHealthSources();

    const originalGetActiveTopics = bus.getActiveTopics.bind(bus);
    (bus as unknown as { getActiveTopics: () => string[] }).getActiveTopics = () => {
      throw new Error('simulated bus failure');
    };

    try {
      const info = sources.getEventBusInfo!();
      expect(info.activeTopics).toBe(0);
      expect(info.subscriberCount).toBe(0);
    } finally {
      (bus as unknown as { getActiveTopics: () => string[] }).getActiveTopics =
        originalGetActiveTopics;
    }
  });
});

// ============================================================================
// (b) compensationService mkdir handler — noop on non-empty dir
// ============================================================================

describe('async-migration / compensationService mkdir handler', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'compensation-mkdir-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('noop on non-empty directory — file in dir survives compensation', async () => {
    const { CompensationService } = await import('../../src/runtime/compensationService');
    const { DeadLetterQueue } = await import('../../src/runtime/deadLetterQueue');
    const { PersistentTraceStore } = await import('../../src/runtime/traceStore');

    const dlq = new DeadLetterQueue(join(tmpDir, 'dlq'));
    const traceStore = new PersistentTraceStore(join(tmpDir, 'traces'));
    const svc = new CompensationService({
      dlq,
      getRunId: () => 'mkdir-test',
      traceStore,
    });

    try {
      const dir = join(tmpDir, 'non-empty-dir');
      mkdirSync(dir);
      writeFileSync(join(dir, 'a.txt'), 'survives-compensation');

      const actionId = `mkdir-non-empty-${Date.now()}`;
      svc.getRegistry().recordAction({
        actionId,
        toolName: 'mkdir',
        args: { path: dir },
        description: 'Create non-empty dir',
        tags: ['mkdir'],
        runId: 'mkdir-test',
        agentId: 'system',
      });

      const result = await svc.getRegistry().compensate(actionId);
      expect(result.success).toBe(true);

      // The mkdir handler must NOT rm a non-empty directory.
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, 'a.txt'))).toBe(true);
      expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('survives-compensation');
    } finally {
      svc.dispose();
    }
  });

  it('removes empty directory — confirms handler still works for empty case', async () => {
    const { CompensationService } = await import('../../src/runtime/compensationService');
    const { DeadLetterQueue } = await import('../../src/runtime/deadLetterQueue');
    const { PersistentTraceStore } = await import('../../src/runtime/traceStore');

    const tmpDir2 = mkdtempSync(join(tmpdir(), 'compensation-mkdir-empty-'));
    try {
      const dlq = new DeadLetterQueue(join(tmpDir2, 'dlq'));
      const traceStore = new PersistentTraceStore(join(tmpDir2, 'traces'));
      const svc = new CompensationService({
        dlq,
        getRunId: () => 'mkdir-test',
        traceStore,
      });

      const dir = join(tmpDir2, 'empty-dir');
      mkdirSync(dir);
      expect(existsSync(dir)).toBe(true);

      const actionId = `mkdir-empty-${Date.now()}`;
      svc.getRegistry().recordAction({
        actionId,
        toolName: 'mkdir',
        args: { path: dir },
        description: 'Create empty dir',
        tags: ['mkdir'],
        runId: 'mkdir-test',
        agentId: 'system',
      });

      const result = await svc.getRegistry().compensate(actionId);
      expect(result.success).toBe(true);
      // The mkdir handler removes an empty directory.
      expect(existsSync(dir)).toBe(false);
      svc.dispose();
    } finally {
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// (c) freezeAsync + detectFreezeAsync round-trip
// ============================================================================

describe('async-migration / FreezeDryManager async round-trip', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'freeze-dry-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('freezeAsync produces a detectFreezeAsync-readable manifest', async () => {
    const { FreezeDryManager } = await import('../../src/runtime/freezeDry');
    const fm = new FreezeDryManager(stateDir);

    const runState = {
      runId: 'run-freeze-test-001',
      agentId: 'agent-freeze-test',
      phase: 'EXECUTION',
      stepNumber: 5,
      goal: 'Async-migration freeze round-trip test',
      completedToolCalls: 3,
    };
    fm.setActiveRuns(new Map([[runState.runId, runState]]));

    const manifest = await fm.freezeAsync();
    expect(manifest).not.toBeNull();
    expect(manifest!.runs.length).toBe(1);
    expect(manifest!.runs[0].runId).toBe(runState.runId);
    expect(manifest!.runs[0].agentId).toBe(runState.agentId);
    expect(manifest!.runs[0].stepNumber).toBe(5);

    const detected = await fm.detectFreezeAsync();
    expect(detected).not.toBeNull();
    expect(detected!.runs.length).toBe(1);
    expect(detected!.runs[0].runId).toBe(runState.runId);
    expect(detected!.runs[0].goal).toBe(runState.goal);
    expect(detected!.runs[0].completedToolCalls).toBe(3);
    // Manifest file is observable on disk after the freezeAsync await.
    expect(existsSync(join(stateDir, 'freeze.manifest.json'))).toBe(true);
  });

  it('detectFreezeAsync returns null on ENOENT (cold-start path)', async () => {
    const { FreezeDryManager } = await import('../../src/runtime/freezeDry');
    const fm = new FreezeDryManager(stateDir);
    const detected = await fm.detectFreezeAsync();
    expect(detected).toBeNull();
  });

  it('parallel freeze with 50 runs preserves all entries (uses getActiveRunCount)', async () => {
    const { FreezeDryManager } = await import('../../src/runtime/freezeDry');
    const fm = new FreezeDryManager(stateDir);

    const runCount = 50;
    const runs = new Map(
      Array.from({ length: runCount }, (_, i) => [
        `parallel-run-${i.toString().padStart(3, '0')}`,
        {
          runId: `parallel-run-${i.toString().padStart(3, '0')}`,
          agentId: 'parallel-agent',
          phase: 'EXECUTION',
          stepNumber: i,
          goal: `Parallel run ${i}`,
          completedToolCalls: i,
        },
      ]),
    );
    fm.setActiveRuns(runs);

    // Use the new @internal accessor instead of fm['activeRuns'].size
    expect(fm.getActiveRunCount()).toBe(runCount);

    const manifest = await fm.freezeAsync();
    expect(manifest).not.toBeNull();
    expect(manifest!.runs.length).toBe(runCount);

    // activeRuns Map is not cleared by freeze; same count after.
    expect(fm.getActiveRunCount()).toBe(runCount);

    // Every run made it into the on-disk manifest.
    const detected = await fm.detectFreezeAsync();
    expect(detected!.runs.length).toBe(runCount);
  });
});

// ============================================================================
// (d) traceStore.flushAsync — access-ENOENT and access-success paths
// ============================================================================

describe('async-migration / PersistentTraceStore.flushAsync', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'trace-store-async-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('creates ndjson file when access-ENOENT (cold-start path)', async () => {
    const { PersistentTraceStore } = await import('../../src/runtime/traceStore');
    const store = new PersistentTraceStore(baseDir);
    const runId = 'cold-start-run';

    for (let i = 0; i < 5; i++) {
      store.append({
        runId,
        type: 'test',
        timestamp: new Date().toISOString(),
        data: { i },
      } as Parameters<typeof store.append>[0]);
    }
    expect(store.getBufferCount(runId)).toBe(5);

    await store.flushAsync(runId);

    const filePath = join(baseDir, `${runId}.ndjson`);
    expect(existsSync(filePath)).toBe(true);
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(5);
    // Buffer cleared after successful flush
    expect(store.getBufferCount(runId)).toBe(0);
  });

  it('appends to existing ndjson via access-success path', async () => {
    const { PersistentTraceStore } = await import('../../src/runtime/traceStore');
    const store = new PersistentTraceStore(baseDir);
    const runId = 'append-run';

    // First batch — cold start, file does not exist yet
    store.append({
      runId,
      type: 'first',
      timestamp: new Date().toISOString(),
      data: { i: 1 },
    } as Parameters<typeof store.append>[0]);
    await store.flushAsync(runId);

    const filePath = join(baseDir, `${runId}.ndjson`);
    expect(existsSync(filePath)).toBe(true);

    // Second batch — file now exists; access-success branch taken
    for (let i = 0; i < 3; i++) {
      store.append({
        runId,
        type: 'second',
        timestamp: new Date().toISOString(),
        data: { i },
      } as Parameters<typeof store.append>[0]);
    }
    await store.flushAsync(runId);

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    // 1 initial entry + 3 follow-up entries
    expect(lines.length).toBe(4);
  });

  it('no-op when buffer for runId is empty (no file created)', async () => {
    const { PersistentTraceStore } = await import('../../src/runtime/traceStore');
    const store = new PersistentTraceStore(baseDir);

    await store.flushAsync('never-written-run');

    const filePath = join(baseDir, 'never-written-run.ndjson');
    expect(existsSync(filePath)).toBe(false);
  });
});

// ============================================================================
// (e) checkpointWriter.persist() awaits on caller path
// ============================================================================

describe('async-migration / CheckpointWriter.persist() awaits', () => {
  let storageDir: string;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), 'checkpoint-writer-async-'));
  });

  afterEach(() => {
    rmSync(storageDir, { recursive: true, force: true });
  });

  it('file exists on disk immediately after writeCheckpoint await resolves', async () => {
    const { CheckpointWriter } = await import('../../src/runtime/checkpointWriter');
    const writer = new CheckpointWriter({ storageDir });
    writer.reset();
    const runId = 'persist-await-001';

    const trigger = writer.shouldTrigger(runId, 10_000, 20_000); // 50% → 45% point fires
    expect(trigger).not.toBeNull();

    const result = await writer.writeCheckpoint({
      runId,
      goal: 'Async-migration persist await test',
      phase: 'EXECUTION',
      stepNumber: 5,
      completedSubtasks: [
        {
          id: 't1',
          goal: 'completed subtask 1',
          result: 'ok',
          tokensUsed: 100,
          durationMs: 1000,
        },
      ],
      pendingSubtasks: [],
      failedSubtasks: [],
      keyDecisions: ['decided to test async-migration contract'],
      filesRead: ['/tmp/example.txt'],
      filesModified: [],
      errors: [],
      tokensUsed: 10_000,
      tokensHardCap: 20_000,
      recentMessages: [{ role: 'user', content: 'hello' }],
      trigger: trigger!,
    });

    // Caller-path await contract: the persisted file MUST be observable
    // immediately after the writeCheckpoint() Promise resolves. If
    // persist() had been fire-and-forget (not awaited), this check
    // would race and intermittently fail.
    expect(result.filePath).toBe(join(storageDir, `${runId}.md`));
    expect(existsSync(result.filePath)).toBe(true);

    const content = readFileSync(result.filePath, 'utf-8');
    expect(content).toContain('# Checkpoint v1');
    expect(content).toContain('Async-migration persist await test');
    expect(content).toContain('decided to test async-migration contract');
    expect(content).toContain('Phase**: EXECUTION');
    expect(content).toContain('Step**: 5');

    writer.reset();
  });
});

// ============================================================================
// (f) CheckpointWriter.isTriggerFired idempotency — uses getTriggerFiredCount
// ============================================================================

describe('async-migration / CheckpointWriter.isTriggerFired idempotency', () => {
  let storageDir2: string;

  beforeEach(() => {
    storageDir2 = mkdtempSync(join(tmpdir(), 'checkpoint-writer-idem-'));
  });

  afterEach(() => {
    rmSync(storageDir2, { recursive: true, force: true });
  });

  it('isTriggerFired reports true after shouldTrigger consumes a point', async () => {
    const { CheckpointWriter } = await import('../../src/runtime/checkpointWriter');
    const writer = new CheckpointWriter({ storageDir: storageDir2 });
    writer.reset();
    const runId = 'idem-test-run';

    // 50% ratio → 0.2 trigger point fires first per the for-loop order.
    const trigger = writer.shouldTrigger(runId, 10_000, 20_000);
    expect(trigger).not.toBeNull();
    expect(trigger!.percent).toBe(20);

    // Use the new @internal accessor instead of writer['firedTriggers'].has(...)
    expect(writer.isTriggerFired(runId, 0.2)).toBe(true);
    expect(writer.isTriggerFired(runId, 0.45)).toBe(false);
    expect(writer.getTriggerFiredCount(runId)).toBe(1);

    // Subsequent shouldTrigger at the same ratio returns null (idempotent).
    expect(writer.shouldTrigger(runId, 10_000, 20_000)).toBeNull();
    expect(writer.getTriggerFiredCount(runId)).toBe(1);
    writer.reset();
  });
});
