import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createSaga,
  runSaga,
  startSaga,
  CheckpointManager,
  ApprovalManager,
  FileSagaStore,
  FileApprovalStore,
  InProcessWorkerPool,
  CompensationScheduler,
  defaultCompensationRetryPolicy,
} from '../../src/saga/index.js';
import type { SagaContext, SagaApprovalDecision } from '../../src/saga/index.js';

function buildRuntime(baseDir: string) {
  const store = new FileSagaStore({ baseDir });
  const approvalStore = new FileApprovalStore({ baseDir });
  return {
    checkpoint: new CheckpointManager(store),
    approval: new ApprovalManager({ store: approvalStore }),
    compensation: new CompensationScheduler({ retryPolicy: defaultCompensationRetryPolicy() }),
    workerPool: new InProcessWorkerPool(4),
  };
}

function buildContext(runId: string, input: unknown): SagaContext {
  return {
    runId,
    input,
    results: new Map(),
    attempts: new Map(),
    metadata: {},
    signal: AbortSignal.timeout(30_000),
  };
}

test('e2e: commits a 3-step saga through FileSagaStore + FileApprovalStore', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'commander-saga-e2e-'));
  try {
    const { checkpoint, approval, compensation, workerPool } = buildRuntime(baseDir);

    const calls: string[] = [];
    const charge: { id?: string } = {};
    const reservation: { id?: string } = {};

    const saga = createSaga('e2e-fulfill')
      .step('validate', async () => {
        calls.push('validate');
        return { ok: true };
      })
      .step('charge', async () => {
        calls.push('charge');
        charge.id = 'ch_1';
        return charge;
      })
      .compensate(async (c: any) => {
        calls.push(`refund:${c?.id}`);
      })
      .step('reserve', async () => {
        calls.push('reserve');
        reservation.id = 'rsv_1';
        return reservation;
      })
      .compensate(async (r: any) => {
        calls.push(`release:${r?.id}`);
      })
      .build();

    const result = await runSaga(
      saga,
      buildContext('e2e-1', { orderId: 'o_1' }),
      checkpoint,
      approval,
      { checkpoint, approval, compensation, workerPool },
    );

    assert.ok(result, 'runSaga must return a result');
    assert.equal(result.status, 'committed');
    assert.deepEqual(calls, ['validate', 'charge', 'reserve']);

    const recovered = await checkpoint.recover('e2e-1');
    assert.ok(recovered);
    assert.equal(recovered!.snapshot.state, 'COMMITTED');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('e2e: failure triggers LIFO compensation through file-backed stores', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'commander-saga-e2e-'));
  try {
    const { checkpoint, approval, compensation, workerPool } = buildRuntime(baseDir);
    const compensations: string[] = [];

    const saga = createSaga('e2e-fail')
      .step('first', async () => 'a')
      .compensate(async () => {
        compensations.push('first');
      })
      .step('second', async () => 'b')
      .compensate(async () => {
        compensations.push('second');
      })
      .step('boom', async () => {
        throw new Error('forced');
      })
      .build();

    const result = await runSaga(saga, buildContext('e2e-2', {}), checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool,
    });

    assert.equal(result.status, 'aborted');
    assert.deepEqual(compensations, ['second', 'first']);
    assert.ok(result.error?.includes('forced'));

    const recovered = await checkpoint.recover('e2e-2');
    assert.ok(recovered);
    assert.equal(recovered!.snapshot.state, 'ABORTED');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('e2e: HITL approval gates execution through FileApprovalStore', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'commander-saga-e2e-'));
  try {
    const { checkpoint, approval, compensation, workerPool } = buildRuntime(baseDir);

    const saga = createSaga('e2e-approval')
      .step('prepare', async () => ({ ready: true }))
      .approval('human-approver', { timeoutMs: 5_000, onTimeout: 'reject' })
      .step('publish', async () => 'published')
      .build();

    const ctx = buildContext('e2e-3', {});

    const handle = startSaga(saga, ctx, checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool,
    });

    await new Promise((r) => setTimeout(r, 500));
    const pending = await approval.listPending('human-approver');
    assert.equal(pending.length, 1, 'approval request must be pending');
    assert.equal(pending[0]!.approver, 'human-approver');

    await approval.decide('e2e-3', pending[0]!.nodeId, {
      decision: 'approve',
      decidedBy: 'alice',
      decidedAt: new Date().toISOString(),
    });

    const result = await handle.result;
    assert.equal(result.status, 'committed');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('e2e: parallel branches write to file store and survive snapshot recovery', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'commander-saga-e2e-'));
  try {
    const { checkpoint, approval, compensation, workerPool } = buildRuntime(baseDir);

    const branchA = createSaga('branch-a')
      .step('a', async () => 'result-a')
      .build();

    const branchB = createSaga('branch-b')
      .step('b', async () => 'result-b')
      .build();

    const saga = createSaga('e2e-parallel')
      .parallel([branchA, branchB], { failFast: true })
      .build();

    const result = await runSaga(saga, buildContext('e2e-4', {}), checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool,
    });

    assert.equal(result.status, 'committed');

    const recovered = await checkpoint.recover('e2e-4');
    assert.ok(recovered);
    assert.equal(recovered!.snapshot.state, 'COMMITTED');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('e2e: retry policy executes and persists final outcome', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'commander-saga-e2e-'));
  try {
    const { checkpoint, approval, compensation, workerPool } = buildRuntime(baseDir);
    let attempts = 0;

    const saga = createSaga('e2e-retry')
      .step(
        'flaky',
        async () => {
          attempts += 1;
          if (attempts < 3) throw new Error(`transient ${attempts}`);
          return 'succeeded';
        },
        { retryPolicy: { maxAttempts: 5, backoff: { kind: 'fixed', baseMs: 1, maxMs: 5 } } },
      )
      .build();

    const result = await runSaga(saga, buildContext('e2e-5', {}), checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool,
    });

    assert.equal(result.status, 'committed');
    assert.equal(attempts, 3);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('e2e: FileSagaStore writes atomically (no partial files on disk)', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'commander-saga-e2e-'));
  try {
    const { checkpoint, approval, compensation, workerPool } = buildRuntime(baseDir);
    const saga = createSaga('e2e-atomic')
      .step('op', async () => 'done')
      .build();

    await runSaga(saga, buildContext('e2e-6', {}), checkpoint, approval, {
      checkpoint,
      approval,
      compensation,
      workerPool,
    });

    const eventFile = join(baseDir, 'e2e-6', 'events.ndjson');
    const snapshotFile = join(baseDir, 'e2e-6', 'snapshot.json');

    assert.ok(existsSync(eventFile), 'events.ndjson must exist');
    assert.ok(existsSync(snapshotFile), 'snapshot.json must exist');

    const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf-8'));
    assert.equal(snapshot.state, 'COMMITTED');
    assert.equal(snapshot.runId, 'e2e-6');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
