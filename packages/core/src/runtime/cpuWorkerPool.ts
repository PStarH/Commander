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

// ============================================================================
// Types
// ============================================================================

export interface CPUWorkerPoolOptions {
  poolSize?: number;
  taskTimeoutMs?: number;
  workerScript?: string;
}

export interface WorkerTask<TInput, TOutput> {
  type: string;
  input: TInput;
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
// CPU Worker Pool
// ============================================================================

export class CPUWorkerPool {
  private workers: Worker[] = [];
  private availableWorkers: Set<number> = new Set();
  private taskQueue: PendingTask[] = [];
  private taskIdCounter = 0;
  private readonly poolSize: number;
  private readonly taskTimeoutMs: number;
  private readonly workerScript: string;
  private closed = false;
  private totalTasksExecuted = 0;
  private totalTasksQueued = 0;

  constructor(options?: CPUWorkerPoolOptions) {
    this.poolSize = options?.poolSize ?? Math.min(2, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1);
    this.taskTimeoutMs = options?.taskTimeoutMs ?? 30_000;
    this.workerScript = options?.workerScript ?? path.join(__dirname, 'cpuWorker.js');
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
      const taskIdx = this.taskQueue.findIndex(t => t.id === msg.id);
      if (taskIdx === -1) return;

      const task = this.taskQueue[taskIdx];
      this.taskQueue.splice(taskIdx, 1);
      this.availableWorkers.add(index);

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
      console.error(`[CPUWorkerPool] Worker ${index} error:`, message);
      this.restartWorker(index);
    });

    worker.on('exit', (code) => {
      if (code !== 0 && !this.closed) {
        console.error(`[CPUWorkerPool] Worker ${index} exited with code ${code}`);
        this.restartWorker(index);
      }
    });

    return worker;
  }

  private async restartWorker(index: number): Promise<void> {
    if (this.closed) return;

    this.availableWorkers.delete(index);
    try {
      this.workers[index]?.terminate();
    } catch {}

    try {
      const worker = await this.createWorker(index);
      this.workers[index] = worker;
      this.availableWorkers.add(index);
      this.processQueue();
    } catch (err) {
      console.error(`[CPUWorkerPool] Failed to restart worker ${index}:`, err);
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
        const idx = this.taskQueue.findIndex(t => t.id === id);
        if (idx !== -1) {
          this.taskQueue.splice(idx, 1);
          reject(new Error(`Task ${id} timed out after ${this.taskTimeoutMs}ms`));
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

      const task = this.taskQueue.find(t => t.timestamp === Math.min(...this.taskQueue.map(t => t.timestamp)));
      if (!task) break;

      const worker = this.workers[workerIdx];
      if (!worker) {
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

    const shutdownPromises = this.workers.map(w => w.terminate());
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
