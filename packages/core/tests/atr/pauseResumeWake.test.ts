/**
 * Architecture V2 — durable pause / wake / HITL lifecycle.
 * RunLedger is the sole source of truth for PAUSED + resume_at.
 *
 * NOTE: This test suite requires the native `better-sqlite3` binding to be
 * available for the current Node ABI. Clean/frozen lockfile installs may not
 * include a prebuilt binary, so the suite detects availability and skips
 * gracefully rather than failing the architecture gate.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

// A per-module require. The global `require` does not exist in an ES module, so
// every call below used to raise `ReferenceError: require is not defined` —
// which the availability probe swallowed as "better-sqlite3 is missing", so the
// whole suite skipped itself and the dynamic-require strategy never ran at all.
const nodeRequire = createRequire(import.meta.url);

// Detect whether better-sqlite3 native bindings are actually usable for the
// current Node ABI. The JS wrapper may load even when the compiled .node file
// is for a different Node version, so we perform a real in-memory open.
let betterSqlite3Available = false;
try {
  const Database = nodeRequire('better-sqlite3');
  const db = new Database(':memory:');
  db.prepare('SELECT 1').get();
  db.close();
  betterSqlite3Available = true;
} catch {
  betterSqlite3Available = false;
}

describe('ATR pause / wake (Architecture V2)', { skip: !betterSqlite3Available }, () => {
  if (!betterSqlite3Available) {
    it('skipped: better-sqlite3 native binding unavailable', () => {
      assert.ok(true, 'Native binding unavailable; suite skipped for reproducible builds.');
    });
    return;
  }

  // A call-time require keeps the eager `better-sqlite3` imports from being
  // loaded when the native binding is absent. `createRequire` is not hoisted,
  // so nothing is resolved until these lines execute — and the specifiers
  // resolve against THIS file, which is what makes the relative paths correct.
  const { RunLedger } = nodeRequire(
    '../../src/atr/runLedger',
  ) as typeof import('../../src/atr/runLedger');
  const { LeaseManager } = nodeRequire(
    '../../src/atr/leaseManager',
  ) as typeof import('../../src/atr/leaseManager');
  const { IdempotencyStore } = nodeRequire(
    '../../src/atr/idempotencyStore',
  ) as typeof import('../../src/atr/idempotencyStore');
  const { ExecutionScheduler } = nodeRequire(
    '../../src/atr/scheduler',
  ) as typeof import('../../src/atr/scheduler');

  function newBundle() {
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
    const ledger = new RunLedger(lease, idempotency, {
      filePath: ':memory:',
      defaultTtlSeconds: 60,
      defaultHolder: 'test',
      defaultIdempotencyTtlSeconds: 60,
    });
    const scheduler = new ExecutionScheduler({ lease, idempotency, ledger });
    return { lease, idempotency, ledger, scheduler };
  }

  it('pauseRun persists PAUSED with optional resume_at', () => {
    const { scheduler } = newBundle();
    const handle = scheduler.beginRun({ runId: 'run-pause-1', goal: 'test' });
    const resumeAt = new Date(Date.now() + 60_000).toISOString();
    const result = scheduler.pauseRun({
      runId: handle.runId,
      leaseToken: handle.leaseToken,
      fencingEpoch: handle.fencingEpoch,
      resumeAt,
      reason: 'human_input_required',
    });
    assert.strictEqual(result.paused, true);
    const tx = scheduler.getRun({ runId: handle.runId });
    assert.ok(tx);
    assert.strictEqual(tx!.state, 'PAUSED');
    assert.strictEqual(tx!.resumeAt, resumeAt);
    assert.strictEqual(tx!.pauseReason, 'human_input_required');
  });

  it('claimRunnableRun wakes PAUSED runs whose resume_at has elapsed', () => {
    const { scheduler } = newBundle();
    const handle = scheduler.beginRun({ runId: 'run-wake-1', goal: 'wake me' });
    const past = new Date(Date.now() - 1_000).toISOString();
    scheduler.scheduleResume({
      runId: handle.runId,
      leaseToken: handle.leaseToken,
      fencingEpoch: handle.fencingEpoch,
      resumeAt: past,
      reason: 'timer',
    });
    const claimed = scheduler.claimRunnableRun();
    assert.ok(claimed);
    assert.strictEqual(claimed!.runId, handle.runId);
    assert.strictEqual(claimed!.state, 'EXECUTING');
    assert.strictEqual(claimed!.resumed, true);
  });

  it('claimRunnableRun ignores future resume_at', () => {
    const { scheduler } = newBundle();
    const handle = scheduler.beginRun({ runId: 'run-future-1', goal: 'later' });
    const future = new Date(Date.now() + 3600_000).toISOString();
    scheduler.pauseRun({
      runId: handle.runId,
      leaseToken: handle.leaseToken,
      fencingEpoch: handle.fencingEpoch,
      resumeAt: future,
      reason: 'timer',
    });
    const claimed = scheduler.claimRunnableRun();
    assert.strictEqual(claimed, null);
  });

  it('HITL pause without resume_at is not auto-claimed', () => {
    const { scheduler } = newBundle();
    const handle = scheduler.beginRun({ runId: 'run-hitl-1', goal: 'need human' });
    scheduler.pauseRun({
      runId: handle.runId,
      leaseToken: handle.leaseToken,
      fencingEpoch: handle.fencingEpoch,
      resumeAt: null,
      reason: 'human_input_required',
    });
    assert.strictEqual(scheduler.claimRunnableRun(), null);
    const tx = scheduler.getRun({ runId: handle.runId });
    assert.strictEqual(tx!.state, 'PAUSED');
  });

  // ── AS-04: exclusive wake, expiry, terminal read-only ────────────────────

  it('claimRunnableRun has exactly one winner', () => {
    const { scheduler, ledger } = newBundle();
    const handle = scheduler.beginRun({ runId: 'run-wake-excl', goal: 'g' });
    scheduler.scheduleResume({
      runId: handle.runId,
      leaseToken: handle.leaseToken,
      fencingEpoch: handle.fencingEpoch,
      resumeAt: new Date(Date.now() - 1000).toISOString(),
    });
    const first = scheduler.claimRunnableRun();
    assert.strictEqual(first!.runId, 'run-wake-excl');
    assert.strictEqual(scheduler.claimRunnableRun(), null);
    // The same credentials cannot re-run the PAUSED → EXECUTING conditional update.
    assert.strictEqual(
      ledger.beginExecuting('run-wake-excl', handle.leaseToken, handle.fencingEpoch, {
        from: ['PAUSED'],
      }),
      false,
    );
  });

  it('refuses writes once the lease has expired', () => {
    const { scheduler, ledger, lease } = newBundle();
    const handle = scheduler.beginRun({ runId: 'run-expiry-1', goal: 'g' });
    assert.strictEqual(lease.heartbeat(handle.runId, handle.leaseToken, { ttlSeconds: -1 }), true);
    const live = lease.get(handle.runId);
    assert.ok(live);
    assert.strictEqual(
      ledger.syncLeaseCredentials(handle.runId, live!.token, live!.fencingEpoch, {
        expiresAt: live!.expiresAt,
      }),
      true,
    );

    assert.strictEqual(
      scheduler.scheduleAction({
        runId: handle.runId,
        leaseToken: handle.leaseToken,
        fencingEpoch: handle.fencingEpoch,
        toolName: 't',
        externalSystem: 's',
        args: {},
        idempotencyKey: 'k-expired',
        compensable: true,
      }),
      null,
    );
    assert.strictEqual(
      scheduler.pauseRun({
        runId: handle.runId,
        leaseToken: handle.leaseToken,
        fencingEpoch: handle.fencingEpoch,
      }).paused,
      false,
    );
    assert.strictEqual(scheduler.resumeRun({ runId: handle.runId }), null);
  });

  it('a committed run cannot begin again', () => {
    const { scheduler } = newBundle();
    const handle = scheduler.beginRun({ runId: 'run-terminal-1', goal: 'g' });
    assert.strictEqual(
      scheduler.commitRun({
        runId: handle.runId,
        leaseToken: handle.leaseToken,
        fencingEpoch: handle.fencingEpoch,
      }).committed,
      true,
    );
    assert.throws(() => scheduler.beginRun({ runId: 'run-terminal-1', goal: 'g' }), /terminal/);
  });
});
