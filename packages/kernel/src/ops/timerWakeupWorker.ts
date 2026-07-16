/**
 * TimerWakeupWorker — background worker that scans for expired durable
 * timers and takes action on the associated steps.
 *
 * When a timer fires:
 * - INTERACTION_TIMEOUT: The associated interaction is expired and the step
 *   is transitioned from WAITING_FOR_HUMAN → RETRY_WAIT (or FAILED if
 *   maxAttempts is reached).
 * - RETRY_DELAY: The step remains RETRY_WAIT while scheduled_at is advanced,
 *   then the next claim performs RETRY_WAIT → RUNNING.
 * - STEP_DEADLINE: The step is transitioned to FAILED with a deadline
 *   exceeded error.
 *
 * The worker also expires stale interactions.
 *
 * This worker is designed to run as a singleton per kernel instance —
 * the database's SKIP LOCKED ensures that multiple instances do not
 * double-process timers.
 */

import type { KernelRepository } from '../repository.js';
import type { KernelTimer, KernelInteraction } from '../types.js';

export interface TimerWakeupWorkerConfig {
  /** Polling interval in milliseconds. Default: 5000 (5s). */
  pollIntervalMs: number;
  /** Maximum timers to process per batch. Default: 100. */
  batchSize: number;
  /** Whether the worker is enabled. Default: true. */
  enabled: boolean;
}

const DEFAULT_CONFIG: TimerWakeupWorkerConfig = {
  pollIntervalMs: 5000,
  batchSize: 100,
  enabled: true,
};

export class TimerWakeupWorker {
  private readonly repo: KernelRepository;
  private readonly config: TimerWakeupWorkerConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlight?: Promise<void>;
  private stats = {
    timersFired: 0,
    interactionsExpired: 0,
    errors: 0,
    cycles: 0,
  };

  constructor(repo: KernelRepository, config: Partial<TimerWakeupWorkerConfig> = {}) {
    this.repo = repo;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the background polling loop.
   */
  start(): void {
    if (this.timer || !this.config.enabled) return;
    this.timer = setInterval(() => {
      if (!this.inFlight) {
        this.inFlight = this.tick().finally(() => { this.inFlight = undefined; });
      }
    }, this.config.pollIntervalMs);
  }

  /**
   * Stop the background polling loop.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  /**
   * Execute one polling cycle. Useful for testing.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.stats.cycles++;

      // 1. Claim expired timers
      const firedTimers = await this.repo.claimExpiredTimers(new Date(), this.config.batchSize);
      for (const timer of firedTimers) {
        if (!timer.claimToken) {
          this.stats.errors++;
          continue;
        }
        try {
          await this.processFiredTimer(timer);
          if (!await this.repo.acknowledgeTimer(timer.id, timer.tenantId, timer.claimToken)) {
            throw new Error(`Timer ${timer.id} acknowledgement was fenced`);
          }
          this.stats.timersFired++;
        } catch {
          await this.repo.retryTimer(timer.id, timer.tenantId, timer.claimToken);
          this.stats.errors++;
        }
      }

      // 2. Expire stale interactions
      const expired = await this.repo.expireStaleInteractions(new Date(), this.config.batchSize);
      this.stats.interactionsExpired += expired.length;

      // 3. Sweep outbox DLQ (opportunistic — also handles exponential backoff)
      await this.repo.sweepOutboxDlq(new Date(), this.config.batchSize);
    } catch (err) {
      this.stats.errors++;
      // Swallow — the worker must not crash on errors
    } finally {
      this.running = false;
    }
  }

  /**
   * Get runtime statistics.
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  // ── Internal ──

  private async processFiredTimer(timer: KernelTimer): Promise<void> {
    switch (timer.timerType) {
      case 'INTERACTION_TIMEOUT': {
        // Expire the associated interaction and fail the step if it is still
        // waiting for a human response.
        await this.repo.expireStaleInteractions(new Date(), 1);
        const step = await this.repo.getStep(timer.stepId, timer.tenantId);
        if (step && step.state === 'WAITING_FOR_HUMAN') {
          await this.repo.failStepByTimer(
            step.id,
            step.tenantId,
            { code: 'INTERACTION_TIMEOUT', message: 'Human interaction timed out', retryable: false },
            'kernel.timer',
          );
        }
        break;
      }

      case 'RETRY_DELAY': {
        // Advance scheduled_at while retaining RETRY_WAIT; claim performs the transition.
        await this.repo.wakeRetryStep(timer.stepId, timer.tenantId, 'kernel.timer');
        break;
      }

      case 'STEP_DEADLINE': {
        // The step deadline was exceeded — fail the step terminally.
        const step = await this.repo.getStep(timer.stepId, timer.tenantId);
        if (step && !['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(step.state)) {
          await this.repo.failStepByTimer(
            step.id,
            step.tenantId,
            { code: 'STEP_DEADLINE_EXCEEDED', message: 'Step deadline exceeded', retryable: false },
            'kernel.timer',
          );
        }
        break;
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// InteractionExpiryWorker — standalone interaction expiry (for testing)
// ──────────────────────────────────────────────────────────────────────────

export class InteractionExpiryWorker {
  private readonly repo: KernelRepository;
  private timer: ReturnType<typeof setInterval> | null = null;
  private expired = 0;

  constructor(repo: KernelRepository, pollIntervalMs: number = 10_000) {
    this.repo = repo;
    this.tick = this.tick.bind(this);
  }

  start(pollIntervalMs: number = 10_000): void {
    if (this.timer) return;
    this.timer = setInterval(this.tick, pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<KernelInteraction[]> {
    const expired = await this.repo.expireStaleInteractions(new Date(), 100);
    this.expired += expired.length;
    return expired;
  }

  getExpiredCount(): number {
    return this.expired;
  }
}
