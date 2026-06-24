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
export interface WalDbHandle {
    pragma(sql: string): unknown;
}
export type WalCheckpointMode = 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE';
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
export declare function walCheckpoint(db: WalDbHandle | null | undefined, mode?: WalCheckpointMode): number;
export interface WalCheckpointSchedulerConfig {
    /** Interval in ms between checkpoints (default: 300_000 = 5 minutes) */
    intervalMs: number;
    /** Checkpoint mode (default: TRUNCATE) */
    mode: WalCheckpointMode;
}
/**
 * Lightweight periodic WAL checkpoint scheduler for a single DB handle.
 *
 * The timer is unref'd so it does not prevent process exit.
 * Idempotent: start()/stop() can be called multiple times safely.
 */
export declare class WalCheckpointScheduler {
    private readonly db;
    private readonly config;
    private timer;
    constructor(db: WalDbHandle, config?: Partial<WalCheckpointSchedulerConfig>);
    /** Start the periodic checkpoint timer. Idempotent. */
    start(): void;
    /** Stop the periodic checkpoint timer. Idempotent. */
    stop(): void;
    /** Run a one-shot checkpoint immediately. */
    checkpointNow(): number;
    /** True if the periodic timer is active. */
    get isRunning(): boolean;
    /** Current interval in ms. */
    get intervalMs(): number;
}
