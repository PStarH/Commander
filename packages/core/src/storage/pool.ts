/**
 * StoragePool — tracks open SQLite database handles across the Commander
 * process and provides coordinated WAL checkpointing and graceful shutdown.
 *
 * Motivation: Commander opens 10+ separate better-sqlite3 connections
 * (ATR checkpoints, runtime checkpoints, memory stores, work queues, etc.)
 * each with independent WAL mode. Without coordination:
 *   - WAL files on separate databases grow independently
 *   - Graceful shutdown cannot checkpoint all databases
 *   - No single view of active connections exists
 *
 * Usage:
 *   import { pool } from './storage/pool';
 *
 *   // Register on open:
 *   pool.register('checkpoints', this.db);
 *
 *   // Unregister on close:
 *   pool.unregister('checkpoints');
 *
 *   // On graceful shutdown:
 *   pool.checkpointAll();
 *   pool.closeAll();
 */

import { walCheckpoint, type WalDbHandle } from './walCheckpoint';

// ============================================================================
// Pool entry
// ============================================================================

export interface PoolEntry {
  /** Human-readable label (store name or file path) */
  label: string;
  /** Database handle */
  db: WalDbHandle;
  /** Registration timestamp */
  registeredAt: string;
}

// ============================================================================
// StoragePool
// ============================================================================

export class StoragePool {
  private readonly entries = new Map<string, PoolEntry>();

  /**
   * Register a database handle under a unique label.
   * If the label already exists, the old entry is replaced (the caller is
   * responsible for closing the previous handle).
   */
  register(label: string, db: WalDbHandle): void {
    this.entries.set(label, {
      label,
      db,
      registeredAt: new Date().toISOString(),
    });
  }

  /**
   * Unregister a handle by label. Does NOT close the handle — the caller
   * owns the close lifecycle.
   */
  unregister(label: string): boolean {
    return this.entries.delete(label);
  }

  /** Get a registered handle by label. */
  get(label: string): WalDbHandle | undefined {
    return this.entries.get(label)?.db;
  }

  /** Number of registered handles. */
  get size(): number {
    return this.entries.size;
  }

  /** Iterate all registered entries. */
  entriesIter(): IterableIterator<PoolEntry> {
    return this.entries.values();
  }

  /** Run WAL checkpoint on all registered handles. Best-effort per handle. */
  checkpointAll(): void {
    for (const [label, entry] of this.entries) {
      walCheckpoint(entry.db);
    }
  }

  /**
   * Close all registered handles. See checkpointAll for WAL flush;
   * callers should typically call checkpointAll() before closeAll().
   *
   * After closeAll(), the pool is cleared. Handles are closed regardless
   * of errors (best-effort per handle).
   */
  closeAll(): void {
    for (const [label, entry] of this.entries) {
      try {
        entry.db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // best-effort
      }
      try {
        (entry.db as { close?: () => void }).close?.();
      } catch {
        // best-effort
      }
    }
    this.entries.clear();
  }

  /** Get a diagnostic summary of all registered handles. */
  describe(): Array<{ label: string; registeredAt: string }> {
    return Array.from(this.entries.values()).map((e) => ({
      label: e.label,
      registeredAt: e.registeredAt,
    }));
  }
}

// ============================================================================
// Process-global singleton
// ============================================================================

export const pool = new StoragePool();
