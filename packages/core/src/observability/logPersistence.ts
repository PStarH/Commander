// ─────────────────────────────────────────────────────────────────────────────
// LogPersistence
//
// SQLite WAL-mode log persistence with:
// - PRAGMA busy_timeout = 5000 (prevents SQLITE_BUSY under concurrent writes)
// - PRAGMA synchronous = NORMAL (WAL-safe, faster than FULL)
// - Backpressure degradation: queue >10000 → drop Debug/Info, keep Error only
// - Auto-rotation: retain 7 days, auto-cleanup
// - Async write queue: never blocks the logging critical path
//
// Enabled via COMMANDER_LOG_PERSIST=true env var. Default off to preserve
// existing behavior.
// ─────────────────────────────────────────────────────────────────────────────

import path from 'node:path';
import { mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs';

// ============================================================================
// Types
// ============================================================================

export type PersistedLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface PersistedLogEntry {
  id?: number;
  timestamp: string; // ISO
  level: PersistedLogLevel;
  component: string;
  message: string;
  traceId?: string;
  runId?: string;
  tenantId?: string;
  metadata?: string; // JSON string
}

export interface LogQueryOptions {
  level?: PersistedLogLevel;
  component?: string;
  traceId?: string;
  runId?: string;
  tenantId?: string;
  since?: string; // ISO timestamp
  until?: string; // ISO timestamp
  limit?: number;
  cursor?: number; // last entry id for pagination
}

export interface LogQueryResult {
  entries: PersistedLogEntry[];
  nextCursor: number | null;
  total: number;
}

// ============================================================================
// LogPersistence
// ============================================================================

const QUEUE_BACKPRESSURE_THRESHOLD = 10000;
const RETENTION_DAYS = 7;
const CLEANUP_INTERVAL_MS = 3600_000; // 1 hour
const FLUSH_INTERVAL_MS = 1000; // 1 second batch flush

export class LogPersistence {
  /* eslint-disable @typescript-eslint/no-explicit-any */ private db: any = null; /* eslint-enable @typescript-eslint/no-explicit-any */
  private queue: PersistedLogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private totalWritten = 0;
  private totalDropped = 0;

  constructor(private dbPath: string) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Initialize the SQLite database and start the async write queue.
   */
  start(): void {
    if (this.started) return;

    try {
      // Lazy require to avoid crash if better-sqlite3 not installed
      const Database = require('better-sqlite3');
      this.db = new Database(this.dbPath);

      // WAL mode + concurrency safety
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('foreign_keys = ON');

      // Create table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS app_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          level TEXT NOT NULL,
          component TEXT NOT NULL,
          message TEXT NOT NULL,
          trace_id TEXT,
          run_id TEXT,
          tenant_id TEXT,
          metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON app_logs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_logs_level ON app_logs(level);
        CREATE INDEX IF NOT EXISTS idx_logs_component ON app_logs(component);
        CREATE INDEX IF NOT EXISTS idx_logs_trace_id ON app_logs(trace_id);
        CREATE INDEX IF NOT EXISTS idx_logs_run_id ON app_logs(run_id);
        CREATE INDEX IF NOT EXISTS idx_logs_tenant_id ON app_logs(tenant_id);
      `);

      // Prepare insert statement
      this.insertStmt = this.db.prepare(`
        INSERT INTO app_logs (timestamp, level, component, message, trace_id, run_id, tenant_id, metadata)
        VALUES (@timestamp, @level, @component, @message, @trace_id, @run_id, @tenant_id, @metadata)
      `);

      // Start async flush timer
      this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
      this.flushTimer.unref();

      // Start cleanup timer
      this.cleanupTimer = setInterval(() => this.cleanupOldLogs(), CLEANUP_INTERVAL_MS);
      this.cleanupTimer.unref();

      // Run initial cleanup
      this.cleanupOldLogs();

      this.started = true;
    } catch (err) {
      // If SQLite init fails, persistence is disabled — logging continues
      // to console and in-memory buffer.
      console.error('[LogPersistence] Failed to initialize SQLite, persistence disabled:', err);
      this.db = null;
    }
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */ private insertStmt: any = null; /* eslint-enable @typescript-eslint/no-explicit-any */

  /**
   * Queue a log entry for async persistence.
   * Applies backpressure degradation: if queue exceeds threshold,
   * drops debug/info entries and keeps only warn/error/critical.
   */
  enqueue(entry: PersistedLogEntry): void {
    if (!this.started || !this.db) return;

    // Backpressure: if queue is too large, drop lower-priority logs
    if (this.queue.length >= QUEUE_BACKPRESSURE_THRESHOLD) {
      if (entry.level === 'debug' || entry.level === 'info') {
        this.totalDropped++;
        return; // Drop — only keep warn/error/critical during backpressure
      }
      // Even for warn/error, if queue is 2x threshold, drop oldest
      if (this.queue.length >= QUEUE_BACKPRESSURE_THRESHOLD * 2) {
        this.queue.shift();
        this.totalDropped++;
      }
    }

    this.queue.push(entry);
  }

  /**
   * Flush queued entries to SQLite in a single transaction.
   */
  flush(): void {
    if (!this.started || !this.db || this.queue.length === 0) return;

    const batch = this.queue.splice(0, Math.min(this.queue.length, 500));

    try {
      const tx = this.db.transaction((entries: PersistedLogEntry[]) => {
        for (const entry of entries) {
          this.insertStmt.run({
            timestamp: entry.timestamp,
            level: entry.level,
            component: entry.component,
            message: entry.message,
            trace_id: entry.traceId ?? null,
            run_id: entry.runId ?? null,
            tenant_id: entry.tenantId ?? null,
            metadata: entry.metadata ?? null,
          });
        }
      });
      tx(batch);
      this.totalWritten += batch.length;
    } catch (err) {
      // If batch write fails, put entries back at front of queue
      this.queue.unshift(...batch);
      // But cap to prevent unbounded growth
      if (this.queue.length > QUEUE_BACKPRESSURE_THRESHOLD * 3) {
        this.queue.length = QUEUE_BACKPRESSURE_THRESHOLD;
      }
    }
  }

  /**
   * Query persisted logs with filtering and pagination.
   */
  query(options: LogQueryOptions): LogQueryResult {
    if (!this.started || !this.db) {
      return { entries: [], nextCursor: null, total: 0 };
    }

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (options.level) {
      conditions.push('level = @level');
      params.level = options.level;
    }
    if (options.component) {
      conditions.push('component = @component');
      params.component = options.component;
    }
    if (options.traceId) {
      conditions.push('trace_id = @traceId');
      params.traceId = options.traceId;
    }
    if (options.runId) {
      conditions.push('run_id = @runId');
      params.runId = options.runId;
    }
    if (options.tenantId) {
      conditions.push('tenant_id = @tenantId');
      params.tenantId = options.tenantId;
    }
    if (options.since) {
      conditions.push('timestamp >= @since');
      params.since = options.since;
    }
    if (options.until) {
      conditions.push('timestamp <= @until');
      params.until = options.until;
    }
    if (options.cursor) {
      conditions.push('id > @cursor');
      params.cursor = options.cursor;
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = options.limit ?? 100;

    try {
      // Count total
      const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM app_logs ${whereClause}`);
      const countResult = countStmt.get(params);
      const total = countResult?.count ?? 0;

      // Fetch entries
      const queryStmt = this.db.prepare(
        `SELECT * FROM app_logs ${whereClause} ORDER BY id ASC LIMIT @limitVal`,
      );
      const rows = queryStmt.all({ ...params, limitVal: limit });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entries: PersistedLogEntry[] = rows.map((row: any) => ({
        id: row.id,
        timestamp: row.timestamp,
        level: row.level,
        component: row.component,
        message: row.message,
        traceId: row.trace_id ?? undefined,
        runId: row.run_id ?? undefined,
        tenantId: row.tenant_id ?? undefined,
        metadata: row.metadata ?? undefined,
      }));

      const nextCursor =
        entries.length === limit && entries.length > 0 ? entries[entries.length - 1].id! : null;

      return { entries, nextCursor, total };
    } catch {
      return { entries: [], nextCursor: null, total: 0 };
    }
  }

  /**
   * Delete logs older than retention period.
   */
  private cleanupOldLogs(): void {
    if (!this.db) return;

    try {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
      this.db.prepare('DELETE FROM app_logs WHERE timestamp < @cutoff').run({ cutoff });

      // Also run WAL checkpoint to reclaim space
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Non-critical
    }
  }

  /**
   * Stop persistence, flush remaining queue, close database.
   */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Final flush
    this.flush();

    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Non-critical
      }
      this.db = null;
    }

    this.started = false;
  }

  /** Get persistence statistics for monitoring. */
  getStats(): { totalWritten: number; totalDropped: number; queueLength: number; active: boolean } {
    return {
      totalWritten: this.totalWritten,
      totalDropped: this.totalDropped,
      queueLength: this.queue.length,
      active: this.started,
    };
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalLogPersistence: LogPersistence | null = null;

export function getGlobalLogPersistence(): LogPersistence | null {
  if (!globalLogPersistence) {
    const enabled = typeof process !== 'undefined' && process.env?.COMMANDER_LOG_PERSIST === 'true';

    if (!enabled) return null;

    const dbPath =
      process.env?.COMMANDER_LOG_DB_PATH ?? path.join(process.cwd(), '.commander_state', 'logs.db');

    globalLogPersistence = new LogPersistence(dbPath);
    globalLogPersistence.start();
  }
  return globalLogPersistence;
}
