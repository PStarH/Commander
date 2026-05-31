/**
 * TaskPool — Parallel multi-agent task execution engine.
 *
 * Dispatches multiple tasks to a pool of worker agents running in parallel.
 * Each worker gets its own execution context. Results are collected and
 * returned when all tasks complete or on timeout.
 *
 * This is Commander's killer feature vs OpenClaw/Hermes:
 * they execute one task at a time; Commander runs N tasks across M agents.
 */
import type { AgentRuntime } from '../runtime/agentRuntime';
import type { AgentExecutionContext, AgentExecutionResult } from '../runtime/types';

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
}

const DEFAULT_CONFIG: PoolConfig = {
  maxWorkers: 5,
  defaultTokenBudget: 20000,
  defaultMaxSteps: 10,
  globalTokenBudget: 200000,
  taskTimeoutMs: 300000,
};

export class TaskPool {
  private runtime: AgentRuntime;
  private config: PoolConfig;
  private activeWorkers: Map<string, Promise<PoolResult>> = new Map();
  private totalTokensUsed = 0;

  constructor(runtime: AgentRuntime, config?: Partial<PoolConfig>) {
    this.runtime = runtime;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Dispatch multiple tasks to parallel workers.
   * Workers run concurrently up to maxWorkers.
   * Returns results when all complete (or timeout).
   */
  async dispatch(tasks: PoolTask[]): Promise<PoolResult[]> {
    const sorted = [...tasks].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const results: PoolResult[] = [];
    const totalBudget = this.config.globalTokenBudget;
    const perTaskBudget = Math.min(
      Math.floor(totalBudget / Math.max(1, tasks.length)),
      this.config.defaultTokenBudget,
    );

    // Process in batches of maxWorkers
    for (let i = 0; i < sorted.length; i += this.config.maxWorkers) {
      const batch = sorted.slice(i, i + this.config.maxWorkers);
      const batchPromises = batch.map(task => {
        const p = this.executeTask(task, perTaskBudget);
        this.activeWorkers.set(task.id, p);
        p.finally(() => this.activeWorkers.delete(task.id));
        return p;
      });
      const batchResults = await Promise.allSettled(batchPromises);
      for (const r of batchResults) {
        if (r.status === 'fulfilled') results.push(r.value);
        else results.push({
          taskId: 'unknown',
          status: 'failed',
          summary: '',
          tokens: 0,
          durationMs: 0,
          error: r.reason?.toString(),
        });
      }
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
      availableTools: task.availableTools || ['browser_search', 'browser_fetch', 'python_execute', 'shell_execute'],
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
    return new Promise(resolve => {
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
