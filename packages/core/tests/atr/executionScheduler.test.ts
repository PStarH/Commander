import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExecutionScheduler } from '../../src/atr/scheduler';
import { RunLedger, getRunLedgerBundle, resetRunLedgerBundle } from '../../src/atr/runLedger';
import { LeaseManager } from '../../src/atr/leaseManager';
import { IdempotencyStore, resetIdempotencyStore } from '../../src/atr/idempotencyStore';
import { StateCheckpointer } from '../../src/runtime/stateCheckpointer';
import { hashIntent } from '../../src/atr/canonicalJson';

function makeBundle() {
  process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
  resetIdempotencyStore();
  resetRunLedgerBundle();
  const lm = new LeaseManager({
    filePath: ':memory:',
    defaultTtlSeconds: 60,
    defaultHolder: 'test',
  });
  const idem = new IdempotencyStore({ filePath: ':memory:', defaultTtlSeconds: 60 });
  const ledger = new RunLedger(lm, idem, {
    filePath: ':memory:',
    defaultTtlSeconds: 60,
    defaultHolder: 'test',
  });
  return { lm, idem, ledger };
}

function makeScheduler(opts?: { checkpointer?: StateCheckpointer; tenantId?: string }): {
  scheduler: ExecutionScheduler;
  bundle: ReturnType<typeof makeBundle>;
  close: () => void;
} {
  const bundle = makeBundle();
  const scheduler = new ExecutionScheduler({
    lease: bundle.lm,
    idempotency: bundle.idem,
    ledger: bundle.ledger,
    checkpointer: opts?.checkpointer,
  });
  return {
    scheduler,
    bundle,
    close: () => {
      bundle.lm.close();
      bundle.idem.close();
      bundle.ledger.close();
    },
  };
}

