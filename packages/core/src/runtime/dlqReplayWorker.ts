/**
 * DLQ Replay Worker — Automatically drains retryable entries from the Dead Letter Queue.
 *
 * Problem: DeadLetterQueue.replay() only marks entries as recovered — it doesn't
 * actually re-execute the failed operation. The comment says "returns the entry
 * for an external re-execution pipeline" but no such pipeline existed.
 *
 * Solution: This worker runs on a periodic interval, scans for retryable
 * entries, marks them as recovered, and publishes `dlq.replayed` events
 * so that downstream consumers (saga compensator, retry scheduler) can
 * re-execute the operations.
 *
 * Additionally, when a circuit breaker transitions to OPEN, the worker
 * publishes a `circuit.compensation_trigger` event so that the scheduler
 * can trigger compensation rollback for any uncommitted mutations.
 */
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import { getMessageBus } from './messageBus';
import type { DeadLetterQueue, DLQCategory, DeadLetterEntry } from './deadLetterQueue';

export interface DLQReplayWorkerConfig {
  /** Interval between drain cycles in ms (default: 60_000 = 1 min) */
  intervalMs: number;
  /** Max entries to process per cycle (default: 20) */
  batchSize: number;
  /** Categories to process (default: all) */
  categories: DLQCategory[];
}

export const DEFAULT_DLQ_WORKER_CONFIG: DLQReplayWorkerConfig = {
  intervalMs: 60_000,
  batchSize: 20,
  categories: [
    'llm',
    'tool',
    'execution',
    'verification',
    'circuit_breaker',
    'compensation',
    'semantic_drift',
  ],
};

let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerConfig: DLQReplayWorkerConfig = { ...DEFAULT_DLQ_WORKER_CONFIG };
let dlqRef: DeadLetterQueue | null = null;

/**
 * Start the DLQ replay worker.
 *
 * @param dlq The DeadLetterQueue instance to drain
 * @param config Optional configuration override
 */
export function startDLQReplayWorker(
  dlq: DeadLetterQueue,
  config?: Partial<DLQReplayWorkerConfig>,
): void {
  if (workerTimer) {
    getGlobalLogger().debug('DLQReplayWorker', 'Already running — skipping start');
    return;
  }

  dlqRef = dlq;
  workerConfig = { ...DEFAULT_DLQ_WORKER_CONFIG, ...config };

  getGlobalLogger().info('DLQReplayWorker', 'Started', {
    intervalMs: workerConfig.intervalMs,
    batchSize: workerConfig.batchSize,
  });

  // Run immediately, then on interval
  drainCycle();
  workerTimer = setInterval(drainCycle, workerConfig.intervalMs);
}

/**
 * Stop the DLQ replay worker.
 */
export function stopDLQReplayWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    dlqRef = null;
    getGlobalLogger().info('DLQReplayWorker', 'Stopped');
  }
}

/**
 * Process one drain cycle — scan for retryable entries and replay them.
 */
async function drainCycle(): Promise<void> {
  if (!dlqRef) return;

  try {
    const bus = getMessageBus();
    let totalProcessed = 0;

    for (const category of workerConfig.categories) {
      try {
        const entries = await dlqRef.getRetryableEntries(category, workerConfig.batchSize);
        if (entries.length === 0) continue;

        for (const entry of entries) {
          try {
            // CRITICAL: Do NOT call dlq.replay() here — it marks the entry as
            // recovered, which prevents future retries. Instead, publish the
            // entry data so consumers can re-execute and call markRecovered()
            // only after successful re-execution.
            bus.publish('dlq.replayed', 'dlqWorker', {
              entryId: entry.id,
              category,
              runId: entry.runId,
              agentId: entry.agentId,
              operationName: entry.operationName,
              errorMessage: entry.errorMessage,
              inputSnapshot: entry.inputSnapshot,
              publishedAt: new Date().toISOString(),
            });
            totalProcessed++;
          } catch (err) {
            reportSilentFailure(err, `dlqReplayWorker:publish:${entry.id}`);
          }
        }
      } catch (err) {
        reportSilentFailure(err, `dlqReplayWorker:category:${category}`);
      }
    }

    if (totalProcessed > 0) {
      getGlobalLogger().info('DLQReplayWorker', `Drain cycle complete`, {
        processed: totalProcessed,
      });
    }
  } catch (err) {
    reportSilentFailure(err, 'dlqReplayWorker:drainCycle');
  }
}

// ── Circuit Breaker → Compensation Rollback Linkage ───────────────────────

/**
 * When a circuit breaker transitions to OPEN, trigger compensation rollback
 * for any uncommitted mutations from the affected run.
 *
 * Previously, circuit breaker trips only prevented future calls to the same
 * tool/provider — they didn't roll back mutations that were already committed
 * but whose enclosing run was now doomed to fail. This linkage ensures that
 * when a breaker trips, the scheduler's abortRun + compensate path is invoked.
 */
export function onCircuitBreakerOpen(params: {
  provider?: string;
  toolName?: string;
  runId?: string;
  agentId?: string;
  reason: string;
}): void {
  try {
    const bus = getMessageBus();

    // Publish a compensation trigger event — the scheduler or a dedicated
    // compensation handler can subscribe to this and call abortRun + compensate
    bus.publish('circuit.compensation_trigger', 'circuitBreaker', {
      provider: params.provider,
      toolName: params.toolName,
      runId: params.runId,
      agentId: params.agentId,
      reason: params.reason,
      timestamp: new Date().toISOString(),
      severity: 'critical',
    });

    // Also publish as a system alert so NotificationManager can notify operators
    bus.publish('system.alert', 'circuitBreaker', {
      type: 'circuit_breaker_open',
      severity: 'critical',
      provider: params.provider,
      toolName: params.toolName,
      runId: params.runId,
      agentId: params.agentId,
      reason: params.reason,
    });

    getGlobalLogger().warn(
      'DLQReplayWorker',
      'Circuit breaker opened — compensation trigger published',
      params,
    );
  } catch (err) {
    reportSilentFailure(err, 'dlqReplayWorker:onCircuitBreakerOpen');
  }
}
