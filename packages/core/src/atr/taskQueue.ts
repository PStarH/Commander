/**
 * TaskQueue — Async task queue with HTTP 202 pattern.
 *
 * Lets callers submit agent tasks asynchronously, poll for status, and
 * receive webhook callbacks on completion. The queue is SQLite-backed
 * (no Redis needed) and uses an in-process worker pool for execution.
 *
 * Flow:
 *   POST /api/v1/task  →  202 { jobId, status: 'pending' }
 *   Worker picks up    →  status: 'running'
 *   Execution done     →  status: 'completed' | 'failed'
 *                       →  Webhook callback (if configured)
 *                       →  MessageBus event
 *   GET /api/v1/task/{jobId} → 200 { status, result?, error? }
 *
 * The queue uses the same AgentRuntime infrastructure as sync /execute,
 * with configurable concurrency and token budgets. Each task runs in its
 * own AgentRuntime instance with isolation from other tasks.
 */
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { AgentRuntime } from '../runtime/agentRuntime';
import { getGlobalLogger } from '../logging';
import { getMessageBus } from '../runtime/messageBus';
import { getWebhookDispatcher } from '../runtime/webhookDispatcher';
import type { AgentExecutionResult, LLMProvider } from '../runtime/types';

const log = getGlobalLogger();

// ============================================================================
// Types
// ============================================================================

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TaskRecord {
  jobId: string;
  goal: string;
  status: TaskStatus;
  provider?: string;
  model?: string;
  tenantId?: string;
  callbackUrl?: string;
  result?: string;
  error?: string;
  summary?: string;
  steps?: number;
  tokenUsage?: number;
  durationMs?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskQueueConfig {
  /** Path to the SQLite database file. */
  dbPath: string;
  /** Max concurrent workers (default: 4). */
  maxWorkers: number;
  /** Poll interval in ms for idle workers (default: 2000). */
  pollIntervalMs: number;
  /** Default provider for tasks that don't specify one. */
  defaultProvider: string;
  /** Default model for tasks that don't specify one. */
  defaultModel?: string;
  /** Max steps per task (default: 50). */
  maxSteps: number;
  /** Token budget per task (default: 100000). */
  tokenBudget: number;
  /** Retention TTL in ms for completed/failed tasks (default: 24h). 0 = no cleanup. */
  retentionTtlMs: number;
}

export interface SubmitTaskInput {
  goal: string;
  provider?: string;
  model?: string;
  tenantId?: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
  tokenBudget?: number;
  maxSteps?: number;
}

const DEFAULT_CONFIG: TaskQueueConfig = {
  dbPath: '.commander/task_queue.db',
  maxWorkers: 4,
  pollIntervalMs: 2000,
  defaultProvider: 'openai',
  maxSteps: 50,
  tokenBudget: 100000,
  retentionTtlMs: 24 * 60 * 60 * 1000,
};

// ============================================================================
// SQLite helpers (minimal — same pattern as RunLedger/LeaseManager)
// ============================================================================

interface BetterSqlite3Stmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(...params: unknown[]): T[];
}

interface BetterSqlite3DB {
  prepare(sql: string): BetterSqlite3Stmt;
  pragma(sql: string): void;
  exec(sql: string): void;
  close(): void;
}

let BetterSqlite3: { new (filePath: string): BetterSqlite3DB } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BetterSqlite3 = require('better-sqlite3');
} catch {
  /* not available — will throw on construction */
}

// ============================================================================
// TaskQueue
// ============================================================================

export class TaskQueue {
  private db: BetterSqlite3DB | null = null;
  private config: TaskQueueConfig;
  private workers: WorkerHandle[] = [];
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private stmtInsert: BetterSqlite3Stmt | null = null;
  private stmtGet: BetterSqlite3Stmt | null = null;
  private stmtClaimPending: BetterSqlite3Stmt | null = null;
  private stmtUpdateStatus: BetterSqlite3Stmt | null = null;
  private stmtListByStatus: BetterSqlite3Stmt | null = null;
  private stmtCleanup: BetterSqlite3Stmt | null = null;

