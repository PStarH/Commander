import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import { RecoveryBootstrapper } from '../../src/atr/recoveryBootstrapper';
import { getRunLedgerBundle, resetRunLedgerBundle } from '../../src/atr/runLedger';
import {
  ExecutionScheduler,
  getExecutionScheduler,
  resetExecutionScheduler,
} from '../../src/atr/scheduler';
import type { AbortResult } from '../../src/atr/scheduler';
import { resetDeadLetterQueue } from '../../src/runtime/deadLetterQueueSingleton';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetIdempotencyStore } from '../../src/atr/idempotencyStore';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A scheduler built over the SAME bundle the bootstrapper will scan. */
function sameBundleScheduler(): ExecutionScheduler {
  const bundle = getRunLedgerBundle();
  return new ExecutionScheduler({
    lease: bundle.lease,
    idempotency: bundle.idempotency,
    ledger: bundle.ledger,
  });
}

/**
 * Simulate a crashed process: the lease row AND the run row's denormalized
 * expiry must both be in the past. `heartbeat(-1)` is the only public way to
 * move a live lease's expiry backwards.
 */
function expireRun(runId: string, leaseToken: string, tenantId?: string): void {
  const bundle = getRunLedgerBundle();
  assert.strictEqual(bundle.lease.heartbeat(runId, leaseToken, { tenantId, ttlSeconds: -1 }), true);
  const live = bundle.lease.get(runId, { tenantId });
  assert.ok(live, 'the expired lease must still exist in the lease table');
  assert.strictEqual(
    bundle.ledger.syncLeaseCredentials(runId, live!.token, live!.fencingEpoch, {
      tenantId,
      expiresAt: live!.expiresAt,
    }),
    true,
  );
}

