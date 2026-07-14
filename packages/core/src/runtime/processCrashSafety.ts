/**
 * ProcessCrashSafety — Installs process-level crash handlers.
 *
 * Closes the "no process.on('uncaughtException')" gap from the reversibility
 * audit. Without this, a single uncaught error in any LLM callback, tool
 * promise rejection, or async tool execution kills the process, leaving:
 *   - Held leases (zombie processes)
 *   - Unwritten DLQ entries
 *   - In-flight compensation handlers orphaned
 *
 * On crash, this module:
 *   1. Logs to DLQ for each active run
 *   2. Releases leases via LeaseManager
 *   3. Aborts scheduler for each active run
 *   4. Exits with code 1
 *
 * Idempotent: calling install() multiple times is safe (replaces handler).
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { getGlobalLogger } from '../logging';
import type { DeadLetterQueue, DeadLetterEntry } from './deadLetterQueue';
import type { LeaseManager } from '../atr/leaseManager';
import { getExecutionScheduler } from '../atr/scheduler';
import { getFreezeDryManager } from './freezeDry';

export type CrashSource =
  'uncaughtException' | 'unhandledRejection' | 'SIGTERM' | 'SIGINT' | 'exit_timeout';

export interface CrashSafetyDeps {
  dlq: DeadLetterQueue;
  leaseManager: LeaseManager;
  /** Active run IDs (pass AgentRuntime's activeRuns Set) */
  activeRunIds: () => Iterable<string>;
  /** Lease token per runId (returns empty string if no lease) */
  leaseTokenFor?: (runId: string) => string | undefined;
  /** Fencing epoch per runId */
  fencingEpochFor?: (runId: string) => number | undefined;
  /** Tenant ID per runId (for DLQ isolation) */
  tenantIdFor?: (runId: string) => string | undefined;
  /** Graceful shutdown timeout before force-exit (ms) */
  exitTimeoutMs?: number;
  /** Called for each active run during crash shutdown (for checkpoint flush, etc.) */
  onRunCrash?: (runId: string) => void;
  /** Called once after all runs are processed (for closing DB connections, etc.) */
  onShutdownComplete?: () => void;
}

let installed = false;
let shuttingDown = false;

export function installProcessCrashHandlers(deps: CrashSafetyDeps): void {
  if (installed) return;
  installed = true;

  const log = getGlobalLogger();

  const gracefulShutdown = async (source: CrashSource, err?: Error) => {
    if (shuttingDown) return;
    shuttingDown = true;

    const errorMessage = err?.message ?? String(err ?? 'unknown');
    log.error('ProcessCrashSafety', `Process crash: ${source}`, undefined, { errorMessage });

    let dlqWritten = 0;
    let leasesReleased = 0;
    let runsAborted = 0;

    for (const runId of deps.activeRunIds()) {
      const leaseToken = deps.leaseTokenFor?.(runId);
      const fencingEpoch = deps.fencingEpochFor?.(runId);
      const tenantId = deps.tenantIdFor?.(runId);

      deps.onRunCrash?.(runId);

      const entry: DeadLetterEntry = {
        id: `crash-${runId}-${Date.now()}`,
        category: 'execution',
        runId,
        agentId: 'process-crash-safety',
        timestamp: new Date().toISOString(),
        errorClass: 'permanent',
        errorMessage: `Process ${source}: ${errorMessage.slice(0, 500)}`,
        retryable: true,
        attemptNumber: 0,
        operationName: 'process.crash',
        compensated: false,
        recovered: false,
        tags: ['crash', source],
      };
      try {
        deps.dlq.record(entry);
        dlqWritten++;
      } catch (e) {
        log.error('ProcessCrashSafety', 'DLQ record failed during crash shutdown', undefined, {
          runId,
          errorMessage: (e as Error).message,
        });
      }

      if (leaseToken) {
        try {
          deps.leaseManager.release(runId, leaseToken, { tenantId });
          leasesReleased++;
        } catch (e) {
          log.debug('ProcessCrashSafety', 'Lease release failed during crash', {
            runId,
            error: (e as Error).message,
          });
        }
      }

      if (leaseToken && fencingEpoch !== undefined) {
        try {
          const scheduler = getExecutionScheduler();
          scheduler.abortRun({
            runId,
            leaseToken,
            fencingEpoch,
            tenantId,
            reason: `Process ${source}: ${errorMessage.slice(0, 200)}`,
          });
          runsAborted++;
        } catch (e) {
          log.debug('ProcessCrashSafety', 'Scheduler abortRun failed during crash', {
            runId,
            error: (e as Error).message,
          });
        }
      }
    }

    log.error('ProcessCrashSafety', 'Crash shutdown complete', undefined, {
      source,
      dlqWritten,
      leasesReleased,
      runsAborted,
      errorMessage,
    });

    // FreezeDry: write a manifest of the (now-aborted) active runs so the
    // operator can resume them via `commander up --resume` after restart.
    // Best-effort — must not block process exit.
    try {
      const manifest = getFreezeDryManager().freeze();
      if (manifest && manifest.runs.length > 0) {
        log.info('ProcessCrashSafety', 'FreezeDry manifest written', {
          frozenRuns: manifest.runs.length,
          suggestedCommand: manifest.suggestedCommand,
        });
      }
    } catch (err) {
      reportSilentFailure(err, 'processCrashSafety:freezeDry');
    }

    try {
      deps.onShutdownComplete?.();
    } catch (err) {
      reportSilentFailure(err, 'processCrashSafety:147');
      /* best-effort */
    }

    try {
      await deps.dlq.flush();
    } catch (e) {
      log.error('ProcessCrashSafety', 'DLQ flush failed during crash shutdown', undefined, {
        errorMessage: (e as Error).message,
      });
    }
  };

  process.on('uncaughtException', (err) => {
    gracefulShutdown('uncaughtException', err).catch((e) => {
      log.error('ProcessCrashSafety', 'Graceful shutdown failed', undefined, {
        errorMessage: (e as Error).message,
      });
    });
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    gracefulShutdown('unhandledRejection', err).catch((e) => {
      log.error('ProcessCrashSafety', 'Graceful shutdown failed', undefined, {
        errorMessage: (e as Error).message,
      });
    });
  });
  process.on('SIGTERM', () => {
    gracefulShutdown('SIGTERM').catch((e) => {
      log.error('ProcessCrashSafety', 'Graceful shutdown failed', undefined, {
        errorMessage: (e as Error).message,
      });
    });
  });
  process.on('SIGINT', () => {
    gracefulShutdown('SIGINT').catch((e) => {
      log.error('ProcessCrashSafety', 'Graceful shutdown failed', undefined, {
        errorMessage: (e as Error).message,
      });
    });
  });
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function resetCrashHandlersForTesting(): void {
  installed = false;
  shuttingDown = false;
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
}
