/**
 * TaskPool — Parallel multi-agent task execution engine.
 *
 * Dispatches multiple tasks to a pool of worker agents running in parallel.
 * Each worker gets its own execution context. Results are collected and
 * returned when all tasks complete or on timeout.
 *
 * This is Commander's killer feature vs OpenClaw/Hermes:
 * they execute one task at a time; Commander runs N tasks across M agents.
 *
 * Day 2 wire-through: after each batch resolves, commit a
 * `reliabilityEngine.checkpointAtomically(...)` row to the ATR WAL backend
 * via the `task-pool-batch` phase. stepNumber is the 1-based batch index.
 */
import type { AgentRuntimeInterface } from '../runtime';
import type { AgentExecutionContext, AgentExecutionResult } from '../runtime/types';
import type { ReliabilityEngine } from '../runtime/reliabilityEngine';
import {
  toTaskPoolCheckpoint,
  safeCheckpointAtomically,
  tryResumeFromATR,
  type ResumePoint,
} from './checkpointAdapters';

export interface PoolTask {
  id: string;
  goal: string;
  agentId?: string;
  priority?: number;
  availableTools?: string[];
  tokenBudget?: number;
  maxSteps?: number;
}

export interface PoolResult {
  taskId: string;
  status: 'success' | 'failed' | 'timeout';
  summary: string;
  tokens: number;
  durationMs: number;
  error?: string;
}

export interface PoolConfig {
  maxWorkers: number;
  defaultTokenBudget: number;
  defaultMaxSteps: number;
  globalTokenBudget: number;
  taskTimeoutMs: number;
  /**
   * Day 2 wire-through: optional ATR-backed ReliabilityEngine. When set,
   * every batch boundary (after Promise.allSettled on the batch resolves)
   * commits a `task-pool-batch` row to WAL before the next batch starts.
   */
  reliabilityEngine?: ReliabilityEngine;
  /**
   * Day 2 wire-through: optional explicit runId for checkpoint rows.
   * If absent, TaskPool generates one per `dispatch()` call.
   */
  runId?: string;
}

const DEFAULT_CONFIG: PoolConfig = {
  maxWorkers: 5,
  defaultTokenBudget: 20000,
  defaultMaxSteps: 10,
  globalTokenBudget: 200000,
  taskTimeoutMs: 300000,
};

export class TaskPool {
  private runtime: AgentRuntimeInterface;
  private config: PoolConfig;
  private activeWorkers: Map<string, Promise<PoolResult>> = new Map();
  private totalTokensUsed = 0;
  /**
   * Day 4 ABI: latest ResumePoint consumed by `resumePointedAt`. Cleared
   * before each `dispatch()` run so a re-executed pool does not silently
   * re-apply a previous session's state.
   */
  private resumeIngest?: ResumePoint;

