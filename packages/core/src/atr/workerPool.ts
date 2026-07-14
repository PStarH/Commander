/**
 * Kernel worker loop — Architecture V2 data-plane claim/execute.
 *
 * Workers claim PENDING runs and wakeable PAUSED runs from ATR, then
 * hand them to an injected AgentRuntime-like executor.
 */

import { getExecutionScheduler, type RunHandle } from '../atr/scheduler';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';

export interface WorkerExecutor {
  /** Resume or start execution for a claimed run handle. */
  executeClaimed(handle: RunHandle): Promise<void>;
}

export interface WorkerPoolOptions {
  /** Max concurrent claims in this process. */
  concurrency?: number;
  /** Poll interval when idle (ms). */
  pollIntervalMs?: number;
  /** Prefer waking PAUSED-with-resume_at before PENDING. */
  preferWake?: boolean;
  tenantId?: string;
  executor: WorkerExecutor;
  /** Optional stop signal. */
  signal?: AbortSignal;
}

export interface WorkerPoolStats {
  claimed: number;
  woken: number;
  errors: number;
  idlePolls: number;
  running: boolean;
}

export class KernelWorkerPool {
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly preferWake: boolean;
  private readonly tenantId?: string;
  private readonly executor: WorkerExecutor;
  private readonly signal?: AbortSignal;
  private running = false;
  private inFlight = 0;
  private stats: WorkerPoolStats = {
    claimed: 0,
    woken: 0,
    errors: 0,
    idlePolls: 0,
    running: false,
  };

  constructor(opts: WorkerPoolOptions) {
    this.concurrency = opts.concurrency ?? 4;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.preferWake = opts.preferWake ?? true;
    this.tenantId = opts.tenantId;
    this.executor = opts.executor;
    this.signal = opts.signal;
  }

  getStats(): WorkerPoolStats {
    return { ...this.stats, running: this.running };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stats.running = true;
    getGlobalLogger().info('KernelWorkerPool', 'Worker pool started', {
      concurrency: this.concurrency,
      preferWake: this.preferWake,
    });

    while (this.running && !this.signal?.aborted) {
      if (this.inFlight >= this.concurrency) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      const handle = this.claimNext();
      if (!handle) {
        this.stats.idlePolls++;
        await sleep(this.pollIntervalMs);
        continue;
      }

      this.inFlight++;
      void this.dispatch(handle);
    }

    // Drain in-flight
    while (this.inFlight > 0) {
      await sleep(50);
    }
    this.stats.running = false;
  }

  stop(): void {
    this.running = false;
  }

  private claimNext(): RunHandle | null {
    const scheduler = getExecutionScheduler();
    if (this.preferWake) {
      const woken = scheduler.claimRunnableRun({ tenantId: this.tenantId });
      if (woken) {
        this.stats.woken++;
        return woken;
      }
    }
    const pending = scheduler.claimNextRun({ tenantId: this.tenantId });
    if (pending) this.stats.claimed++;
    return pending;
  }

  private async dispatch(handle: RunHandle): Promise<void> {
    try {
      await this.executor.executeClaimed(handle);
    } catch (err) {
      this.stats.errors++;
      reportSilentFailure(err, 'KernelWorkerPool:dispatch');
      getGlobalLogger().error('KernelWorkerPool', 'Worker dispatch failed', err as Error, {
        runId: handle.runId,
      });
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
