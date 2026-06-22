import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { RecoveryBootstrapper } from '../../src/atr/recoveryBootstrapper';
import { getRunLedgerBundle, resetRunLedgerBundle } from '../../src/atr/runLedger';
import { getExecutionScheduler, resetExecutionScheduler } from '../../src/atr/scheduler';
import { resetDeadLetterQueue } from '../../src/runtime/deadLetterQueueSingleton';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetIdempotencyStore } from '../../src/atr/idempotencyStore';
import { resetCompensationBridge } from '../../src/atr/compensationBridge';

describe('RecoveryBootstrapper', () => {
  beforeEach(() => {
    process.env.COMMANDER_ATR_MEMORY = '1';
    process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
    resetRunLedgerBundle();
    resetExecutionScheduler();
    resetDeadLetterQueue();
    resetMessageBus();
    resetIdempotencyStore();
    resetCompensationBridge();
  });

  afterEach(() => {
    resetRunLedgerBundle();
    resetExecutionScheduler();
    resetDeadLetterQueue();
    resetMessageBus();
    resetIdempotencyStore();
    resetCompensationBridge();
    delete process.env.COMMANDER_ATR_MEMORY;
    delete process.env.COMMANDER_ATR_IDEMPOTENCY_PATH;
  });

  it('returns scanned=0 when no zombie runs exist', () => {
    const result = RecoveryBootstrapper.bootstrap();
    assert.strictEqual(result.scanned, 0);
    assert.strictEqual(result.recovered, 0);
    assert.strictEqual(result.aborted, 0);
    assert.strictEqual(result.skipped, 0);
    assert.deepStrictEqual(result.details, []);
  });

  it('aborts expired EXECUTING runs', () => {
    const sched = getExecutionScheduler();
    sched.beginRun({ runId: 'zombie-exec', goal: 'test', ttlSeconds: -1 });

    const result = RecoveryBootstrapper.bootstrap();

    assert.strictEqual(result.scanned, 1);
    assert.strictEqual(result.aborted, 1);
    assert.strictEqual(result.details[0].action, 'aborted');
    assert.strictEqual(result.details[0].state, 'EXECUTING');

    const bundle = getRunLedgerBundle();
    assert.strictEqual(bundle.ledger.listByState('EXECUTING').length, 0);
  });

  it('aborts expired VERIFYING runs', () => {
    const sched = getExecutionScheduler();
    const handle = sched.beginRun({ runId: 'zombie-verify', goal: 'test', ttlSeconds: -1 });
    const bundle = getRunLedgerBundle();
    bundle.ledger.beginVerifying(handle.runId, handle.leaseToken, handle.fencingEpoch);

    const result = RecoveryBootstrapper.bootstrap();

    assert.strictEqual(result.scanned, 1);
    assert.strictEqual(result.aborted, 1);
    assert.strictEqual(result.details[0].action, 'aborted');
  });

  it('skips runs with still-valid leases', () => {
    const sched = getExecutionScheduler();
    sched.beginRun({ runId: 'alive-run', goal: 'test' });

    const result = RecoveryBootstrapper.bootstrap();

    assert.strictEqual(result.scanned, 1);
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.details[0].action, 'skipped');

    const bundle = getRunLedgerBundle();
    assert.ok(bundle.ledger.listByState('EXECUTING')
      .some((r: { runId: string }) => r.runId === 'alive-run'));
  });

  it('handles multiple zombie runs', () => {
    const sched = getExecutionScheduler();
    sched.beginRun({ runId: 'z-1', goal: 'z1', ttlSeconds: -1 });
    sched.beginRun({ runId: 'z-2', goal: 'z2', ttlSeconds: -1 });
    sched.beginRun({ runId: 'z-3', goal: 'z3', ttlSeconds: -1 });

    const result = RecoveryBootstrapper.bootstrap();

    assert.strictEqual(result.scanned, 3);
    assert.strictEqual(result.aborted, 3);
  });

  it('handles missing globals gracefully', () => {
    resetRunLedgerBundle();
    resetExecutionScheduler();
    resetDeadLetterQueue();
    resetMessageBus();

    const result = RecoveryBootstrapper.bootstrap();
    assert.strictEqual(result.scanned, 0);
  });
});
