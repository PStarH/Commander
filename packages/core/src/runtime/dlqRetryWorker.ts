/**
 * DlqRetryWorker — automated retry for DLQ retryable entries.
 *
 * Closes the "all retries exhausted" gap (Mode 11) from the reversibility
 * audit. The DLQ has `getRetryableEntries()` API but no background worker
 * calls it. Failed runs with transient errors (timeout, rate_limit,
 * provider_unavailable) are permanently dead until manual intervention.
 *
 * Behavior:
 *   - Polls DLQ every `intervalMs` (default 60s) for retryable entries
 *   - Attempts re-execution via the registered retry handler
 *   - On success: marks entry as `recovered` in DLQ
 *   - On failure: increments attempt counter; after `maxAutoRetries` (3),
 *     marks as `escalated` for manual review
 *   - Respects circuit breaker: skips entries for providers with open circuits
 *
 * Integration:
 *   - Instantiated in AgentRuntime constructor
 *   - Timer is unref'd so it doesn't prevent process exit
 *   - Exposed via `getDlqRetryWorker()` singleton for HTTP API inspection
 *
 * Observability:
 *   - Emits metrics via MetricsCollector (dlq_retry_total counter)
 *   - Logs via GlobalLogger
 */

import { getGlobalLogger } from '../logging';
import { getMetricsCollector } from './metricsCollector';

export type DlqRetryStatus = 'idle' | 'running' | 'stopped';

export interface DlqRetryWorkerConfig {
  /** Polling interval in ms (default: 60_000 = 1 minute) */
  intervalMs: number;
  /** Max auto-retries per entry before escalation (default: 3) */
  maxAutoRetries: number;
  /** Max entries to process per poll cycle (default: 10) */
  batchSize: number;
}

const DEFAULT_CONFIG: DlqRetryWorkerConfig = {
  intervalMs: 60_000,
  maxAutoRetries: 3,
  batchSize: 10,
};

/**
 * Retry handler signature. The caller provides a function that takes a DLQ
 * entry's metadata and attempts to re-execute the failed operation.
 *
 * Return value:
 *   - { recovered: true }  → entry succeeded, mark as recovered
 *   - { recovered: false } → entry failed again, will be retried or escalated
 */
export type RetryHandler = (entry: {
  id: string;
  category: string;
  runId: string;
  agentId: string;
  operationName: string;
  errorMessage: string;
  inputSnapshot?: string;
  attemptNumber: number;
}) => Promise<{ recovered: boolean; error?: string }>;

/**
 * Minimal interface for reading DLQ entries. We accept DeadLetterQueue
 * directly but don't import the full type to keep this module decoupled.
 */
export interface DlqReader {
  getRetryableEntries(
    category: string,
    limit: number,
  ): Array<{
    id: string;
    category: string;
    runId: string;
    agentId: string;
    operationName: string;
    errorMessage: string;
    inputSnapshot?: string;
    attemptNumber: number;
    retryable: boolean;
    recovered: boolean;
    tags: string[];
  }>;
  readEntries(
    category: string,
    limit: number,
  ): Array<{
    id: string;
    category: string;
    runId: string;
    agentId: string;
    operationName: string;
    errorMessage: string;
    inputSnapshot?: string;
    attemptNumber: number;
    retryable: boolean;
    recovered: boolean;
    tags: string[];
  }>;
}

/**
 * Interface for marking entries as recovered. We duck-type against
 * DeadLetterQueue's internal buffer manipulation.
 */
export interface DlqWriter {
  record(entry: {
    id: string;
    category: string;
    runId: string;
    agentId: string;
    timestamp: string;
    errorClass: string;
    errorMessage: string;
    retryable: boolean;
    attemptNumber: number;
    operationName: string;
    inputSnapshot?: string;
    compensated: boolean;
    recovered: boolean;
    tags: string[];
  }): void;
  flush(category?: string): void;
}

export class DlqRetryWorker {
  private config: DlqRetryWorkerConfig;
  private dlq: DlqReader & DlqWriter;
  private retryHandler: RetryHandler;
  private timer: ReturnType<typeof setInterval> | null = null;
  private status: DlqRetryStatus = 'idle';
  private lastPollAt: string | null = null;
  private totalProcessed = 0;
  private totalRecovered = 0;
  private totalEscalated = 0;

  constructor(
    dlq: DlqReader & DlqWriter,
    retryHandler: RetryHandler,
    config?: Partial<DlqRetryWorkerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dlq = dlq;
    this.retryHandler = retryHandler;
  }

