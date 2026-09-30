/**
 * RecoveryBootstrapper — Zombie run recovery on process startup.
 *
 * Scans the RunLedger at boot for runs left in EXECUTING, VERIFYING, or PAUSED
 * states by a previously crashed or killed process. For each zombie run:
 *
 *   1. Cross-checks the lease expiration via LeaseManager
 *   2. Acquires the lease (bumps fencing epoch, fencing any surviving zombie)
 *   3. Holds and renews that lease until compensation settles
 *   4. Decides the recovery action:
 *      - EXECUTING / VERIFYING → abortRun + compensate (safe default) and the
 *        result is recorded from the REAL return value
 *      - PAUSED → prepared for manual resume; an actual resume requires
 *        separate confirmation (`confirmResume`)
 *      - No lease at all → an explicit manual-recovery record, never ignored
 *   5. Records a DeadLetterQueue entry for each recovered run
 *   6. Publishes recovery events to the MessageBus
 *
 * Bootstrap is asynchronous and MUST be awaited by every start-up call site:
 * it does not report success until compensation has settled. Per-run failures
 * are isolated and reported; a failure of the scan itself is not swallowed.
 *
 * Recovery never uses a released token and never reuses the global scheduler
 * when a caller injected its own ledger/lease — it builds (or accepts) a
 * scheduler over the same bundle.
 */
import { getGlobalLogger } from '../logging';
import { LeaseManager } from './leaseManager';
import { RunLedger, getRunLedgerBundle } from './runLedger';
import { ExecutionScheduler } from './scheduler';
import { IdempotencyStore } from './idempotencyStore';
import { getDeadLetterQueue } from '../runtime/deadLetterQueueSingleton';
import { getMessageBus } from '../runtime/messageBus';
import { StateCheckpointer } from '../runtime/stateCheckpointer';
import { getGlobalDeterminismCapture } from '../runtime/determinismCapture';
import { reportSilentFailure } from '../silentFailureReporter';
import type { RunState } from './types';

export interface RecoveryBootstrapperOptions {
  /** LeaseManager instance. Defaults to the global bundle's lease. */
  leaseManager?: LeaseManager;
  /** RunLedger instance. Defaults to the global bundle's ledger. */
  ledger?: RunLedger;
  /** IdempotencyStore matching the ledger. Defaults to the global bundle's. */
  idempotency?: IdempotencyStore;
  /**
   * Scheduler constructed over the SAME bundle. When omitted one is built from
   * leaseManager + idempotency + ledger (never the unrelated global singleton).
   */
  scheduler?: ExecutionScheduler;
  /** If true, runs are aborted+compensated instead of resumed (safe for CI). */
  forceAbort?: boolean;
  /** Holder label for reclaimed leases. */
  holder?: string;
  /**
   * Separate, explicit confirmation required before a PAUSED run is actually
   * resumed. Without it a PAUSED run is only reported as `prepared`.
   */
  confirmResume?: boolean;
  /** Lease TTL (seconds) held and renewed until compensation settles. */
  leaseTtlSeconds?: number;
}

export interface RecoveryResult {
  scanned: number;
  /** Runs whose recovery reached a settled outcome (aborted+compensated, or resumed). */
  recovered: number;
  /** Runs whose abortRun really returned aborted=true. */
  aborted: number;
  /** Runs whose compensation completed with zero failures. */
  compensated: number;
  /** PAUSED runs readied for a human/operator resume. */
  prepared: number;
  /** Non-terminal runs with no lease, recorded for explicit manual recovery. */
  manualRecovery: number;
  /** Runs whose recovery attempt failed or was refused. */
  failed: number;
  skipped: number;
  details: RecoveryDetail[];
}

export interface RecoveryDetail {
  runId: string;
  tenantId?: string;
  state: RunState;
  action:
    | 'resumed'
    | 'aborted'
    | 'prepared'
    | 'skipped'
    | 'fenced_already'
    | 'manual_recovery'
    | 'failed';
  reason: string;
  /** Which recovery strategy was selected by RunRecovery (if attempted). */
  recoveryStrategy?: 'replay' | 'checkpoint' | 'none';
}

const ZOMBIE_STATES: RunState[] = ['EXECUTING', 'VERIFYING', 'PAUSED'];

interface RecoveryContext {
  leaseManager: LeaseManager;
  ledger: RunLedger;
  scheduler: ExecutionScheduler;
  holder: string;
  leaseTtlSeconds: number;
  forceAbort: boolean;
  confirmResume: boolean;
  result: RecoveryResult;
}