  constructor(runtime: AgentRuntimeInterface, config?: Partial<PoolConfig>) {
    this.runtime = runtime;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Day 4 ABI: consult the WAL for `runId` and ingest the durable
   * batch results into this pool. Returns `true` when the WAL contains
   * a `task-pool-batch` row that can be re-applied.
   *
   *   - not-found: fresh start, dispatch() emits a new seed at stepNumber=0
   *   - seed:      re-use the existing runId partition; skip the start seed
   *                and dispatch() picks up from batch index 1 with an empty
   *                results set
   *   - resume:    re-hydrate `results` + `totalTokensUsed`, continue batch
   *                numbering from `ceil(results.length / maxWorkers)`; skip
   *                the start seed
   */
  resumePointedAt(runId: string): boolean {
    if (!this.config.reliabilityEngine) return false;
    const point = tryResumeFromATR(this.config.reliabilityEngine, runId, {
      phase: 'task-pool-batch',
    });
    if (point.kind === 'not-found') {
      this.resumeIngest = undefined;
      return false;
    }
    this.resumeIngest = point;
    return true;
  }

  /** Day 4 ABI: read-only inspection of the last ingest result. */
  getResumePoint(): ResumePoint | undefined {
    return this.resumeIngest;
  }

  /**
   * Dispatch multiple tasks to parallel workers.
   * Workers run concurrently up to maxWorkers.
   * Returns results when all complete (or timeout).
   */
  async dispatch(tasks: PoolTask[]): Promise<PoolResult[]> {
    // Day 4 ABI: capture and clear the resume ingest before doing any work.
    const ingest = this.resumeIngest;
    this.resumeIngest = undefined;

    const sorted = [...tasks].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const totalBudget = this.config.globalTokenBudget;
    const perTaskBudget = Math.min(
      Math.floor(totalBudget / Math.max(1, tasks.length)),
      this.config.defaultTokenBudget,
    );

    // Generate a per-dispatch runId when caller hasn't supplied one. The
    // persisted runId is what `reliabilityEngine.getLatestCheckpoint(runId)`
    // returns to callers wanting to resume.
    const runId =
      this.config.runId ?? `task-pool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Day 4 ABI: pre-populate `results` and `batchIndex` when a prior
    // session committed partial work to the WAL.
    let results: PoolResult[];
    let batchIndex: number;
    const isResume = ingest?.kind === 'resume';
    const isSeed = ingest?.kind === 'seed';

    if (isResume && ingest.kind === 'resume') {
      // Re-hydrate from durable payload. `results` and `totalTokensUsed`
      // were captured at the last per-batch checkpoint; we continue the
      // batch counter from `ceil(results.length / maxWorkers)`. Caller
      // must keep `maxWorkers` stable across restart for this math to
      // hold; downstream invariants (test contract) handle only the
      // standard maxWorkers=1 / maxWorkers=2 cases.
      results = (ingest.payload.results as PoolResult[]) ?? [];
      this.totalTokensUsed = (ingest.payload.totalTokensUsed as number) ?? 0;
      batchIndex = Math.max(0, Math.ceil(results.length / this.config.maxWorkers));
      // SKIP start seed: the previous row at stepNumber=0 (and the rows
      // after it) are still in the WAL, so the kill9 "≥1 row at all
      // times" contract is already satisfied.
    } else if (isSeed) {
      results = [];
      batchIndex = 0;
      // SKIP start seed: prior row at stepNumber=0 is in WAL.
    } else {
      results = [];
      batchIndex = 0;
      // Day 2: emit start row at stepNumber=0 so SIGKILL before batch 1 leaves
      // a recovery anchor. Per-batch rows land at stepNumber=batchIndex (1-based)
      // immediately after Promise.allSettled resolves.
      safeCheckpointAtomically(
        this.config.reliabilityEngine,
        toTaskPoolCheckpoint(runId, 0, results, this.totalTokensUsed),
      );
    }

    // Process in batches of maxWorkers. stepNumber = 1-based batch index.
    for (let i = 0; i < sorted.length; i += this.config.maxWorkers) {
      batchIndex++;
      const batch = sorted.slice(i, i + this.config.maxWorkers);
      const batchPromises = batch.map((task) => {
        const p = this.executeTask(task, perTaskBudget);
        this.activeWorkers.set(task.id, p);
        p.finally(() => this.activeWorkers.delete(task.id));
        return p;
      });
      const batchResults = await Promise.allSettled(batchPromises);
      for (const r of batchResults) {
        if (r.status === 'fulfilled') results.push(r.value);
        else
          results.push({
            taskId: 'unknown',
            status: 'failed',
            summary: '',
            tokens: 0,
            durationMs: 0,
            error: r.reason?.toString(),
          });
      }

      // Day 2: checkpoint per batch boundary. stepNumber is monotonically
      // increasing across the dispatch() call. Soft-fails inside
      // safeCheckpointAtomically so a WAL write error never aborts the
      // remaining batches.
      safeCheckpointAtomically(
        this.config.reliabilityEngine,
        toTaskPoolCheckpoint(runId, batchIndex, results, this.totalTokensUsed),
      );
    }

    return results;
  }

  private async executeTask(task: PoolTask, budget: number): Promise<PoolResult> {
    // Atomically reserve budget to prevent TOCTOU race
    const reservation = Math.min(budget, this.config.globalTokenBudget - this.totalTokensUsed);
    if (reservation <= 0) {
      return {
        taskId: task.id,
        status: 'failed',
        summary: 'Global token budget exhausted',
        tokens: 0,
        durationMs: 0,
        error: 'Budget exceeded',
      };
    }
    this.totalTokensUsed += reservation;

    const startTime = Date.now();
    const workerId = task.agentId || `worker-${task.id}`;

    // Create execution context
    const ctx: AgentExecutionContext = {
      agentId: workerId,
      projectId: 'taskpool',
      goal: task.goal,
      contextData: {},
      availableTools: task.availableTools || [
        'browser_search',
        'browser_fetch',
        'python_execute',
        'shell_execute',
      ],
      maxSteps: task.maxSteps || this.config.defaultMaxSteps,
      tokenBudget: Math.min(reservation, task.tokenBudget || this.config.defaultTokenBudget),
    };

    try {
      // Run with timeout and abort support
      const ac = new AbortController();
      const result = await Promise.race([
        this.runtime.execute({ ...ctx, abortSignal: ac.signal }),
        this.timeout(this.config.taskTimeoutMs),
      ]);

      if (result === 'timeout') {
        ac.abort();
        // Refund unused reservation
        this.totalTokensUsed -= reservation;
        return {
          taskId: task.id,
          status: 'timeout',
          summary: '',
          tokens: 0,
          durationMs: Date.now() - startTime,
          error: 'Task timed out',
        };
      }

      const execResult = result as AgentExecutionResult;
      // Adjust: refund unused portion of reservation
      const actualTokens = execResult.totalTokenUsage.totalTokens;
      this.totalTokensUsed -= reservation - actualTokens;

      return {
        taskId: task.id,
        status: execResult.status === 'success' ? 'success' : 'failed',
        summary: execResult.summary || '',
        tokens: execResult.totalTokenUsage.totalTokens,
        durationMs: execResult.totalDurationMs,
        error: execResult.error,
      };
    } catch (err: unknown) {
      // Refund unused reservation on failure
      this.totalTokensUsed -= reservation;
      return {
        taskId: task.id,
        status: 'failed',
        summary: '',
        tokens: 0,
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private timeout(ms: number): Promise<'timeout'> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), ms);
      timer.unref();
    });
  }

  getStats() {
    return {
      totalTokensUsed: this.totalTokensUsed,
      activeWorkers: this.activeWorkers.size,
      maxWorkers: this.config.maxWorkers,
    };
  }
}