describe('RecoveryBootstrapper', () => {
  beforeEach(() => {
    process.env.COMMANDER_ATR_MEMORY = '1';
    process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
    resetRunLedgerBundle();
    resetExecutionScheduler();
    resetDeadLetterQueue();
    resetMessageBus();
    resetIdempotencyStore();
  });

  afterEach(() => {
    resetRunLedgerBundle();
    resetExecutionScheduler();
    resetDeadLetterQueue();
    resetMessageBus();
    resetIdempotencyStore();
    delete process.env.COMMANDER_ATR_MEMORY;
    delete process.env.COMMANDER_ATR_IDEMPOTENCY_PATH;
  });

  it('returns scanned=0 when no zombie runs exist', async () => {
    const result = await RecoveryBootstrapper.bootstrap();
    assert.strictEqual(result.scanned, 0);
    assert.strictEqual(result.recovered, 0);
    assert.strictEqual(result.aborted, 0);
    assert.strictEqual(result.compensated, 0);
    assert.strictEqual(result.prepared, 0);
    assert.strictEqual(result.manualRecovery, 0);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.skipped, 0);
    assert.deepStrictEqual(result.details, []);
  });

  it('aborts expired EXECUTING runs from the real abort result', async () => {
    const sched = getExecutionScheduler();
    const handle = sched.beginRun({ runId: 'zombie-exec', goal: 'test' });
    expireRun(handle.runId, handle.leaseToken);

    const result = await RecoveryBootstrapper.bootstrap();

    assert.strictEqual(result.scanned, 1);
    assert.strictEqual(result.aborted, 1);
    assert.strictEqual(result.compensated, 1);
    assert.strictEqual(result.recovered, 1);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.details[0].action, 'aborted');
    assert.strictEqual(result.details[0].state, 'EXECUTING');

    const bundle = getRunLedgerBundle();
    assert.strictEqual(bundle.ledger.listByState('EXECUTING').length, 0);
    assert.strictEqual(bundle.ledger.listByState('COMPENSATED').length, 1);
  });

  it('aborts expired VERIFYING runs', async () => {
    const sched = getExecutionScheduler();
    const handle = sched.beginRun({ runId: 'zombie-verify', goal: 'test' });
    const bundle = getRunLedgerBundle();
    assert.strictEqual(
      bundle.ledger.beginVerifying(handle.runId, handle.leaseToken, handle.fencingEpoch),
      true,
    );
    expireRun(handle.runId, handle.leaseToken);

    const result = await RecoveryBootstrapper.bootstrap();

    assert.strictEqual(result.scanned, 1);
    assert.strictEqual(result.aborted, 1);
    assert.strictEqual(result.compensated, 1);
    assert.strictEqual(result.details[0].action, 'aborted');
    assert.strictEqual(result.details[0].state, 'VERIFYING');
  });

  it('skips runs with still-valid leases', async () => {
    const sched = getExecutionScheduler();
    sched.beginRun({ runId: 'alive-run', goal: 'test' });

    const result = await RecoveryBootstrapper.bootstrap();

    assert.strictEqual(result.scanned, 1);
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.aborted, 0);
    assert.strictEqual(result.details[0].action, 'skipped');

    const bundle = getRunLedgerBundle();
    assert.ok(
      bundle.ledger
        .listByState('EXECUTING')
        .some((r: { runId: string }) => r.runId === 'alive-run'),
    );
  });

  it('handles multiple zombie runs', async () => {
    const sched = getExecutionScheduler();
    for (const id of ['z-1', 'z-2', 'z-3']) {
      const handle = sched.beginRun({ runId: id, goal: id });
      expireRun(handle.runId, handle.leaseToken);
    }

    const result = await RecoveryBootstrapper.bootstrap();

    assert.strictEqual(result.scanned, 3);
    assert.strictEqual(result.aborted, 3);
    assert.strictEqual(result.compensated, 3);
  });

  it('handles missing globals gracefully', async () => {
    resetRunLedgerBundle();
    resetExecutionScheduler();
    resetDeadLetterQueue();
    resetMessageBus();

    const result = await RecoveryBootstrapper.bootstrap();
    assert.strictEqual(result.scanned, 0);
  });

  // ── AR-01: never report success before compensation settles ──────────────

  it('does not resolve, and keeps the lease, until compensation settles', async () => {
    const bundle = getRunLedgerBundle();
    const sched = sameBundleScheduler();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let handlerEntered = false;
    sched.registerCompensation('slow_tool', async () => {
      handlerEntered = true;
      await gate;
      return { success: true };
    });

    const handle = sched.beginRun({ runId: 'z-slow', goal: 'g' });
    assert.ok(
      sched.scheduleAction({
        runId: handle.runId,
        leaseToken: handle.leaseToken,
        fencingEpoch: handle.fencingEpoch,
        toolName: 'slow_tool',
        externalSystem: 's',
        args: {},
        idempotencyKey: 'k-slow',
        compensable: true,
      }),
    );
    expireRun(handle.runId, handle.leaseToken);

    let settled = false;
    const pending = RecoveryBootstrapper.bootstrap({ scheduler: sched }).then((r) => {
      settled = true;
      return r;
    });

    for (let i = 0; i < 100 && !handlerEntered; i++) await sleep(10);
    assert.strictEqual(handlerEntered, true, 'compensation handler must have started');
    assert.strictEqual(settled, false, 'bootstrap must not resolve while compensation is running');
    assert.ok(bundle.lease.get('z-slow'), 'the recovery lease must be held while compensating');

    release();
    const result = await pending;
    assert.strictEqual(result.aborted, 1);
    assert.strictEqual(result.compensated, 1);
    assert.strictEqual(result.recovered, 1);
    assert.strictEqual(bundle.lease.get('z-slow'), null, 'lease released after settlement');
  });

  it('renews the reclaimed lease while compensation is still running', async () => {
    const bundle = getRunLedgerBundle();
    const sched = sameBundleScheduler();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let abortEntered = false;
    sched.abortRun = async (): Promise<AbortResult> => {
      abortEntered = true;
      await gate;
      return { aborted: true, outcome: { attempted: 0, succeeded: 0, failed: 0, errors: [] } };
    };

    const handle = getExecutionScheduler().beginRun({ runId: 'z-renew', goal: 'g' });
    expireRun(handle.runId, handle.leaseToken);

    const pending = RecoveryBootstrapper.bootstrap({ scheduler: sched, leaseTtlSeconds: 2 });

    for (let i = 0; i < 100 && !abortEntered; i++) await sleep(10);
    assert.strictEqual(abortEntered, true);
    const first = bundle.lease.get('z-renew');
    assert.ok(first);
    const firstExpiry = new Date(first!.expiresAt).getTime();

    // Without the renewal heartbeat the lease would expire 2s in; the interval
    // runs every second while compensation is in flight.
    let extended = false;
    for (let i = 0; i < 60 && !extended; i++) {
      await sleep(100);
      const live = bundle.lease.get('z-renew');
      extended = !!live && new Date(live.expiresAt).getTime() > firstExpiry + 200;
    }
    assert.strictEqual(extended, true, 'the lease must be renewed while compensating');

    release();
    await pending;
  });

  it('two recovery runners cannot both hold the same run', async () => {
    const sched = sameBundleScheduler();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let abortEntered = false;
    // Patch abortRun so the run stays EXECUTING while the gate is closed,
    // which is the window in which a second runner must not take the lease.
    sched.abortRun = async (): Promise<AbortResult> => {
      abortEntered = true;
      await gate;
      return { aborted: true, outcome: { attempted: 0, succeeded: 0, failed: 0, errors: [] } };
    };

    const handle = getExecutionScheduler().beginRun({ runId: 'z-race', goal: 'g' });
    expireRun(handle.runId, handle.leaseToken);

    const first = RecoveryBootstrapper.bootstrap({ scheduler: sched });
    for (let i = 0; i < 100 && !abortEntered; i++) await sleep(10);
    assert.strictEqual(abortEntered, true);

    // The second runner sees a live lease held by the first and must skip.
    const second = await RecoveryBootstrapper.bootstrap();
    assert.strictEqual(second.skipped, 1);
    assert.strictEqual(second.aborted, 0);

    release();
    const firstResult = await first;
    assert.strictEqual(firstResult.aborted, 1);
  });

  // ── AR-01: record from the REAL return values ───────────────────────────

  it('reports aborted but not compensated when compensation fails', async () => {
    const sched = sameBundleScheduler();
    const handle = getExecutionScheduler().beginRun({ runId: 'z-fail', goal: 'g' });
    expireRun(handle.runId, handle.leaseToken);

    // Patch abortRun: a real failing compensation would trigger the
    // scheduler's git-snapshot fallback, which runs `git reset --hard` in the
    // user's repository. This test only pins bootstrap's recording logic.
    sched.abortRun = async (): Promise<AbortResult> => ({
      aborted: true,
      outcome: {
        attempted: 1,
        succeeded: 0,
        failed: 1,
        errors: [{ actionId: 'a1', toolName: 't', error: 'external down' }],
      },
    });

    const result = await RecoveryBootstrapper.bootstrap({ scheduler: sched });

    assert.strictEqual(result.aborted, 1);
    assert.strictEqual(result.compensated, 0);
    assert.strictEqual(result.recovered, 0);
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.details[0].action, 'aborted');
    assert.match(result.details[0].reason, /failed/);
  });

  it('reports a refused abort as failed, never as recovered', async () => {
    const sched = sameBundleScheduler();
    const handle = getExecutionScheduler().beginRun({ runId: 'z-refused', goal: 'g' });
    expireRun(handle.runId, handle.leaseToken);

    sched.abortRun = async (): Promise<AbortResult> => ({
      aborted: false,
      reason: 'fenced',
      outcome: { attempted: 0, succeeded: 0, failed: 0, errors: [] },
    });

    const result = await RecoveryBootstrapper.bootstrap({ scheduler: sched });

    assert.strictEqual(result.aborted, 0);
    assert.strictEqual(result.compensated, 0);
    assert.strictEqual(result.recovered, 0);
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.details[0].action, 'failed');
  });

  it('isolates a per-run recovery exception and continues the scan', async () => {
    const sched = sameBundleScheduler();
    for (const id of ['z-throws', 'z-ok']) {
      const handle = getExecutionScheduler().beginRun({ runId: id, goal: id });
      expireRun(handle.runId, handle.leaseToken);
    }
    sched.abortRun = async (input): Promise<AbortResult> => {
      if (input.runId === 'z-throws') throw new Error('compensation exploded');
      return {
        aborted: true,
        outcome: { attempted: 0, succeeded: 0, failed: 0, errors: [] },
      };
    };

    const result = await RecoveryBootstrapper.bootstrap({ scheduler: sched });

    assert.strictEqual(result.scanned, 2);
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.aborted, 1);
    assert.strictEqual(result.compensated, 1);
  });

  // ── AR-01: missing lease / PAUSED handling ──────────────────────────────

  it('records a non-terminal run with no lease as explicit manual recovery', async () => {
    const bundle = getRunLedgerBundle();
    const sched = getExecutionScheduler();
    const handle = sched.beginRun({ runId: 'z-nolease', goal: 'g' });
    // The lease disappears entirely (released/killed) while the run stays
    // EXECUTING — this must not be silently ignored.
    bundle.lease.release(handle.runId, handle.leaseToken);

    const result = await RecoveryBootstrapper.bootstrap();

    assert.strictEqual(result.scanned, 1);
    assert.strictEqual(result.manualRecovery, 1);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.recovered, 0);
    assert.strictEqual(result.details[0].action, 'manual_recovery');
    assert.ok(
      bundle.ledger
        .listByState('EXECUTING')
        .some((r: { runId: string }) => r.runId === 'z-nolease'),
    );
  });

  it('reports PAUSED as prepared/manual-resume, not resumed', async () => {
    const bundle = getRunLedgerBundle();
    const sched = getExecutionScheduler();
    const handle = sched.beginRun({ runId: 'z-paused', goal: 'g' });
    assert.strictEqual(
      sched.pauseRun({
        runId: handle.runId,
        leaseToken: handle.leaseToken,
        fencingEpoch: handle.fencingEpoch,
        reason: 'human_input_required',
      }).paused,
      true,
    );
    expireRun(handle.runId, handle.leaseToken);

    const result = await RecoveryBootstrapper.bootstrap();

    assert.strictEqual(result.scanned, 1);
    assert.strictEqual(result.prepared, 1);
    assert.strictEqual(result.recovered, 0);
    assert.strictEqual(result.aborted, 0);
    assert.strictEqual(result.details[0].action, 'prepared');
    assert.match(result.details[0].reason, /manual resume/);
    // Still PAUSED — nothing resumed it.
    assert.strictEqual(bundle.ledger.getTransaction('z-paused')!.state, 'PAUSED');
  });

  it('only actually resumes PAUSED when resume is separately confirmed', async () => {
    const bundle = getRunLedgerBundle();
    const sched = getExecutionScheduler();
    const handle = sched.beginRun({ runId: 'z-confirm', goal: 'g' });
    sched.pauseRun({
      runId: handle.runId,
      leaseToken: handle.leaseToken,
      fencingEpoch: handle.fencingEpoch,
      resumeAt: new Date(Date.now() + 60_000).toISOString(),
      reason: 'timer',
    });
    expireRun(handle.runId, handle.leaseToken);

    const result = await RecoveryBootstrapper.bootstrap({ confirmResume: true });

    assert.strictEqual(result.recovered, 1);
    assert.strictEqual(result.prepared, 0);
    assert.strictEqual(result.details[0].action, 'resumed');
    assert.strictEqual(bundle.ledger.getTransaction('z-confirm')!.state, 'EXECUTING');
  });

  it('forceAbort aborts a PAUSED run instead of preparing it', async () => {
    const sched = getExecutionScheduler();
    const handle = sched.beginRun({ runId: 'z-force', goal: 'g' });
    sched.pauseRun({
      runId: handle.runId,
      leaseToken: handle.leaseToken,
      fencingEpoch: handle.fencingEpoch,
      reason: 'human_input_required',
    });
    expireRun(handle.runId, handle.leaseToken);

    const result = await RecoveryBootstrapper.bootstrap({ forceAbort: true });

    assert.strictEqual(result.aborted, 1);
    assert.strictEqual(result.prepared, 0);
    assert.strictEqual(result.details[0].action, 'aborted');
  });
});
