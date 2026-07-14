/**
 * ConcurrencyController — per-tenant semaphore for AgentRuntime execute slots.
 *
 * Extracted from AgentRuntime so the god object only delegates.
 * In multi-tenant mode each tenant gets its own semaphore; in single-tenant
 * mode (or when no tenant context is active) executions fall back to the
 * global semaphore keyed by `__global__`.
 *
 * Reliability (REL-10): the waiter queue is bounded (backpressure via rejection),
 * acquires can time out (no unbounded stalls), release is floored at zero and
 * idempotent per acquisition (a double-release can never drive the count
 * negative into permanent over-admission), and idle non-global semaphores are
 * evicted so the tenant map cannot grow without bound.
 */

import { getCurrentTenantId } from './tenantContext';

const GLOBAL_TENANT_KEY = '__global__';
const DEFAULT_MAX_QUEUE_DEPTH = 10_000;

export class ConcurrencyQueueFullError extends Error {
  constructor(depth: number) {
    super(`Concurrency queue full (${depth} waiting); rejecting to apply backpressure`);
    this.name = 'ConcurrencyQueueFullError';
  }
}

export class ConcurrencyAcquireTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for a concurrency slot`);
    this.name = 'ConcurrencyAcquireTimeoutError';
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

class Semaphore {
  private runningCount = 0;
  private waitingQueue: Waiter[] = [];
  private maxConcurrency: number;
  private readonly maxQueueDepth: number;

  constructor(maxConcurrency: number, maxQueueDepth: number) {
    this.maxConcurrency = maxConcurrency;
    this.maxQueueDepth = maxQueueDepth;
  }

  async acquire(timeoutMs?: number): Promise<void> {
    if (this.runningCount < this.maxConcurrency) {
      this.runningCount++;
      return;
    }
    if (this.waitingQueue.length >= this.maxQueueDepth) {
      throw new ConcurrencyQueueFullError(this.maxQueueDepth);
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          if (waiter.timer) clearTimeout(waiter.timer);
          this.runningCount++;
          resolve();
        },
        reject: (err: Error) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          reject(err);
        },
      };
      if (timeoutMs && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this.waitingQueue.indexOf(waiter);
          if (idx >= 0) this.waitingQueue.splice(idx, 1);
          waiter.reject(new ConcurrencyAcquireTimeoutError(timeoutMs));
        }, timeoutMs);
        // Do not keep the event loop alive solely for a queued waiter.
        waiter.timer.unref?.();
      }
      this.waitingQueue.push(waiter);
    });
  }

  release(): void {
    // Idle + empty means a spurious/double release: ignore it rather than
    // letting runningCount go negative (which would permanently over-admit).
    if (this.runningCount === 0 && this.waitingQueue.length === 0) return;
    this.runningCount = Math.max(0, this.runningCount - 1);
    const next = this.waitingQueue.shift();
    if (next) next.resolve();
  }

  isIdle(): boolean {
    return this.runningCount === 0 && this.waitingQueue.length === 0;
  }

  getQueueDepth(): number {
    return this.waitingQueue.length;
  }

  getRunningCount(): number {
    return this.runningCount;
  }

  setMaxConcurrency(max: number): void {
    this.maxConcurrency = max;
    // A raised ceiling may now admit queued waiters.
    while (this.runningCount < this.maxConcurrency && this.waitingQueue.length > 0) {
      const next = this.waitingQueue.shift();
      next?.resolve();
    }
  }
}

export interface ConcurrencyControllerOptions {
  /** Max number of executions that may wait for a slot per tenant before acquire rejects. */
  maxQueueDepth?: number;
  /** Default acquire timeout (ms) applied when a caller does not pass one. 0/undefined = wait forever. */
  acquireTimeoutMs?: number;
}

export class ConcurrencyController {
  private tenantSemaphores = new Map<string, Semaphore>();
  private maxConcurrency: number;
  private readonly maxQueueDepth: number;
  private readonly defaultAcquireTimeoutMs?: number;

  constructor(maxConcurrency: number, options: ConcurrencyControllerOptions = {}) {
    this.maxConcurrency = maxConcurrency;
    this.maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.defaultAcquireTimeoutMs = options.acquireTimeoutMs;
  }

  private resolveTenantId(tenantId?: string): string {
    return tenantId ?? getCurrentTenantId() ?? GLOBAL_TENANT_KEY;
  }

  private getSemaphoreByKey(key: string): Semaphore {
    let semaphore = this.tenantSemaphores.get(key);
    if (!semaphore) {
      semaphore = new Semaphore(this.maxConcurrency, this.maxQueueDepth);
      this.tenantSemaphores.set(key, semaphore);
    }
    return semaphore;
  }

  private releaseByKey(key: string): void {
    const semaphore = this.tenantSemaphores.get(key);
    if (!semaphore) return;
    semaphore.release();
    // Evict idle, non-global semaphores so the map cannot grow with tenant churn.
    if (key !== GLOBAL_TENANT_KEY && semaphore.isIdle()) {
      this.tenantSemaphores.delete(key);
    }
  }

  /**
   * Acquire a slot for the current (or explicitly provided) tenant. The tenant
   * key is captured now, so the returned release always targets the same
   * semaphore even if the async tenant context changes before release. The
   * returned function is idempotent — calling it twice releases only once.
   */
  async acquire(tenantId?: string, timeoutMs?: number): Promise<() => void> {
    const key = this.resolveTenantId(tenantId);
    const semaphore = this.getSemaphoreByKey(key);
    await semaphore.acquire(timeoutMs ?? this.defaultAcquireTimeoutMs);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseByKey(key);
    };
  }

  release(tenantId?: string): void {
    this.releaseByKey(this.resolveTenantId(tenantId));
  }

  /**
   * Legacy acquire entrypoint used by AgentRuntime/RunInitializer.
   * Matches the original `acquireSlot` signature.
   */
  async acquireSlot(tenantId?: string, timeoutMs?: number): Promise<void> {
    const key = this.resolveTenantId(tenantId);
    await this.getSemaphoreByKey(key).acquire(timeoutMs ?? this.defaultAcquireTimeoutMs);
  }

  /** Legacy release entrypoint. */
  releaseSlot(tenantId?: string): void {
    this.release(tenantId);
  }

  getQueueDepth(tenantId?: string): number {
    const key = this.resolveTenantId(tenantId);
    return this.tenantSemaphores.get(key)?.getQueueDepth() ?? 0;
  }

  getRunningCount(tenantId?: string): number {
    const key = this.resolveTenantId(tenantId);
    return this.tenantSemaphores.get(key)?.getRunningCount() ?? 0;
  }

  /** Query the number of currently running executions for a tenant. */
  getTenantConcurrency(tenantId: string): number {
    return this.tenantSemaphores.get(tenantId)?.getRunningCount() ?? 0;
  }

  setMaxConcurrency(max: number): void {
    this.maxConcurrency = max;
    for (const semaphore of this.tenantSemaphores.values()) {
      semaphore.setMaxConcurrency(max);
    }
  }
}
