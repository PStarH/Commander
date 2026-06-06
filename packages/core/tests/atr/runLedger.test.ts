// RunLedger tests — P0-2 ATR kernel component (run state machine + saga compensation).

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RunLedger } from '../../src/atr/runLedger';
import { LeaseManager } from '../../src/atr/leaseManager';
import { IdempotencyStore } from '../../src/atr/idempotencyStore';
import type { CompensationHandler } from '../../src/atr/runLedger';

function newLedger(): RunLedger {
  const lease = new LeaseManager({
    filePath: ':memory:',
    defaultTtlSeconds: 60,
    defaultHolder: 'test',
  });
  const idempotency = new IdempotencyStore({
    filePath: ':memory:',
    defaultTtlSeconds: 60,
    evictEveryOps: 100_000,
    maxRecords: 1000,
  });
  return new RunLedger(lease, idempotency, {
    filePath: ':memory:',
    defaultTtlSeconds: 60,
    defaultHolder: 'test',
    defaultIdempotencyTtlSeconds: 60,
  });
}

describe('RunLedger', () => {
  describe('start', () => {
    it('creates a new transaction in PENDING state', () => {
      const ledger = newLedger();
      const { lease, tx } = ledger.start({
        runId: 'run-1',
        intentHash: 'hash-A',
      });
      assert.strictEqual(lease.acquired, true);
      assert.strictEqual(tx.state, 'PENDING');
      assert.strictEqual(tx.intentHash, 'hash-A');
      assert.strictEqual(tx.fencingEpoch, 1);
      assert.ok(tx.leaseToken.length > 0);
    });

    it('returns existing transaction on second start', () => {
      const ledger = newLedger();
      const a = ledger.start({ runId: 'run-2', intentHash: 'h' });
      const b = ledger.start({ runId: 'run-2', intentHash: 'h' });
      assert.strictEqual(a.lease.acquired, true);
      assert.strictEqual(b.lease.acquired, false);
      assert.strictEqual(b.tx.leaseToken, a.tx.leaseToken);
    });
  });

  describe('state transitions', () => {
    it('PENDING → EXECUTING → VERIFYING → COMMITTED', () => {
      const ledger = newLedger();
      const { tx } = ledger.start({ runId: 'run-3', intentHash: 'h' });
      assert.strictEqual(ledger.beginExecuting('run-3', tx.leaseToken, tx.fencingEpoch), true);
      assert.strictEqual(ledger.beginVerifying('run-3', tx.leaseToken, tx.fencingEpoch), true);
      assert.strictEqual(ledger.commit('run-3', tx.leaseToken, tx.fencingEpoch), true);
    });

    it('rejects state transition with wrong token (fenced)', () => {
      const ledger = newLedger();
      const { tx } = ledger.start({ runId: 'run-4', intentHash: 'h' });
      const ok = ledger.beginExecuting('run-4', 'wrong-token', tx.fencingEpoch);
      assert.strictEqual(ok, false);
    });

    it('rejects state transition with stale epoch (fenced)', () => {
      const ledger = newLedger();
      const { tx } = ledger.start({ runId: 'run-5', intentHash: 'h' });
      const ok = ledger.beginExecuting('run-5', tx.leaseToken, tx.fencingEpoch - 1);
      assert.strictEqual(ok, false);
    });
  });

  describe('recordAction', () => {
    it('persists a compensable action on an active run', () => {
      const ledger = newLedger();
      const { tx } = ledger.start({ runId: 'run-6', intentHash: 'h' });
      const action = ledger.recordAction({
        runId: 'run-6',
        leaseToken: tx.leaseToken,
        fencingEpoch: tx.fencingEpoch,
        toolName: 'github.create_pr',
        externalSystem: 'github',
        args: { repo: 'foo', head: 'feat' },
        idempotencyKey: 'idem-1',
        compensable: true,
      });
      assert.ok(action);
      assert.strictEqual(action!.toolName, 'github.create_pr');
      assert.strictEqual(action!.compensable, true);
    });

    it('rejects recordAction with wrong lease (fenced)', () => {
      const ledger = newLedger();
      const { tx } = ledger.start({ runId: 'run-7', intentHash: 'h' });
      const action = ledger.recordAction({
        runId: 'run-7',
        leaseToken: 'wrong',
        fencingEpoch: tx.fencingEpoch,
        toolName: 't',
        externalSystem: 'e',
        args: {},
        idempotencyKey: 'k',
        compensable: true,
      });
      assert.strictEqual(action, null);
    });
  });

  describe('abortAndCompensate (saga)', () => {
    it('runs compensation handlers in reverse execution order', async () => {
      const ledger = newLedger();
      const { tx } = ledger.start({ runId: 'run-8', intentHash: 'h' });
      ledger.beginExecuting('run-8', tx.leaseToken, tx.fencingEpoch);

      const order: string[] = [];
      const makeHandler = (): CompensationHandler => async (action) => {
        order.push(action.actionId);
        return { success: true };
      };
      ledger.registerCompensation('tool-a', makeHandler());
      ledger.registerCompensation('tool-b', makeHandler());
      ledger.registerCompensation('tool-c', makeHandler());

      const a1 = ledger.recordAction({
        runId: 'run-8', leaseToken: tx.leaseToken, fencingEpoch: tx.fencingEpoch,
        toolName: 'tool-a', externalSystem: 'test', args: {}, idempotencyKey: 'k1', compensable: true,
      });
      const a2 = ledger.recordAction({
        runId: 'run-8', leaseToken: tx.leaseToken, fencingEpoch: tx.fencingEpoch,
        toolName: 'tool-b', externalSystem: 'test', args: {}, idempotencyKey: 'k2', compensable: true,
      });
      const a3 = ledger.recordAction({
        runId: 'run-8', leaseToken: tx.leaseToken, fencingEpoch: tx.fencingEpoch,
        toolName: 'tool-c', externalSystem: 'test', args: {}, idempotencyKey: 'k3', compensable: true,
      });

      const result = await ledger.abortAndCompensate(
        'run-8', tx.leaseToken, tx.fencingEpoch, 'simulated failure',
      );
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(result.outcome.succeeded, 3);
      assert.strictEqual(result.outcome.failed, 0);
      assert.deepStrictEqual(order, [a3!.actionId, a2!.actionId, a1!.actionId]);
    });

    it('reports errors in outcome.errors for failed compensations', async () => {
      const ledger = newLedger();
      const { tx } = ledger.start({ runId: 'run-9', intentHash: 'h' });
      ledger.beginExecuting('run-9', tx.leaseToken, tx.fencingEpoch);

      const failHandler: CompensationHandler = async () => ({
        success: false,
        error: 'external system down',
      });
      ledger.registerCompensation('tool-x', failHandler);

      ledger.recordAction({
        runId: 'run-9', leaseToken: tx.leaseToken, fencingEpoch: tx.fencingEpoch,
        toolName: 'tool-x', externalSystem: 'test', args: {}, idempotencyKey: 'k1', compensable: true,
      });

      const result = await ledger.abortAndCompensate(
        'run-9', tx.leaseToken, tx.fencingEpoch, 'abort',
      );
      assert.strictEqual(result.outcome.succeeded, 0);
      assert.ok(result.outcome.failed > 0);
      assert.ok(result.outcome.errors.length > 0);
      assert.strictEqual(result.outcome.errors[0].error, 'external system down');
    });
  });
});
