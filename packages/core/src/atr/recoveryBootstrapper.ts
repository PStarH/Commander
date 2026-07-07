/**
 * RecoveryBootstrapper — Zombie run recovery on process startup.
 *
 * Scans the RunLedger at boot for runs left in EXECUTING, VERIFYING, or PAUSED
 * states by a previously crashed or killed process. For each zombie run:
 *
 *   1. Cross-checks the lease expiration via LeaseManager
 *   2. Acquires the lease (bumps fencing epoch, fencing any surviving zombie)
 *   3. Decides the recovery action:
 *      - PAUSED + recoverable checkpoint → resumeRun (caller picks up)
 *      - EXECUTING / VERIFYING → abortRun + compensate (safe default)
 *      - Runs with no lease or already reclaimed → skipped (logged)
 *   4. Records a DeadLetterQueue entry for each recovered run
 *   5. Publishes recovery events to the MessageBus
 *
 * Bootstrap order (called from httpServer.ts start() after crash handlers):
 *   RecoveryBootstrapper.bootstrap(options) → void
 *
 * This is idempotent: if two processes race on startup, the second will find
 * the leases already acquired and skip.
 */
import { getGlobalLogger } from '../logging';
import { LeaseManager } from './leaseManager';
import { RunLedger, getRunLedgerBundle } from './runLedger';
import { getExecutionScheduler } from './scheduler';
import { getDeadLetterQueue } from '../runtime/deadLetterQueueSingleton';
import { getMessageBus } from '../runtime/messageBus';
import { StateCheckpointer } from '../runtime/stateCheckpointer';
import { getGlobalDeterminismCapture } from '../runtime/determinismCapture';
import type { RunState } from './types';

export interface RecoveryBootstrapperOptions {
  /** LeaseManager instance. Defaults to the global singleton. */
  leaseManager?: LeaseManager;
  /** RunLedger instance. Defaults to the global singleton. */
  ledger?: RunLedger;
  /** If true, runs are aborted+compensated instead of resumed (safe for CI). */
  forceAbort?: boolean;
  /** Holder label for reclaimed leases. */
  holder?: string;
}

export interface RecoveryResult {
  scanned: number;
  recovered: number;
  aborted: number;
  skipped: number;
  details: RecoveryDetail[];
}

export interface RecoveryDetail {
  runId: string;
  tenantId?: string;
  state: RunState;
  action: 'resumed' | 'aborted' | 'skipped' | 'fenced_already';
  reason: string;
  /** Which recovery strategy was selected by RunRecovery (if attempted). */
  recoveryStrategy?: 'replay' | 'checkpoint' | 'none';
}

const ZOMBIE_STATES: RunState[] = ['EXECUTING', 'VERIFYING', 'PAUSED'];