describe('ExecutionScheduler', () => {
  beforeEach(() => {
    process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
    resetIdempotencyStore();
    resetRunLedgerBundle();
  });

  afterEach(() => {
    resetIdempotencyStore();
    resetRunLedgerBundle();
    delete process.env.COMMANDER_ATR_IDEMPOTENCY_PATH;
  });

  describe('beginRun', () => {
    it('creates an EXECUTING run with valid lease', () => {
      const { scheduler, bundle, close } = makeScheduler();
      try {
        const handle = scheduler.beginRun({ runId: 'r-1', goal: 'fix bug' });
        assert.strictEqual(handle.state, 'EXECUTING');
        assert.ok(handle.leaseToken);
        assert.strictEqual(handle.fencingEpoch, 1);
        assert.strictEqual(handle.resumed, false);
        assert.strictEqual(handle.intentHash, hashIntent('fix bug'));

        const tx = bundle.ledger.getTransaction('r-1')!;
        assert.strictEqual(tx.state, 'EXECUTING');
        assert.strictEqual(tx.leaseToken, handle.leaseToken);
      } finally {
        close();
      }
    });

    it('is idempotent: second beginRun with same runId returns resumed=true', () => {
      const { scheduler, close } = makeScheduler();
      try {
        const h1 = scheduler.beginRun({ runId: 'r-2', goal: 'g' });
        const h2 = scheduler.beginRun({ runId: 'r-2', goal: 'g' });
        assert.strictEqual(h2.resumed, true);
        assert.strictEqual(h2.leaseToken, h1.leaseToken, 'same lease on idempotent begin');
      } finally {
        close();
      }
    });
  });

  describe('scheduleAction', () => {
    it('records action and returns actionId', () => {
      const { scheduler, bundle, close } = makeScheduler();
      try {
        const h = scheduler.beginRun({ runId: 'r-3', goal: 'g' });
        const res = scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 'github_create_pr',
          externalSystem: 'github',
          args: { title: 'x' },
          idempotencyKey: 'k1',
          compensable: true,
        });
        assert.ok(res);
        assert.strictEqual(res.replayed, false);
        assert.ok(res.actionId);

        const tx = bundle.ledger.getTransaction('r-3')!;
        assert.strictEqual(tx.actions.length, 1);
        assert.strictEqual(tx.actions[0].toolName, 'github_create_pr');
      } finally {
        close();
      }
    });

    it('returns cached result when idempotency key already completed (replay)', () => {
      const { scheduler, close } = makeScheduler();
      try {
        const h = scheduler.beginRun({ runId: 'r-4', goal: 'g' });
        const a = scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 't',
          externalSystem: 's',
          args: {},
          idempotencyKey: 'k1',
          compensable: true,
        });
        assert.ok(a);
        scheduler.recordResult({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          actionId: a.actionId,
          result: 'cached-output',
        });

        const replay = scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 't',
          externalSystem: 's',
          args: {},
          idempotencyKey: 'k1',
          compensable: true,
        });
        assert.ok(replay);
        assert.strictEqual(replay.replayed, true);
        assert.strictEqual(replay.cachedResult, 'cached-output');
      } finally {
        close();
      }
    });

    it('returns null when lease is stale (fenced)', () => {
      const { scheduler, close } = makeScheduler();
      try {
        const h = scheduler.beginRun({ runId: 'r-5', goal: 'g' });
        const res = scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: 'fake',
          fencingEpoch: 999,
          toolName: 't',
          externalSystem: 's',
          args: {},
          idempotencyKey: 'k',
          compensable: true,
        });
        assert.strictEqual(res, null);
      } finally {
        close();
      }
    });
  });

  describe('recordResult / recordError', () => {
    it('recordResult persists result and updates idempotency cache', () => {
      const { scheduler, bundle, close } = makeScheduler();
      try {
        const h = scheduler.beginRun({ runId: 'r-6', goal: 'g' });
        const a = scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 't',
          externalSystem: 's',
          args: {},
          idempotencyKey: 'k1',
          compensable: true,
        });
        scheduler.recordResult({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          actionId: a.actionId,
          result: 'ok',
        });
        const tx = bundle.ledger.getTransaction('r-6')!;
        assert.strictEqual(tx.actions[0].result, 'ok');
      } finally {
        close();
      }
    });

    it('recordError persists error to action and idempotency', () => {
      const { scheduler, bundle, close } = makeScheduler();
      try {
        const h = scheduler.beginRun({ runId: 'r-7', goal: 'g' });
        const a = scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 't',
          externalSystem: 's',
          args: {},
          idempotencyKey: 'k1',
          compensable: true,
        });
        scheduler.recordError({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          actionId: a.actionId,
          error: 'flaky',
        });
        const tx = bundle.ledger.getTransaction('r-7')!;
        assert.strictEqual(tx.actions[0].error, 'flaky');
      } finally {
        close();
      }
    });
  });

  describe('commitRun', () => {
    it('transitions to COMMITTED and releases lease', () => {
      const { scheduler, bundle, close } = makeScheduler();
      try {
        const h = scheduler.beginRun({ runId: 'r-8', goal: 'g' });
        const res = scheduler.commitRun({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
        });
        assert.strictEqual(res.committed, true);
        const tx = bundle.ledger.getTransaction('r-8')!;
        assert.strictEqual(tx.state, 'COMMITTED');
        const lease = bundle.lm.get('r-8');
        assert.strictEqual(lease, null, 'lease released after commit');
      } finally {
        close();
      }
    });

    it('returns committed=false, reason=fenced on stale lease', () => {
      const { scheduler, close } = makeScheduler();
      try {
        scheduler.beginRun({ runId: 'r-9', goal: 'g' });
        const res = scheduler.commitRun({ runId: 'r-9', leaseToken: 'fake', fencingEpoch: 999 });
        assert.strictEqual(res.committed, false);
        assert.strictEqual(res.reason, 'fenced');
      } finally {
        close();
      }
    });

    it('returns committed=false, reason=not_found on unknown run', () => {
      const { scheduler, close } = makeScheduler();
      try {
        const res = scheduler.commitRun({ runId: 'missing', leaseToken: 'x', fencingEpoch: 1 });
        assert.strictEqual(res.committed, false);
        assert.strictEqual(res.reason, 'not_found');
      } finally {
        close();
      }
    });
  });

  describe('abortRun', () => {
    it('triggers saga compensation, transitions to ABORTED', async () => {
      const { scheduler, bundle, close } = makeScheduler();
      try {
        const calls: string[] = [];
        scheduler.registerCompensation('github_create_pr', async (a) => {
          calls.push(a.actionId);
          return { success: true };
        });
        const h = scheduler.beginRun({ runId: 'r-10', goal: 'g' });
        const a = scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 'github_create_pr',
          externalSystem: 'github',
          args: {},
          idempotencyKey: 'k',
          compensable: true,
        });
        scheduler.recordResult({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          actionId: a.actionId,
          result: 'pr-1',
        });

        const res = await scheduler.abortRun({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          reason: 'user cancel',
        });
        assert.strictEqual(res.aborted, true);
        assert.strictEqual(res.outcome.succeeded, 1);
        assert.deepStrictEqual(calls, [a.actionId]);
        const tx = bundle.ledger.getTransaction('r-10')!;
        assert.strictEqual(tx.state, 'COMPENSATED');
      } finally {
        close();
      }
    });

    it('is idempotent: re-running abortRun is a no-op', async () => {
      const { scheduler, close } = makeScheduler();
      try {
        const calls: string[] = [];
        scheduler.registerCompensation('t', async (a) => {
          calls.push(a.actionId);
          return { success: true };
        });
        const h = scheduler.beginRun({ runId: 'r-11', goal: 'g' });
        const a = scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 't',
          externalSystem: 's',
          args: {},
          idempotencyKey: 'k',
          compensable: true,
        });
        scheduler.recordResult({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          actionId: a.actionId,
          result: 'r',
        });

        await scheduler.abortRun({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          reason: 'x',
        });
        const res2 = await scheduler.abortRun({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          reason: 'x',
        });
        assert.strictEqual(res2.outcome.succeeded, 0, 'second run is a no-op');
        assert.strictEqual(calls.length, 1);
      } finally {
        close();
      }
    });

    it('returns aborted=false, reason=fenced on stale lease', async () => {
      const { scheduler, close } = makeScheduler();
      try {
        scheduler.beginRun({ runId: 'r-12', goal: 'g' });
        const res = await scheduler.abortRun({
          runId: 'r-12',
          leaseToken: 'fake',
          fencingEpoch: 999,
          reason: 'x',
        });
        assert.strictEqual(res.aborted, false);
        assert.strictEqual(res.reason, 'fenced');
      } finally {
        close();
      }
    });
  });

  describe('resumeRun', () => {
    it('returns handle for existing run with resumed=true', () => {
      const { scheduler, close } = makeScheduler();
      try {
        const h = scheduler.beginRun({ runId: 'r-13', goal: 'g', metadata: { foo: 'bar' } });
        const r = scheduler.resumeRun({ runId: 'r-13' });
        assert.ok(r);
        assert.strictEqual(r.resumed, true);
        assert.strictEqual(r.leaseToken, h.leaseToken);
        assert.deepStrictEqual(r.metadata, { foo: 'bar' });
      } finally {
        close();
      }
    });

    it('returns null for unknown run', () => {
      const { scheduler, close } = makeScheduler();
      try {
        assert.strictEqual(scheduler.resumeRun({ runId: 'missing' }), null);
      } finally {
        close();
      }
    });
  });

  describe('killRun', () => {
    it('releases lease without triggering compensation', async () => {
      const { scheduler, bundle, close } = makeScheduler();
      try {
        let handlerCalled = false;
        scheduler.registerCompensation('t', async () => {
          handlerCalled = true;
          return { success: true };
        });
        const h = scheduler.beginRun({ runId: 'r-14', goal: 'g' });
        scheduler.scheduleAction({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          toolName: 't',
          externalSystem: 's',
          args: {},
          idempotencyKey: 'k',
          compensable: true,
        });

        const res = scheduler.killRun({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
        });
        assert.strictEqual(res.killed, true);
        assert.strictEqual(handlerCalled, false, 'kill skips compensation');
        assert.strictEqual(bundle.lm.get('r-14'), null);
      } finally {
        close();
      }
    });

    it('returns killed=false, reason=fenced on stale lease', () => {
      const { scheduler, close } = makeScheduler();
      try {
        scheduler.beginRun({ runId: 'r-15', goal: 'g' });
        const res = scheduler.killRun({ runId: 'r-15', leaseToken: 'fake', fencingEpoch: 999 });
        assert.strictEqual(res.killed, false);
        assert.strictEqual(res.reason, 'fenced');
      } finally {
        close();
      }
    });
  });

  describe('heartbeat', () => {
    it('refreshes lease expiry', () => {
      const { scheduler, bundle, close } = makeScheduler();
      try {
        const h = scheduler.beginRun({ runId: 'r-16', goal: 'g' });
        const ok = scheduler.heartbeat({ runId: h.runId, leaseToken: h.leaseToken });
        assert.strictEqual(ok, true);
      } finally {
        close();
      }
    });
  });

  describe('checkpoint', () => {
    it('writes state to disk and survives resume', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-sched-cp-'));
      try {
        const { scheduler, close } = makeScheduler({
          checkpointer: new StateCheckpointer(tmp),
        });
        try {
          const h = scheduler.beginRun({ runId: 'r-17', goal: 'g' });
          scheduler.checkpoint({
            state: {
              runId: h.runId,
              agentId: 'a',
              timestamp: new Date().toISOString(),
              phase: 'tool_execution',
              stepNumber: 3,
              attemptNumber: 1,
              messages: [],
              tokenUsage: { input: 0, output: 0, total: 0 },
              stepDurations: [],
              context: {
                agentId: 'a',
                projectId: 'p',
                goal: 'g',
                availableTools: [],
                maxSteps: 10,
                tokenBudget: 1000,
              },
              totalDurationMs: 0,
              leaseToken: h.leaseToken,
              fencingEpoch: h.fencingEpoch,
            },
          });

          const cp = new StateCheckpointer(tmp);
          const restored = cp.resume('r-17');
          assert.ok(restored);
          assert.strictEqual(restored.leaseToken, h.leaseToken);
          assert.strictEqual(restored.fencingEpoch, h.fencingEpoch);
        } finally {
          close();
        }
      } finally {
        try {
          fs.rmSync(tmp, { recursive: true, force: true });
        } catch {}
      }
    });
  });

  describe('listRuns', () => {
    it('returns all states when no filter', () => {
      const { scheduler, close } = makeScheduler();
      try {
        scheduler.beginRun({ runId: 'r-18', goal: 'g' });
        scheduler.beginRun({ runId: 'r-19', goal: 'g' });
        const all = scheduler.listRuns();
        assert.ok(all.some((tx) => tx.runId === 'r-18'));
        assert.ok(all.some((tx) => tx.runId === 'r-19'));
      } finally {
        close();
      }
    });

    it('filters by state', () => {
      const { scheduler, close } = makeScheduler();
      try {
        const h = scheduler.beginRun({ runId: 'r-20', goal: 'g' });
        scheduler.commitRun({
          runId: h.runId,
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
        });
        const committed = scheduler.listRuns({ state: 'COMMITTED' });
        assert.ok(committed.some((tx) => tx.runId === 'r-20'));
      } finally {
        close();
      }
    });
  });

  describe('tenant isolation', () => {
    it('tenant A cannot commit into tenant B run', () => {
      const lm = new LeaseManager({
        filePath: ':memory:',
        defaultTtlSeconds: 60,
        defaultHolder: 't',
      });
      const idem = new IdempotencyStore({ filePath: ':memory:', defaultTtlSeconds: 60 });
      const ledger = new RunLedger(lm, idem, {
        filePath: ':memory:',
        defaultTtlSeconds: 60,
        defaultHolder: 't',
      });
      const scheduler = new ExecutionScheduler({ lease: lm, idempotency: idem, ledger });
      try {
        const h = scheduler.beginRun({ runId: 'r-x', goal: 'g', tenantId: 'tenant-a' });

        const wrongTenant = scheduler.commitRun({
          runId: 'r-x',
          leaseToken: h.leaseToken,
          fencingEpoch: h.fencingEpoch,
          tenantId: 'tenant-b',
        });
        assert.strictEqual(wrongTenant.committed, false);
      } finally {
        lm.close();
        idem.close();
        ledger.close();
      }
    });
  });
});