export class RecoveryBootstrapper {
  /**
   * Run the one-time bootstrap scan. Returns a summary of what was recovered.
   * Await this once at process startup, after the crash handlers are installed.
   */
  static async bootstrap(options?: RecoveryBootstrapperOptions): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      scanned: 0,
      recovered: 0,
      aborted: 0,
      compensated: 0,
      prepared: 0,
      manualRecovery: 0,
      failed: 0,
      skipped: 0,
      details: [],
    };

    const bundle = getRunLedgerBundle();
    const leaseManager = options?.leaseManager ?? bundle.lease;
    const ledger = options?.ledger ?? bundle.ledger;
    const idempotency = options?.idempotency ?? bundle.idempotency;

    // Build a scheduler over the SAME bundle unless the caller supplied one.
    // The global scheduler is not used here: a caller that injected its own
    // ledger/lease must not have its runs touched by a different authority.
    let scheduler = options?.scheduler;
    if (!scheduler) {
      scheduler = new ExecutionScheduler({ lease: leaseManager, idempotency, ledger });
      scheduler.registerDefaultCompensations();
    }

    const ctx: RecoveryContext = {
      leaseManager,
      ledger,
      scheduler,
      holder: options?.holder ?? `recovery-${process.pid}`,
      leaseTtlSeconds: options?.leaseTtlSeconds ?? 30,
      forceAbort: options?.forceAbort ?? false,
      confirmResume: options?.confirmResume ?? false,
      result,
    };

    const dlq = getDeadLetterQueue();
    const bus = getMessageBus();

    try {
      for (const state of ZOMBIE_STATES) {
        const runs = ledger.listByState(state);

        for (const run of runs) {
          result.scanned++;
          try {
            await RecoveryBootstrapper.recoverRun(ctx, dlq, run);
          } catch (err) {
            // Per-run isolation: one broken run must not abort the scan.
            result.failed++;
            result.details.push({
              runId: run.runId,
              tenantId: run.tenantId,
              state: run.state,
              action: 'failed',
              reason: `Recovery failed: ${(err as Error)?.message ?? 'unknown'}`,
            });
            getGlobalLogger().error(
              'RecoveryBootstrapper',
              `Recovery failed for run ${run.runId}`,
              err as Error,
            );
          }
        }
      }

      // Publish summary to the message bus for operators/alerting
      if (result.scanned > 0) {
        bus.publish('recovery.completed', 'recovery-bootstrapper', {
          scanned: result.scanned,
          recovered: result.recovered,
          aborted: result.aborted,
          compensated: result.compensated,
          prepared: result.prepared,
          manualRecovery: result.manualRecovery,
          failed: result.failed,
          skipped: result.skipped,
          details: result.details,
        });
      }
    } catch (err) {
      // Do NOT swallow: a failed scan is not a successful recovery, and
      // startup must see the failure.
      getGlobalLogger().error('RecoveryBootstrapper', 'Bootstrap scan failed', err as Error);
      throw err;
    }

    getGlobalLogger().info('RecoveryBootstrapper', 'Bootstrap complete', {
      scanned: result.scanned,
      recovered: result.recovered,
      aborted: result.aborted,
      compensated: result.compensated,
      prepared: result.prepared,
      manualRecovery: result.manualRecovery,
      failed: result.failed,
      skipped: result.skipped,
    });

    return result;
  }

  private static async recoverRun(
    ctx: RecoveryContext,
    dlq: ReturnType<typeof getDeadLetterQueue>,
    run: { runId: string; tenantId?: string; state: RunState },
  ): Promise<void> {
    const { leaseManager, ledger, scheduler, result } = ctx;
    const runId = run.runId;
    const tenantId = run.tenantId;
    const state = run.state;

    // Step 1: Check if the lease is still alive
    const currentLease = leaseManager.get(runId, { tenantId });
    if (!currentLease) {
      // No lease at all — this is not "cleaned up", it is an unattended
      // non-terminal run. Record it explicitly for manual recovery instead of
      // ignoring it indefinitely.
      result.manualRecovery++;
      result.details.push({
        runId,
        tenantId,
        state,
        action: 'manual_recovery',
        reason: 'No lease found for a non-terminal run — explicit manual recovery required',
      });
      dlq.record({
        id: `recovery-${runId}-${Date.now()}`,
        category: 'execution',
        runId,
        agentId: 'recovery-bootstrapper',
        timestamp: new Date().toISOString(),
        errorClass: 'permanent',
        errorMessage: `RecoveryBootstrapper: non-terminal run ${runId} (state=${state}) has no lease — manual recovery required`,
        retryable: false,
        attemptNumber: 0,
        operationName: 'recovery.manual',
        compensated: false,
        recovered: false,
        tags: ['recovery', 'zombie', state, 'manual_recovery'],
      });
      return;
    }

    // Lease is still valid — someone else holds it (likely another process)
    const isExpired = new Date(currentLease.expiresAt).getTime() <= Date.now();
    if (!isExpired) {
      result.skipped++;
      result.details.push({
        runId,
        tenantId,
        state,
        action: 'skipped',
        reason: `Lease still valid (holder=${currentLease.holder}, expires=${currentLease.expiresAt})`,
      });
      return;
    }

    // Step 2: Acquire the expired lease — this bumps the fencing epoch and
    // fences any zombie process that might still be alive.
    const acquireResult = leaseManager.acquire(runId, {
      tenantId,
      holder: ctx.holder,
      ttlSeconds: ctx.leaseTtlSeconds,
    });

    if (!acquireResult.acquired) {
      result.skipped++;
      result.details.push({
        runId,
        tenantId,
        state,
        action: 'fenced_already',
        reason: 'Another process acquired the lease first',
      });
      return;
    }

    const newLease = acquireResult.lease;

    // Sync the new lease token+epoch+expiry into the RunLedger so subsequent
    // guarded operations can match the row.
    const synced = ledger.syncLeaseCredentials(runId, newLease.token, newLease.fencingEpoch, {
      tenantId,
      expiresAt: newLease.expiresAt,
    });
    if (!synced) {
      leaseManager.release(runId, newLease.token, { tenantId });
      result.failed++;
      result.details.push({
        runId,
        tenantId,
        state,
        action: 'failed',
        reason: 'Could not bind the reclaimed lease to the run row; refusing to recover',
      });
      return;
    }

    // Step 3: hold and renew the lease until compensation settles.
    const renew = setInterval(
      () => {
        try {
          const ok = leaseManager.heartbeat(runId, newLease.token, {
            tenantId,
            ttlSeconds: ctx.leaseTtlSeconds,
          });
          if (ok) {
            const live = leaseManager.get(runId, { tenantId });
            if (live) {
              ledger.syncLeaseCredentials(runId, live.token, live.fencingEpoch, {
                tenantId,
                expiresAt: live.expiresAt,
              });
            }
          }
        } catch (err) {
          reportSilentFailure(err, 'recoveryBootstrapper:renewLease');
        }
      },
      Math.max(1000, (ctx.leaseTtlSeconds * 1000) / 3),
    );
    renew.unref?.();

    try {
      if (ctx.forceAbort || state !== 'PAUSED') {
        // EXECUTING or VERIFYING — safest to abort+compensate. We cannot trust
        // partial execution state across a crash.
        const abort = await scheduler.abortRun({
          runId,
          leaseToken: newLease.token,
          fencingEpoch: newLease.fencingEpoch,
          tenantId,
          reason: `RecoveryBootstrapper: detected zombie run after process restart (state=${state})`,
        });

        if (!abort.aborted) {
          result.failed++;
          result.details.push({
            runId,
            tenantId,
            state,
            action: 'failed',
            reason: `abortRun refused (${abort.reason ?? 'unknown'}); run left for manual recovery`,
          });
          dlq.record({
            id: `recovery-${runId}-${Date.now()}`,
            category: 'execution',
            runId,
            agentId: 'recovery-bootstrapper',
            timestamp: new Date().toISOString(),
            errorClass: 'permanent',
            errorMessage: `RecoveryBootstrapper abort refused for ${runId} (state=${state}, reason=${abort.reason ?? 'unknown'})`,
            retryable: false,
            attemptNumber: 0,
            operationName: 'recovery.abort',
            compensated: false,
            recovered: false,
            tags: ['recovery', 'zombie', state, 'abort_refused'],
          });
          return;
        }

        result.aborted++;
        const fullyCompensated = abort.outcome.failed === 0;
        if (fullyCompensated) {
          result.compensated++;
          result.recovered++;
        } else {
          result.failed++;
        }
        result.details.push({
          runId,
          tenantId,
          state,
          action: 'aborted',
          reason: fullyCompensated
            ? `Run was in ${state} state with expired lease; aborted+compensated (${abort.outcome.succeeded} compensated)`
            : `Run was in ${state} state with expired lease; aborted but ${abort.outcome.failed} compensation(s) failed — manual reconciliation required`,
        });
        dlq.record({
          id: `recovery-${runId}-${Date.now()}`,
          category: 'execution',
          runId,
          agentId: 'recovery-bootstrapper',
          timestamp: new Date().toISOString(),
          errorClass: fullyCompensated ? 'permanent' : 'unknown',
          errorMessage: fullyCompensated
            ? `RecoveryBootstrapper aborted zombie run: ${runId} (state=${state})`
            : `RecoveryBootstrapper aborted zombie run ${runId} (state=${state}) with ${abort.outcome.failed} failed compensation(s)`,
          retryable: false,
          attemptNumber: 0,
          operationName: 'recovery.abort',
          compensated: fullyCompensated,
          recovered: fullyCompensated,
          tags: ['recovery', 'zombie', state],
        });
        return;
      }

      // PAUSED — can potentially resume (HITL pause, budget pause).
      // Try the 3-path recovery strategy:
      //   Path A: Event replay (DeterminismCapture has recordings)
      //   Path B: Checkpoint resume (StateCheckpointer has a checkpoint)
      //   Path C: No recovery data — manual resume
      let recoveryStrategy: 'replay' | 'checkpoint' | 'none' = 'none';
      let recoveryReason = '';
      try {
        const capture = getGlobalDeterminismCapture();
        if (!capture.hasCaptures(runId)) {
          capture.restoreFromWAL(runId);
        }
        if (capture.hasCaptures(runId)) {
          const replayCtx = capture.buildReplayContext(runId);
          if (replayCtx) {
            recoveryStrategy = 'replay';
            recoveryReason = `Recovered via event replay (${replayCtx.size()} captured inputs)`;
          }
        }
        if (recoveryStrategy === 'none') {
          const checkpointer = new StateCheckpointer(undefined, tenantId);
          const checkpoint = checkpointer.loadCheckpoint(runId);
          if (checkpoint) {
            recoveryStrategy = 'checkpoint';
            recoveryReason = `Recovered from checkpoint (resumeFromStep=${checkpoint.stepNumber})`;
          }
        }
        if (recoveryStrategy === 'none') {
          recoveryReason = 'No replay captures or checkpoint found; manual resume required';
        }
      } catch (recErr) {
        recoveryReason = `Recovery attempt failed: ${(recErr as Error)?.message ?? 'unknown'}; manual resume required`;
      }

      // An actual resume requires separate confirmation; reading replay data or
      // a checkpoint is NOT execution completion, and a PAUSED run is never
      // reported as resumed without it.
      if (ctx.confirmResume) {
        const resumed = ledger.beginExecuting(runId, newLease.token, newLease.fencingEpoch, {
          tenantId,
          from: ['PAUSED'],
        });
        if (resumed) {
          result.recovered++;
          result.details.push({
            runId,
            tenantId,
            state,
            action: 'resumed',
            reason: `Resume confirmed. ${recoveryReason}`,
            recoveryStrategy,
          });
          dlq.record({
            id: `recovery-${runId}-${Date.now()}`,
            category: 'execution',
            runId,
            agentId: 'recovery-bootstrapper',
            timestamp: new Date().toISOString(),
            errorClass: 'unknown',
            errorMessage: `RecoveryBootstrapper resumed PAUSED run: ${runId} — ${recoveryReason}`,
            retryable: false,
            attemptNumber: 0,
            operationName: 'recovery.resume',
            compensated: false,
            recovered: true,
            tags: ['recovery', 'zombie', 'PAUSED', recoveryStrategy, 'confirmed'],
          });
          return;
        }
      }

      result.prepared++;
      result.details.push({
        runId,
        tenantId,
        state,
        action: 'prepared',
        reason: `Run was PAUSED with expired lease; prepared for manual resume. ${recoveryReason}`,
        recoveryStrategy,
      });
      dlq.record({
        id: `recovery-${runId}-${Date.now()}`,
        category: 'execution',
        runId,
        agentId: 'recovery-bootstrapper',
        timestamp: new Date().toISOString(),
        errorClass: 'unknown',
        errorMessage: `RecoveryBootstrapper prepared PAUSED run for manual resume: ${runId} — ${recoveryReason}`,
        retryable: false,
        attemptNumber: 0,
        operationName: 'recovery.prepare',
        compensated: false,
        recovered: false,
        tags: ['recovery', 'zombie', 'PAUSED', recoveryStrategy, 'manual_resume'],
      });
    } finally {
      clearInterval(renew);
      // Release the recovery lease so the scheduler or an operator can
      // re-acquire it. Runs are never reported as recovered while held.
      leaseManager.release(runId, newLease.token, { tenantId });
    }
  }
}