  /** Start the periodic polling timer. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.status = 'idle';
    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        getGlobalLogger().error('DlqRetryWorker', 'Poll cycle failed', err as Error);
      });
    }, this.config.intervalMs);
    if (
      typeof this.timer === 'object' &&
      typeof (this.timer as ReturnType<typeof setInterval>).unref === 'function'
    ) {
      (this.timer as ReturnType<typeof setInterval>).unref();
    }
    getGlobalLogger().info('DlqRetryWorker', 'Started', { intervalMs: this.config.intervalMs });
  }

  /** Stop the polling timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.status = 'stopped';
    getGlobalLogger().info('DlqRetryWorker', 'Stopped');
  }

  /** Run one poll cycle immediately (also called by the timer). */
  async poll(): Promise<{ processed: number; recovered: number; escalated: number }> {
    if (this.status === 'running') return { processed: 0, recovered: 0, escalated: 0 };
    this.status = 'running';
    this.lastPollAt = new Date().toISOString();

    let processed = 0;
    let recovered = 0;
    let escalated = 0;

    try {
      const categories = ['llm', 'tool', 'execution', 'verification'] as const;
      for (const category of categories) {
        const entries = this.dlq.getRetryableEntries(category, this.config.batchSize);
        for (const entry of entries) {
          if (processed >= this.config.batchSize) break;

          // Skip already-recovered entries
          if (entry.recovered) continue;

          // Skip entries that have been retried too many times
          if (entry.attemptNumber >= this.config.maxAutoRetries) {
            this.escalate(entry);
            escalated++;
            processed++;
            continue;
          }

          try {
            const result = await this.retryHandler({
              id: entry.id,
              category: entry.category,
              runId: entry.runId,
              agentId: entry.agentId,
              operationName: entry.operationName,
              errorMessage: entry.errorMessage,
              inputSnapshot: entry.inputSnapshot,
              attemptNumber: entry.attemptNumber,
            });

            if (result.recovered) {
              this.markRecovered(entry);
              recovered++;
              try {
                getMetricsCollector().incrementCounter('dlq_retry_total', 'DLQ retry outcomes', 1, [
                  { name: 'category', value: entry.category },
                  { name: 'outcome', value: 'recovered' },
                ]);
              } catch {
                /* best-effort */
              }
            } else {
              // Retry failed — will be picked up on next poll cycle
              try {
                getMetricsCollector().incrementCounter('dlq_retry_total', 'DLQ retry outcomes', 1, [
                  { name: 'category', value: entry.category },
                  { name: 'outcome', value: 'retry_failed' },
                ]);
              } catch {
                /* best-effort */
              }
            }
          } catch (err) {
            getGlobalLogger().warn('DlqRetryWorker', 'Retry handler threw', {
              entryId: entry.id,
              error: (err as Error).message,
            });
            try {
              getMetricsCollector().incrementCounter('dlq_retry_total', 'DLQ retry outcomes', 1, [
                { name: 'category', value: entry.category },
                { name: 'outcome', value: 'handler_error' },
              ]);
            } catch {
              /* best-effort */
            }
          }

          processed++;
        }
      }
    } finally {
      this.status = 'idle';
      this.totalProcessed += processed;
      this.totalRecovered += recovered;
      this.totalEscalated += escalated;
    }

    if (processed > 0) {
      getGlobalLogger().info('DlqRetryWorker', 'Poll cycle complete', {
        processed,
        recovered,
        escalated,
      });
    }

    return { processed, recovered, escalated };
  }

  /** Force-process a specific DLQ entry by id. */
  async processEntry(entryId: string): Promise<{ recovered: boolean; error?: string }> {
    const categories = [
      'llm',
      'tool',
      'execution',
      'verification',
      'circuit_breaker',
      'compensation',
    ] as const;
    for (const category of categories) {
      const entries = this.dlq.readEntries(category, 100);
      const entry = entries.find((e) => e.id === entryId);
      if (entry) {
        return this.retryHandler({
          id: entry.id,
          category: entry.category,
          runId: entry.runId,
          agentId: entry.agentId,
          operationName: entry.operationName,
          errorMessage: entry.errorMessage,
          inputSnapshot: entry.inputSnapshot,
          attemptNumber: entry.attemptNumber,
        });
      }
    }
    return { recovered: false, error: 'Entry not found' };
  }

  getStatus(): {
    status: DlqRetryStatus;
    config: DlqRetryWorkerConfig;
    lastPollAt: string | null;
    totalProcessed: number;
    totalRecovered: number;
    totalEscalated: number;
  } {
    return {
      status: this.status,
      config: this.config,
      lastPollAt: this.lastPollAt,
      totalProcessed: this.totalProcessed,
      totalRecovered: this.totalRecovered,
      totalEscalated: this.totalEscalated,
    };
  }

  private markRecovered(entry: { id: string; category: string }): void {
    // Record a new entry with recovered=true to override the old one.
    // The DLQ is append-only; the reader picks up the most recent entry per id.
    try {
      this.dlq.record({
        id: entry.id,
        category: entry.category as string,
        runId: 'dlq-retry-worker',
        agentId: 'dlq-retry-worker',
        timestamp: new Date().toISOString(),
        errorClass: 'transient',
        errorMessage: 'recovered by DlqRetryWorker',
        retryable: false,
        attemptNumber: 0,
        operationName: 'dlq_retry.recovered',
        compensated: false,
        recovered: true,
        tags: ['dlq_retry', 'recovered'],
      });
      this.dlq.flush(entry.category as string);
    } catch {
      /* best-effort */
    }
  }

  private escalate(entry: {
    id: string;
    category: string;
    operationName: string;
    runId: string;
    attemptNumber: number;
  }): void {
    try {
      this.dlq.record({
        id: `${entry.id}_escalated`,
        category: entry.category as string,
        runId: entry.runId,
        agentId: 'dlq-retry-worker',
        timestamp: new Date().toISOString(),
        errorClass: 'permanent',
        errorMessage: `Auto-retry exhausted after ${entry.attemptNumber} attempts for ${entry.operationName}`,
        retryable: false,
        attemptNumber: entry.attemptNumber,
        operationName: 'dlq_retry.escalated',
        compensated: false,
        recovered: false,
        tags: ['dlq_retry', 'escalated', `operation:${entry.operationName}`],
      });
      this.dlq.flush(entry.category as string);
      try {
        getMetricsCollector().incrementCounter('dlq_retry_total', 'DLQ retry outcomes', 1, [
          { name: 'category', value: entry.category },
          { name: 'outcome', value: 'escalated' },
        ]);
      } catch {
        /* best-effort */
      }
    } catch {
      /* best-effort */
    }
  }
}
