import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
/**
 * CPU Worker Pool — Offload CPU-intensive operations to worker_threads.
 *
 * Uses Node.js worker_threads to run heavy computations (compaction, scoring,
 * summarization) without blocking the main event loop.
 *
 * Design:
 * - Fixed pool size (default: 2 workers, configurable)
 * - Task queue with backpressure
 * - Automatic worker restart on crash
 * - Timeout support for long-running tasks
 */
import { Worker, type WorkerOptions } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';

// ============================================================================
// Types
// ============================================================================

export interface CPUWorkerPoolOptions {
  poolSize?: number;
  taskTimeoutMs?: number;
  workerScript?: string;
}

export interface PendingTask {
  id: string;
  type: string;
  input: unknown;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timestamp: number;
}

// ============================================================================
// Worker script resolution
// ============================================================================

function resolveWorkerScript(explicit?: string): string {
  if (explicit) return explicit;
  const dir = __dirname;
  // Prefer TypeScript source when running under tsx; fall back to compiled JS.
  const tsPath = path.join(dir, 'cpuWorker.ts');
  if (fs.existsSync(tsPath)) return tsPath;
  return path.join(dir, 'cpuWorker.js');
}

// ============================================================================
// CPU Worker Pool
// ============================================================================

export class CPUWorkerPool {
  private workers: Worker[] = [];
  private availableWorkers: Set<number> = new Set();
  private taskQueue: PendingTask[] = [];
  private inFlightTasks = new Map<string, PendingTask>();
  private taskWorkerIndex = new Map<string, number>();
  private taskIdCounter = 0;
  private readonly poolSize: number;
  private readonly taskTimeoutMs: number;
  private readonly workerScript: string;
  private closed = false;
  private totalTasksExecuted = 0;
  private totalTasksQueued = 0;

  constructor(options?: CPUWorkerPoolOptions) {
    this.poolSize =
      options?.poolSize ?? Math.min(2, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1);
    this.taskTimeoutMs = options?.taskTimeoutMs ?? 30_000;
    this.workerScript = resolveWorkerScript(options?.workerScript);
  }

  async start(): Promise<void> {
    for (let i = 0; i < this.poolSize; i++) {
      const worker = await this.createWorker(i);
      this.workers.push(worker);
      this.availableWorkers.add(i);
    }
  }

