/**
 * walCheckpoint — lightweight WAL checkpoint utility for better-sqlite3 stores.
 *
 * Motivation: all 11+ Commander SQLite stores run with `journal_mode = WAL`
 * and `synchronous = NORMAL`. Under write-heavy workloads the WAL file grows
 * unbounded, consuming disk and degrading read performance.
 *
 * This module provides:
 *   1. `walCheckpoint(db)` — one-shot PRAGMA wal_checkpoint(TRUNCATE)
 *   2. `WalCheckpointScheduler` — wraps a DB handle with a periodic timer
 *
 * Usage:
 *   import { walCheckpoint, WalCheckpointScheduler } from './storage/walCheckpoint';
 *
 *   // At store close():
 *   close(): void {
 *     walCheckpoint(this.db);   // <-- add before this.db.close()
 *     this.db?.close();
 *   }
 *
 *   // For periodic checkpointing during long-lived runs:
 *   this.checkpointer = new WalCheckpointScheduler(this.db, 300_000); // 5min
 *   this.checkpointer.start();
 *   // ... on close:
 *   this.checkpointer.stop();
 *   this.db?.close();
 */
/**
 * Run PRAGMA wal_checkpoint on a database handle.
 *
 * Mode semantics (SQLite docs):
 *   PASSIVE  — checkpoint as much as possible without blocking (may not help)
 *   FULL     — blocks writes, checkpoints all frames (default)
 *   RESTART  — like FULL + flushes WAL so readers re-open (rarely needed)
 *   TRUNCATE — like FULL + truncates WAL to minimum size (best for disk reclaim)
 *
 * Returns the number of checkpointed frames, or -1 if the checkpoint failed.
 * Never throws — failures are logged and swallowed so callers don't need to
 * guard every close().
 */
export function walCheckpoint(db, mode = 'TRUNCATE') {
    if (!db)
        return -1;
    try {
        const result = db.pragma(`wal_checkpoint(${mode})`);
        // result comes back as [number, number, number] — [journalPages, ckptPages, errCode]
        if (Array.isArray(result) && result.length >= 3) {
            return result[2] === 0 ? result[1] : -1;
        }
        return 0;
    }
    catch {
        // Silently swallow — checkpoint is best-effort during close()
        return -1;
    }
}
const DEFAULT_SCHEDULER_CONFIG = {
    intervalMs: 300_000,
    mode: 'TRUNCATE',
};
/**
 * Lightweight periodic WAL checkpoint scheduler for a single DB handle.
 *
 * The timer is unref'd so it does not prevent process exit.
 * Idempotent: start()/stop() can be called multiple times safely.
 */
export class WalCheckpointScheduler {
    db;
    config;
    timer = null;
    constructor(db, config) {
        this.db = db;
        this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    }
    /** Start the periodic checkpoint timer. Idempotent. */
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            walCheckpoint(this.db, this.config.mode);
        }, this.config.intervalMs);
        if (typeof this.timer === 'object' && typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    }
    /** Stop the periodic checkpoint timer. Idempotent. */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /** Run a one-shot checkpoint immediately. */
    checkpointNow() {
        return walCheckpoint(this.db, this.config.mode);
    }
    /** True if the periodic timer is active. */
    get isRunning() {
        return this.timer !== null;
    }
    /** Current interval in ms. */
    get intervalMs() {
        return this.config.intervalMs;
    }
}