export class RecoveryBootstrapper {
  /**
   * Run the one-time bootstrap scan. Returns a summary of what was recovered.
   * Call this once at process startup, after the crash handlers are installed.
   */
  static bootstrap(options?: RecoveryBootstrapperOptions): RecoveryResult {
    const result: RecoveryResult = {
      scanned: 0,
      recovered: 0,
      aborted: 0,
      skipped: 0,
      details: [],
    };

    try {
      const bundle = getRunLedgerBundle();
      const scheduler = getExecutionScheduler();
      const dlq = getDeadLetterQueue();
      const bus = getMessageBus();

      const leaseManager = options?.leaseManager ?? bundle.lease;
      const ledger = options?.ledger ?? bundle.ledger;
      const holder = options?.holder ?? `recovery-${process.pid}`;

      for (const state of ZOMBIE_STATES) {
        const runs = ledger.listByState(state);

        for (const run of runs) {
          result.scanned++;
          const runId = run.runId;
          const tenantId = run.tenantId;

          // Step 1: Check if the lease is still alive
          const currentLease = leaseManager.get(runId, { tenantId });
          if (!currentLease) {
            // No lease at all — run was likely already cleaned up
            result.skipped++;
            result.details.push({
              runId,
              tenantId,
              state: run.state,
              action: 'skipped',
              reason: 'No lease found — run may have been cleaned up externally',
            });
            continue;
          }

          // Check if lease is expired
          const isExpired = new Date(currentLease.expiresAt).getTime() <= Date.now();
          if (!isExpired) {
            // Lease is still valid — someone else holds it (likely another process)
            result.skipped++;
            result.details.push({
              runId,
              tenantId,
              state: run.state,
              action: 'skipped',
              reason: `Lease still valid (holder=${currentLease.holder}, expires=${currentLease.expiresAt})`,
            });
            continue;
          }

          // Step 2: Acquire the expired lease — this bumps the fencing epoch
          // and fences any zombie process that might still be alive.
          const acquireResult = leaseManager.acquire(runId, {
            tenantId,
            holder,
            ttlSeconds: 30,
          });

          if (!acquireResult.acquired) {
            // Someone else grabbed it first
            result.skipped++;
            result.details.push({
              runId,
              tenantId,
              state: run.state,
              action: 'fenced_already',
              reason: 'Another process acquired the lease first',
            });
            continue;
          }

          const newLease = acquireResult.lease;

          // Sync the new lease token+epoch into the RunLedger so that
          // subsequent scheduler.ledger operations can find the row.
          ledger.syncLeaseCredentials(runId, newLease.token, newLease.fencingEpoch, { tenantId });

          // Step 3: Decide recovery action
          const forceAbort = options?.forceAbort ?? false;

          if (forceAbort || state !== 'PAUSED') {
            // EXECUTING or VERIFYING — safest to abort+compensate.
            // We cannot trust partial execution state across a crash.
            // Also handles forceAbort for PAUSED runs.
            scheduler.abortRun({
              runId,
              leaseToken: newLease.token,
              fencingEpoch: newLease.fencingEpoch,
              tenantId,
              reason: `RecoveryBootstrapper: detected zombie run after process restart (state=${state})`,
            });
            result.aborted++;
            result.details.push({
              runId,
              tenantId,
              state: run.state,
              action: 'aborted',
              reason: `Run was in ${state} state with expired lease; aborted+compensated`,
            });

            // Record DLQ entry for ops visibility
            dlq.record({
              id: `recovery-${runId}-${Date.now()}`,
              category: 'execution',
              runId,
              agentId: 'recovery-bootstrapper',
              timestamp: new Date().toISOString(),
              errorClass: 'permanent',
              errorMessage: `RecoveryBootstrapper aborted zombie run: ${runId} (state=${state})`,
              retryable: false,
              attemptNumber: 0,
              operationName: 'recovery.abort',
              compensated: true,
              recovered: true,
              tags: ['recovery', 'zombie', state],
            });
          } else {
            // PAUSED — can potentially resume (HITL pause, budget pause).
            // Try the 3-path recovery strategy before falling back to a
            // plain lease-reclaim:
            //   Path A: Event replay (DeterminismCapture has recordings)
            //   Path B: Checkpoint resume (StateCheckpointer has a checkpoint)
            //   Path C: No recovery data — mark as "available for resume" (caller retries)
            let recoveryStrategy: 'replay' | 'checkpoint' | 'none' = 'none';
            let recoveryReason = '';
            try {
              // Path A: check for event replay captures (restore from WAL first)
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
              // Path B: check for checkpoint
              if (recoveryStrategy === 'none') {
                const checkpointer = new StateCheckpointer(undefined, tenantId);
                const checkpoint = checkpointer.loadCheckpoint(runId);
                if (checkpoint) {
                  recoveryStrategy = 'checkpoint';
                  recoveryReason = `Recovered from checkpoint (resumeFromStep=${checkpoint.stepNumber})`;
                }
              }
              // Path C: no recovery data
              if (recoveryStrategy === 'none') {
                recoveryReason =
                  'No replay captures or checkpoint found; run available for manual resume';
              }
            } catch (recErr) {
              recoveryReason = `Recovery attempt failed: ${(recErr as Error)?.message ?? 'unknown'}; run available for manual resume`;
            }

            result.recovered++;
            result.details.push({
              runId,
              tenantId,
              state: run.state,
              action: 'resumed',
              reason: `Run was PAUSED with expired lease; lease reclaimed. ${recoveryReason}`,
              recoveryStrategy,
            });

            dlq.record({
              id: `recovery-${runId}-${Date.now()}`,
              category: 'execution',
              runId,
              agentId: 'recovery-bootstrapper',
              timestamp: new Date().toISOString(),
              errorClass: 'unknown',
              errorMessage: `RecoveryBootstrapper reclaimed PAUSED run: ${runId} — ${recoveryReason}`,
              retryable: false,
              attemptNumber: 0,
              operationName: 'recovery.reclaim',
              compensated: false,
              recovered: true,
              tags: ['recovery', 'zombie', 'PAUSED', recoveryStrategy],
            });
          }

          // Release the recovery lease so the scheduler or caller can re-acquire
          leaseManager.release(runId, newLease.token, { tenantId });
        }
      }

      // Publish summary to the message bus for operators/alerting
      if (result.scanned > 0) {
        bus.publish('recovery.completed', 'recovery-bootstrapper', {
          scanned: result.scanned,
          recovered: result.recovered,
          aborted: result.aborted,
          skipped: result.skipped,
          details: result.details,
        });
      }
    } catch (err) {
      getGlobalLogger().error('RecoveryBootstrapper', 'Bootstrap scan failed', err as Error);
    }

    getGlobalLogger().info('RecoveryBootstrapper', 'Bootstrap complete', {
      scanned: result.scanned,
      recovered: result.recovered,
      aborted: result.aborted,
      skipped: result.skipped,
    });

    return result;
  }
}
