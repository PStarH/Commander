import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { CompensationBridge, resetCompensationBridge, getCompensationBridge } from '../../src/atr/compensationBridge';
import { resetRunLedgerBundle, getRunLedgerBundle } from '../../src/atr/runLedger';
import type { CompensableAction } from '../../src/runtime/compensationRegistry';

function makeAction(
  actionId: string,
  toolName: string,
  args: Record<string, unknown> = {},
): CompensableAction {
  return {
    actionId,
    toolName,
    args,
    description: `${toolName} ${actionId}`,
    tags: [toolName],
  };
}

describe('CompensationBridge', () => {
  beforeEach(() => {
    process.env.COMMANDER_ATR_MEMORY = '1';
    resetCompensationBridge();
    resetRunLedgerBundle();
  });

  afterEach(() => {
    delete process.env.COMMANDER_ATR_MEMORY;
    resetCompensationBridge();
    resetRunLedgerBundle();
  });

  describe('register', () => {
    it('dual-writes handlers to legacy map and ledger', () => {
      const bridge = new CompensationBridge();
      const calls: string[] = [];
      bridge.register('tool_a', async (a) => {
        calls.push(a.actionId);
        return { success: true };
      });

      const legacy = bridge.getLegacy();
      const bundle = getRunLedgerBundle();
      const startA = bundle.ledger.start({ runId: 'run-1', intentHash: 'h1', ttlSeconds: 60, holder: 't' });

      const action = makeAction('act-1', 'tool_a');
      const sagaId = bridge.recordActionSaga(action, {
        runId: 'run-1',
        leaseToken: startA.tx.leaseToken,
        fencingEpoch: startA.tx.fencingEpoch,
      });
      assert.ok(sagaId);

      return bridge.compensateViaLedger('run-1', startA.tx.leaseToken, startA.tx.fencingEpoch, 'test')
        .then((res) => {
          assert.strictEqual(res.aborted, true);
          assert.strictEqual(res.outcome.succeeded, 1);
          assert.deepStrictEqual(calls, ['act-1']);
        });
    });
  });

  describe('recordActionSaga', () => {
    it('persists action to ledger AND legacy (dual write)', () => {
      const bridge = new CompensationBridge();
      const bundle = getRunLedgerBundle();
      const { tx } = bundle.ledger.start({ runId: 'run-1', intentHash: 'h1', ttlSeconds: 60, holder: 't' });

      const action = makeAction('act-7', 'github_create_pr', { title: 'fix' });
      const sagaId = bridge.recordActionSaga(action, {
        runId: 'run-1',
        leaseToken: tx.leaseToken,
        fencingEpoch: tx.fencingEpoch,
      });

      assert.ok(sagaId);
      assert.strictEqual(bridge.getPendingCount(), 1, 'legacy has the action');
      const ledgerTx = bundle.ledger.getTransaction('run-1')!;
      assert.strictEqual(ledgerTx.actions.length, 1, 'ledger persisted the action');
      assert.strictEqual(ledgerTx.actions[0].toolName, 'github_create_pr');
    });

    it('returns null and does NOT dual-write when caller is fenced', () => {
      const bridge = new CompensationBridge();
      const bundle = getRunLedgerBundle();
      const { tx } = bundle.ledger.start({ runId: 'run-1', intentHash: 'h1', ttlSeconds: 60, holder: 't' });

      const action = makeAction('act-x', 'github_create_pr');
      const sagaId = bridge.recordActionSaga(action, {
        runId: 'run-1',
        leaseToken: 'fake-token',
        fencingEpoch: 999,
      });

      assert.strictEqual(sagaId, null);
      assert.strictEqual(bridge.getPendingCount(), 0, 'legacy untouched on fence rejection');
    });

    it('returns null when no transaction exists for runId', () => {
      const bridge = new CompensationBridge();
      const action = makeAction('act-y', 'tool_a');
      const sagaId = bridge.recordActionSaga(action, {
        runId: 'unknown-run',
        leaseToken: 'any',
        fencingEpoch: 1,
      });
      assert.strictEqual(sagaId, null);
    });
  });

  describe('compensateViaLedger (real saga)', () => {
    it('compensates actions in REVERSE execution order', async () => {
      const bridge = new CompensationBridge();
      const bundle = getRunLedgerBundle();
      const { tx } = bundle.ledger.start({ runId: 'r', intentHash: 'h', ttlSeconds: 60, holder: 't' });

      const order: string[] = [];
      bridge.register('step', async (a) => {
        order.push(a.actionId);
        return { success: true };
      });

      bridge.recordActionSaga(makeAction('a1', 'step'), { runId: 'r', leaseToken: tx.leaseToken, fencingEpoch: tx.fencingEpoch });
      await new Promise(r => setTimeout(r, 5));
      bridge.recordActionSaga(makeAction('a2', 'step'), { runId: 'r', leaseToken: tx.leaseToken, fencingEpoch: tx.fencingEpoch });
      await new Promise(r => setTimeout(r, 5));
      bridge.recordActionSaga(makeAction('a3', 'step'), { runId: 'r', leaseToken: tx.leaseToken, fencingEpoch: tx.fencingEpoch });

      const res = await bridge.compensateViaLedger('r', tx.leaseToken, tx.fencingEpoch, 'fail');
      assert.strictEqual(res.outcome.succeeded, 3);
      assert.deepStrictEqual(order, ['a3', 'a2', 'a1'], 'saga rolls back in REVERSE order');
    });

    it('is idempotent: re-running compensateViaLedger skips already-compensated', async () => {
      const bridge = new CompensationBridge();
      const bundle = getRunLedgerBundle();
      const { tx } = bundle.ledger.start({ runId: 'r', intentHash: 'h', ttlSeconds: 60, holder: 't' });

      let handlerCalls = 0;
      bridge.register('tool', async () => {
        handlerCalls++;
        return { success: true };
      });

      bridge.recordActionSaga(makeAction('a1', 'tool'), { runId: 'r', leaseToken: tx.leaseToken, fencingEpoch: tx.fencingEpoch });

      const r1 = await bridge.compensateViaLedger('r', tx.leaseToken, tx.fencingEpoch, 'fail');
      const r2 = await bridge.compensateViaLedger('r', tx.leaseToken, tx.fencingEpoch, 'fail');

      assert.strictEqual(r1.outcome.succeeded, 1);
      assert.strictEqual(r2.outcome.succeeded, 0, 'second run is a no-op');
      assert.strictEqual(handlerCalls, 1, 'handler called exactly once across two compensations');
    });

    it('retries failed handler up to maxAttempts then reports in outcome', async () => {
      const bridge = new CompensationBridge();
      const bundle = getRunLedgerBundle();
      const { tx } = bundle.ledger.start({ runId: 'r', intentHash: 'h', ttlSeconds: 60, holder: 't' });

      let attempts = 0;
      bridge.register('flaky', async () => {
        attempts++;
        return { success: false, error: `attempt-${attempts}` };
      });

      bridge.recordActionSaga(makeAction('a1', 'flaky'), { runId: 'r', leaseToken: tx.leaseToken, fencingEpoch: tx.fencingEpoch });

      const res = await bridge.compensateViaLedger('r', tx.leaseToken, tx.fencingEpoch, 'fail', { maxAttempts: 3 });
      assert.strictEqual(res.outcome.attempted, 1);
      assert.strictEqual(res.outcome.succeeded, 0);
      assert.strictEqual(res.outcome.failed, 1);
      assert.strictEqual(attempts, 3, 'handler retried exactly maxAttempts times');
    });

    it('rejects compensation when caller is fenced', async () => {
      const bridge = new CompensationBridge();
      const bundle = getRunLedgerBundle();
      const { tx } = bundle.ledger.start({ runId: 'r', intentHash: 'h', ttlSeconds: 60, holder: 't' });

      bridge.register('tool', async () => ({ success: true }));
      bridge.recordActionSaga(makeAction('a1', 'tool'), { runId: 'r', leaseToken: tx.leaseToken, fencingEpoch: tx.fencingEpoch });

      const res = await bridge.compensateViaLedger('r', 'fake-token', 999, 'fail');
      assert.strictEqual(res.aborted, false, 'fenced caller cannot abort');
      assert.strictEqual(res.outcome.attempted, 0);
    });
  });

  describe('legacy passthrough', () => {
    it('recordAction (legacy-only) goes to legacy map but NOT ledger', () => {
      const bridge = new CompensationBridge();
      const bundle = getRunLedgerBundle();
      const { tx } = bundle.ledger.start({ runId: 'r', intentHash: 'h', ttlSeconds: 60, holder: 't' });

      bridge.recordAction(makeAction('leg-1', 'tool_a'));

      assert.strictEqual(bridge.getPendingCount(), 1);
      const ledgerTx = bundle.ledger.getTransaction('r')!;
      assert.strictEqual(ledgerTx.actions.length, 0, 'legacy-only path skips ledger');
    });

    it('compensate() in legacy registry works without ledger involvement', async () => {
      const bridge = new CompensationBridge();
      const called: string[] = [];
      bridge.register('tool', async (a) => {
        called.push(a.actionId);
        return { success: true };
      });
      bridge.recordAction(makeAction('leg-1', 'tool'));

      const res = await bridge.compensate('leg-1');
      assert.strictEqual(res.success, true);
      assert.deepStrictEqual(called, ['leg-1']);
      assert.strictEqual(bridge.getPendingCount(), 0);
    });

    it('clear() empties legacy only', () => {
      const bridge = new CompensationBridge();
      bridge.recordAction(makeAction('a', 't'));
      assert.strictEqual(bridge.getPendingCount(), 1);
      bridge.clear();
      assert.strictEqual(bridge.getPendingCount(), 0);
    });
  });

  describe('global singleton', () => {
    it('getCompensationBridge returns same instance until reset', () => {
      const a = getCompensationBridge();
      const b = getCompensationBridge();
      assert.strictEqual(a, b);
      resetCompensationBridge();
      const c = getCompensationBridge();
      assert.notStrictEqual(a, c);
    });
  });
});
