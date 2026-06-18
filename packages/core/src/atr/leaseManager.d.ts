/**
 * LeaseManager — P0-2 ATR kernel component.
 *
 * Process fencing for run ownership. When a process acquires a lease for a
 * runId, it gets back a token + a monotonic fencing epoch. Any resume / mutate
 * operation must present the matching token, AND the stored epoch must be
 * monotonically increasing. A zombie process that resumes with a stale epoch
 * is rejected (fenced).
 *
 * Why this matters: process A starts a run, gets epoch 5, crashes mid-execution.
 * Process B picks up the run, gets epoch 6. When process A's death-throes try
 * to write a checkpoint, the epoch check fails and the write is rejected.
 *
 * Persistence: SQLite-backed so leases survive process restarts. Multi-process
 * scenarios (e.g. a worker pool sharing the same DB file) get true fencing.
 * Single-process scenarios get a fast in-process path that falls through to
 * SQLite on contention.
 *
 * Tenancy: leases are namespaced by tenantId (the SQLite row key is
 *   SHA256(tenantId || "::" || runId)
 * ), so tenant A cannot reclaim tenant B's lease.
 */
import type { RunLease } from './types';
export interface LeaseManagerConfig {
    filePath: string;
    /** Lease TTL in seconds — after this, a lease is considered expired and reclaimable */
    defaultTtlSeconds: number;
    /** Default holder label if caller does not provide one */
    defaultHolder: string;
}
/**
 * Outcome of an acquire attempt.
 *
 *  - acquired=true  → fresh lease, caller is the new owner
 *  - acquired=false → existing live lease; inspect `lease` to see who owns it
 */
export interface AcquireResult {
    acquired: boolean;
    lease: RunLease;
    /** True if the previous lease had expired and was reclaimed */
    reclaimed?: boolean;
}
export declare class LeaseManager {
    private db;
    private config;
    /** In-process cache: token → epoch. Faster than SQLite for heartbeat calls. */
    private inProcess;
    private stmtGet;
    private stmtInsert;
    private stmtHeartbeat;
    private stmtBumpEpoch;
    private stmtRelease;
    private stmtEvictExpired;
    constructor(config?: Partial<LeaseManagerConfig>);
    private openDb;
    private prepareStatements;
    /**
     * Acquire a lease for a run. If the run is not leased, returns a fresh lease.
     * If the run is already leased, returns the existing lease with `acquired=false`
     * (unless the existing lease has expired, in which case it is reclaimed and
     * `acquired=true` is returned with `reclaimed=true`).
     *
     * Reclamation bumps the fencing epoch, invalidating any tokens a zombie
     * process might still hold.
     */
    acquire(runId: string, options?: {
        tenantId?: string;
        holder?: string;
        ttlSeconds?: number;
    }): AcquireResult;
    /**
     * Refresh a lease's expiry. Returns true if the heartbeat succeeded; false
     * if the lease was lost (token mismatch / fenced / evicted).
     */
    heartbeat(runId: string, token: string, options?: {
        tenantId?: string;
        ttlSeconds?: number;
    }): boolean;
    /**
     * Release a lease. Returns true if it was actually held by this token.
     */
    release(runId: string, token: string, options?: {
        tenantId?: string;
    }): boolean;
    /**
     * Validate that a (token, epoch) pair is still the current owner of a run.
     * Returns the live lease if valid; null if the caller is fenced (stale epoch)
     * or the lease has been released / evicted.
     */
    validate(runId: string, token: string, expectedEpoch: number, options?: {
        tenantId?: string;
    }): RunLease | null;
    /** Garbage-collect expired leases. */
    evict(): number;
    /** Look up the current lease for a run (if any). Does not validate. */
    get(runId: string, options?: {
        tenantId?: string;
    }): RunLease | null;
    close(): void;
    private cacheKey;
}
//# sourceMappingURL=leaseManager.d.ts.map