  private async createWorker(index: number): Promise<Worker> {
    const worker = new Worker(this.workerScript, {
      name: `cpu-worker-${index}`,
    } as WorkerOptions);

    worker.on('message', (msg: { id: string; result?: unknown; error?: string }) => {
      this.availableWorkers.add(index);

      const task = this.inFlightTasks.get(msg.id);
      if (!task) return;
      this.inFlightTasks.delete(msg.id);
      this.taskWorkerIndex.delete(msg.id);

      if (msg.error) {
        task.reject(new Error(msg.error));
      } else {
        task.resolve(msg.result);
      }

      this.totalTasksExecuted++;
      this.processQueue();
    });

    worker.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      getGlobalLogger().error('cpuWorkerPool', `[CPUWorkerPool] Worker ${index} error:`, message);
      this.restartWorker(index);
    });

    worker.on('exit', (code) => {
      if (code !== 0 && !this.closed) {
        getGlobalLogger().error('cpuWorkerPool', `[CPUWorkerPool] Worker ${index} exited with code ${code}`);
        this.restartWorker(index);
      }
    });

    return worker;
  }

  private async restartWorker(index: number): Promise<void> {
    if (this.closed) return;

    this.availableWorkers.delete(index);
    // Reject any in-flight tasks assigned to this worker so callers don't hang.
    for (const [id, task] of this.inFlightTasks) {
      if (this.taskWorkerIndex.get(id) === index) {
        this.inFlightTasks.delete(id);
        this.taskWorkerIndex.delete(id);
        task.reject(new Error(`Worker ${index} crashed during task ${id}`));
      }
    }

    try {
      this.workers[index]?.terminate();
    } catch (_silentE_) {
        reportSilentFailure(_silentE_, 'cpuWorkerPool:136');
    }

    try {
      const worker = await this.createWorker(index);
      this.workers[index] = worker;
      this.availableWorkers.add(index);
      this.processQueue();
    } catch (err) {
      getGlobalLogger().error('cpuWorkerPool', `[CPUWorkerPool] Failed to restart worker ${index}:`, err);
    }
  }

  async execute<TInput, TOutput>(type: string, input: TInput): Promise<TOutput> {
    if (this.closed) throw new Error('Pool is closed');

    return new Promise<TOutput>((resolve, reject) => {
      const id = `task-${++this.taskIdCounter}`;
      const task: PendingTask = {
        id,
        type,
        input,
        resolve: resolve as (v: unknown) => void,
        reject,
        timestamp: Date.now(),
      };

      this.taskQueue.push(task);
      this.totalTasksQueued++;

      const timer = setTimeout(() => {
        // Task still queued?
        const idx = this.taskQueue.findIndex((t) => t.id === id);
        if (idx !== -1) {
          this.taskQueue.splice(idx, 1);
          reject(new Error(`Task ${id} timed out after ${this.taskTimeoutMs}ms`));
          return;
        }
        // Task is in-flight — abort it and recycle the worker.
        const inFlight = this.inFlightTasks.get(id);
        if (inFlight) {
          this.inFlightTasks.delete(id);
          const workerIdx = this.taskWorkerIndex.get(id);
          this.taskWorkerIndex.delete(id);
          inFlight.reject(new Error(`Task ${id} timed out after ${this.taskTimeoutMs}ms`));
          if (workerIdx !== undefined) {
            this.restartWorker(workerIdx);
          }
        }
      }, this.taskTimeoutMs);

      const originalReject = task.reject;
      task.reject = (err: Error) => {
        clearTimeout(timer);
        originalReject(err);
      };

      const originalResolve = task.resolve;
      task.resolve = (v: unknown) => {
        clearTimeout(timer);
        originalResolve(v);
      };

      this.processQueue();
    });
  }

  private processQueue(): void {
    while (this.taskQueue.length > 0 && this.availableWorkers.size > 0) {
      const workerIdx = this.availableWorkers.values().next().value!;
      this.availableWorkers.delete(workerIdx);

      const task = this.taskQueue.shift()!;
      this.inFlightTasks.set(task.id, task);
      this.taskWorkerIndex.set(task.id, workerIdx);

      const worker = this.workers[workerIdx];
      if (!worker) {
        // Worker missing — put task back and release the slot.
        this.taskQueue.unshift(task);
        this.inFlightTasks.delete(task.id);
        this.taskWorkerIndex.delete(task.id);
        this.availableWorkers.add(workerIdx);
        break;
      }

      worker.postMessage({ id: task.id, type: task.type, input: task.input });
    }
  }

  getStats(): {
    poolSize: number;
    availableWorkers: number;
    queueDepth: number;
    totalExecuted: number;
    totalQueued: number;
  } {
    return {
      poolSize: this.poolSize,
      availableWorkers: this.availableWorkers.size,
      queueDepth: this.taskQueue.length,
      totalExecuted: this.totalTasksExecuted,
      totalQueued: this.totalTasksQueued,
    };
  }

  async shutdown(): Promise<void> {
    this.closed = true;

    const err = new Error('Pool shutdown');
    while (this.taskQueue.length > 0) {
      const task = this.taskQueue.shift()!;
      task.reject(err);
    }
    for (const task of this.inFlightTasks.values()) {
      task.reject(err);
    }
    this.inFlightTasks.clear();
    this.taskWorkerIndex.clear();

    const shutdownPromises = this.workers.map((w) => w.terminate());
    await Promise.allSettled(shutdownPromises);
    this.workers = [];
    this.availableWorkers.clear();
  }
}

// ============================================================================
// Singleton
// ============================================================================

let _pool: CPUWorkerPool | null = null;

export async function getCPUWorkerPool(): Promise<CPUWorkerPool> {
  if (!_pool) {
    _pool = new CPUWorkerPool();
    await _pool.start();
  }
  return _pool;
}

export async function resetCPUWorkerPool(): Promise<void> {
  if (_pool) {
    await _pool.shutdown();
    _pool = null;
  }
}