  constructor(config?: Partial<TaskQueueConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.openDb();
    this.prepareStatements();
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Submit a task to the queue. Returns the job ID immediately. */
  submit(input: SubmitTaskInput): { jobId: string; status: TaskStatus } {
    if (!this.db || !this.stmtInsert) {
      throw new Error('TaskQueue not initialized');
    }
    const jobId = `task_${randomUUID()}`;
    const now = new Date().toISOString();

    this.stmtInsert.run(
      jobId,
      input.goal,
      'pending',
      input.provider ?? null,
      input.model ?? null,
      input.tenantId ?? null,
      input.callbackUrl ?? null,
      null,
      null,
      null,
      0,
      0,
      0,
      now,
      null,
      null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    );

    log.info('TaskQueue', 'Task submitted', { jobId, goal: input.goal.slice(0, 100) });

    if (this.running) {
      this.signalWorkAvailable();
    }

    return { jobId, status: 'pending' };
  }

  /** Get a task record by job ID. */
  get(jobId: string): TaskRecord | null {
    if (!this.db || !this.stmtGet) return null;
    const row = this.stmtGet.get(jobId) as TaskRow | undefined;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  /** List tasks by status. If status omitted, returns all. */
  list(status?: TaskStatus, limit: number = 100): TaskRecord[] {
    if (!this.db || !this.stmtListByStatus) return [];
    if (status) {
      const rows = this.stmtListByStatus.all(status, limit) as TaskRow[];
      return rows.map((r) => this.rowToRecord(r));
    }
    // List all statuses
    const allStatuses: TaskStatus[] = ['pending', 'running', 'completed', 'failed'];
    const results: TaskRecord[] = [];
    for (const s of allStatuses) {
      const rows = this.stmtListByStatus.all(s, limit) as TaskRow[];
      results.push(...rows.map((r) => this.rowToRecord(r)));
    }
    return results.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /** Start the worker pool. Workers begin claiming pending tasks. */
  start(): void {
    if (this.running) return;
    this.running = true;
    log.info('TaskQueue', 'Starting worker pool', {
      maxWorkers: this.config.maxWorkers,
      pollIntervalMs: this.config.pollIntervalMs,
    });
    this.signalWorkAvailable();
  }

  /** Stop the worker pool. In-flight workers complete before stopping. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    log.info('TaskQueue', 'Worker pool stopped');
  }

  /** Stats for monitoring. */
  getStats(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    activeWorkers: number;
  } {
    const pending = this.list('pending').length;
    const running = this.list('running').length;
    const completed = this.list('completed').length;
    const failed = this.list('failed').length;
    return {
      total: pending + running + completed + failed,
      pending,
      running,
      completed,
      failed,
      activeWorkers: this.workers.filter((w) => w.busy).length,
    };
  }

  /** Remove tasks older than retention TTL. Returns count removed. */
  cleanup(): number {
    if (!this.db || !this.stmtCleanup) return 0;
    const cutoff = new Date(Date.now() - this.config.retentionTtlMs).toISOString();
    const result = this.stmtCleanup.run(cutoff);
    if (result.changes > 0) {
      log.info('TaskQueue', 'Cleaned up old tasks', { removed: result.changes });
    }
    return result.changes;
  }

  /** Dispose of the queue — stop workers and close DB. */
  dispose(): void {
    this.stop();
    this.db?.close();
    this.db = null;
    this.workers = [];
  }

  // ── Worker Pool ────────────────────────────────────────────────

  private signalWorkAvailable(): void {
    if (!this.running) return;
    this.fillWorkers();
    this.pollTimer = setInterval(() => this.poll(), this.config.pollIntervalMs);
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
  }

  /** Ensure we have enough workers in the pool. */
  private fillWorkers(): void {
    while (this.workers.length < this.config.maxWorkers) {
      const worker: WorkerHandle = { busy: false };
      this.workers.push(worker);
    }
  }

  /** Poll for pending tasks and assign to idle workers. */
  private async poll(): Promise<void> {
    if (!this.running || !this.db || !this.stmtClaimPending) return;

    const idleWorker = this.workers.find((w) => !w.busy);
    if (!idleWorker) return;

    const now = new Date().toISOString();
    const row = this.stmtClaimPending.get('pending', now) as TaskRow | undefined;
    if (!row) return;

    const task = this.rowToRecord(row);
    idleWorker.busy = true;

    this.executeTask(task, idleWorker).finally(() => {
      idleWorker.busy = false;
    });
  }

  /** Execute a task in a sandboxed AgentRuntime. */
  private async executeTask(task: TaskRecord, worker: WorkerHandle): Promise<void> {
    const startTime = Date.now();
    log.info('TaskQueue', 'Worker starting task', { jobId: task.jobId });

    let runtime: AgentRuntime | null = null;
    try {
      runtime = new AgentRuntime();
      const provider = task.provider ?? this.config.defaultProvider;
      const providerInstance = this.resolveProvider(provider);
      if (providerInstance) {
        runtime.registerProvider(provider, providerInstance);
      }

      const result = await runtime.execute({
        agentId: `task-${task.jobId}`,
        projectId: 'task-queue',
        goal: task.goal,
        availableTools: [
          'web_search',
          'web_fetch',
          'file_read',
          'file_write',
          'file_edit',
          'file_search',
          'file_list',
          'python_execute',
          'shell_execute',
          'memory_store',
          'memory_recall',
          'memory_list',
          'git',
          'browser_search',
          'browser_fetch',
        ],
        maxSteps: task.metadata?.maxSteps
          ? (task.metadata.maxSteps as number)
          : this.config.maxSteps,
        tokenBudget: task.metadata?.tokenBudget
          ? (task.metadata.tokenBudget as number)
          : this.config.tokenBudget,
        contextData: {},
        tenantId: task.tenantId,
      });

      const durationMs = Date.now() - startTime;

      this.updateTaskResult(task.jobId, {
        status: 'completed',
        summary: result.summary,
        steps: result.steps?.length ?? 0,
        tokenUsage: result.totalTokenUsage.totalTokens,
        durationMs,
        result: result.summary,
      });

      if (task.callbackUrl) {
        this.fireCallback(task.callbackUrl, task.jobId, 'completed', result);
      }

      getMessageBus().publish('agent.completed', `task-queue:${task.jobId}`, {
        taskId: task.jobId,
        status: 'completed',
        metrics: { durationMs, steps: result.steps?.length ?? 0 },
      });
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = (err as Error).message ?? String(err);

      this.updateTaskResult(task.jobId, {
        status: 'failed',
        error: errorMessage,
        durationMs,
      });

      if (task.callbackUrl) {
        this.fireCallback(task.callbackUrl, task.jobId, 'failed', { error: errorMessage });
      }

      getMessageBus().publish('agent.failed', `task-queue:${task.jobId}`, {
        taskId: task.jobId,
        error: errorMessage,
      });
    } finally {
      runtime?.dispose();
    }
  }

  private updateTaskResult(
    jobId: string,
    update: {
      status: TaskStatus;
      summary?: string;
      steps?: number;
      tokenUsage?: number;
      durationMs?: number;
      result?: string;
      error?: string;
    },
  ): void {
    if (!this.db || !this.stmtUpdateStatus) return;
    const now = new Date().toISOString();
    const startedAt = this.get(jobId)?.startedAt ?? now;
    this.stmtUpdateStatus.run(
      update.status,
      update.result ?? null,
      update.error ?? null,
      update.summary ?? null,
      update.steps ?? 0,
      update.tokenUsage ?? 0,
      update.durationMs ?? 0,
      startedAt,
      now,
      jobId,
    );
  }

  // ── Webhook Callback ───────────────────────────────────────────

  private fireCallback(
    url: string,
    jobId: string,
    status: string,
    payload: unknown,
  ): void {
    try {
      const dispatcher = getWebhookDispatcher();
      const existing = dispatcher.listWebhooks().find((w) => w.url === url);
      if (!existing) {
        dispatcher.registerWebhook({
          url,
          events: ['agent.completed', 'agent.failed'],
          enabled: true,
        });
      }
      dispatcher.dispatch(
        status === 'completed' ? 'agent.completed' : 'agent.failed',
        { jobId, status, ...(payload as Record<string, unknown>) },
        `task-queue:${jobId}`,
      );
    } catch (err) {
      log.warn('TaskQueue', 'Webhook callback failed', {
        jobId,
        url,
        error: (err as Error).message,
      });
    }
  }

  // ── Provider Resolution ────────────────────────────────────────

  private resolveProvider(provider: string): LLMProvider | null {
    try {
      const { OpenAIProvider } = require('../runtime/providers/openaiProvider');
      return new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY ?? '' }) as LLMProvider;
    } catch {
      return null;
    }
  }

  // ── SQLite ─────────────────────────────────────────────────────

  private openDb(): void {
    if (!BetterSqlite3) {
      throw new Error(
        'TaskQueue requires better-sqlite3. Install it: pnpm add better-sqlite3',
      );
    }
    if (this.config.dbPath !== ':memory:') {
      mkdirSync(dirname(this.config.dbPath), { recursive: true });
    }
    this.db = new BetterSqlite3(this.config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        job_id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        provider TEXT,
        model TEXT,
        tenant_id TEXT,
        callback_url TEXT,
        result TEXT,
        error TEXT,
        summary TEXT,
        steps INTEGER DEFAULT 0,
        token_usage INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);
    `);
  }

  private prepareStatements(): void {
    if (!this.db) return;
    this.stmtInsert = this.db.prepare(`
      INSERT INTO tasks
        (job_id, goal, status, provider, model, tenant_id, callback_url,
         result, error, summary, steps, token_usage, duration_ms,
         created_at, started_at, completed_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtGet = this.db.prepare(
      `SELECT * FROM tasks WHERE job_id = ? LIMIT 1`,
    );
    this.stmtClaimPending = this.db.prepare(`
      UPDATE tasks
      SET status = 'running', started_at = ?
      WHERE job_id = (
        SELECT job_id FROM tasks
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
      )
      RETURNING *
    `);
    this.stmtUpdateStatus = this.db.prepare(`
      UPDATE tasks
      SET status = ?, result = ?, error = ?, summary = ?, steps = ?,
          token_usage = ?, duration_ms = ?, started_at = ?, completed_at = ?
      WHERE job_id = ?
    `);
    this.stmtListByStatus = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this.stmtCleanup = this.db.prepare(`
      DELETE FROM tasks
      WHERE status IN ('completed', 'failed')
      AND completed_at IS NOT NULL
      AND completed_at < ?
    `);
  }

  private rowToRecord(row: TaskRow): TaskRecord {
    return {
      jobId: row.job_id,
      goal: row.goal,
      status: row.status as TaskStatus,
      provider: row.provider ?? undefined,
      model: row.model ?? undefined,
      tenantId: row.tenant_id ?? undefined,
      callbackUrl: row.callback_url ?? undefined,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
      summary: row.summary ?? undefined,
      steps: row.steps ?? 0,
      tokenUsage: row.token_usage ?? 0,
      durationMs: row.duration_ms ?? 0,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    };
  }
}

// ============================================================================
// Internal types
// ============================================================================

interface WorkerHandle {
  busy: boolean;
}

interface TaskRow {
  job_id: string;
  goal: string;
  status: string;
  provider: string | null;
  model: string | null;
  tenant_id: string | null;
  callback_url: string | null;
  result: string | null;
  error: string | null;
  summary: string | null;
  steps: number | null;
  token_usage: number | null;
  duration_ms: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  metadata_json: string | null;
}

// ============================================================================
// Singleton
// ============================================================================

let defaultTaskQueue: TaskQueue | null = null;

export function getTaskQueue(config?: Partial<TaskQueueConfig>): TaskQueue {
  if (!defaultTaskQueue) {
    defaultTaskQueue = new TaskQueue(config);
  }
  return defaultTaskQueue;
}

export function resetTaskQueue(): void {
  if (defaultTaskQueue) {
    defaultTaskQueue.dispose();
    defaultTaskQueue = null;
  }
}
