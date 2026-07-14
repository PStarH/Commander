/**
 * InMemoryCompensationQueue — test-friendly, native-module-free implementation
 * of the CompensationQueue interface.
 *
 * Mirrors the public API and behavior of the SQLite-backed CompensationQueue
 * but uses Map/array storage instead of better-sqlite3. This allows the
 * compensation-queue architecture tests to run in environments where the
 * better-sqlite3 native module cannot load (ABI mismatch, missing build
 * tools, etc.).
 *
 * Behavior parity with CompensationQueue:
 *   - enqueue(): persist a new pending compensation
 *   - claimNext(): atomically claim the next due pending item
 *   - markCompleted(): delete the item
 *   - markFailed(): schedule retry with exponential backoff, or escalate
 *   - markEscalated(): move to escalated state
 *   - retry(): reset an escalated item back to pending
 *   - get(): retrieve by id (tenant-scoped)
 *   - list(): list items (tenant-scoped, optional status filter)
 *   - countByStatus(): aggregate counts by status (tenant-scoped)
 *   - close(): mark instance as closed (data persists in module-level store
 *     for crash-recovery simulation)
 *
 * Cross-tenant isolation mirrors the SQL semantics:
 *   - No tenant context (null): all items visible
 *   - Tenant context active: only items with matching tenantId visible
 *
 * Crash recovery: the module-level store is keyed by filePath. Two
 * InMemoryCompensationQueue instances constructed with the same filePath
 * share the same data, mirroring SQLite file persistence across process
 * restarts.
 */

import { getCurrentTenantId } from '../runtime/tenantContext';
import type {
  CompensationQueueItem,
  CompensationQueueConfig,
  CompensationStatus,
} from './compensationQueue';

// Module-level shared store keyed by filePath. Two instances with the same
// filePath share data, mirroring SQLite file persistence.
const stores = new Map<string, Map<string, CompensationQueueItem>>();

export class InMemoryCompensationQueue {
  private config: Required<CompensationQueueConfig>;
  private items: Map<string, CompensationQueueItem>;
  private closed = false;

  constructor(config: Partial<CompensationQueueConfig> = {}) {
    this.config = {
      filePath: config.filePath ?? ':memory:',
      defaultMaxAttempts: config.defaultMaxAttempts ?? 10,
      backoffBaseMs: config.backoffBaseMs ?? 1000,
      backoffMaxMs: config.backoffMaxMs ?? 5 * 60 * 1000,
    };
    let store = stores.get(this.config.filePath);
    if (!store) {
      store = new Map();
      stores.set(this.config.filePath, store);
    }
    this.items = store;
  }

  /**
   * Tenant visibility check mirroring the SQL clause:
   *   WHERE (tenant_id IS ? OR ? IS NULL)
   * - currentTenant null  -> all items visible
   * - currentTenant 'X'   -> only items where tenantId === 'X'
   */
  private tenantVisible(item: CompensationQueueItem, currentTenant: string | null): boolean {
    if (currentTenant === null) return true;
    return item.tenantId === currentTenant;
  }

  enqueue(input: {
    id: string;
    runId: string;
    agentId?: string;
    tenantId?: string;
    toolName: string;
    args: unknown;
    compensationHandlerKey: string;
    maxAttempts?: number;
  }): void {
    if (this.closed) throw new Error('CompensationQueue not initialized');
    const now = new Date().toISOString();
    this.items.set(input.id, {
      id: input.id,
      runId: input.runId,
      agentId: input.agentId,
      tenantId: input.tenantId,
      toolName: input.toolName,
      args: JSON.stringify(input.args),
      compensationHandlerKey: input.compensationHandlerKey,
      attemptCount: 0,
      maxAttempts: input.maxAttempts ?? this.config.defaultMaxAttempts,
      status: 'pending',
      lastError: undefined,
      enqueuedAt: now,
      lastAttemptAt: undefined,
      nextAttemptAt: now,
    });
  }

  /**
   * Atomically claim the next due item for processing. Returns null if
   * no item is due. The atomic check prevents double-compensation in
   * multi-process scenarios (though in-memory is single-threaded).
   */
  claimNext(): CompensationQueueItem | null {
    if (this.closed) return null;
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const currentTenant = getCurrentTenantId() ?? null;

    const candidates = Array.from(this.items.values())
      .filter((item) => item.status === 'pending')
      .filter((item) => this.tenantVisible(item, currentTenant))
      .filter((item) => new Date(item.nextAttemptAt).getTime() <= nowMs)
      .sort((a, b) => new Date(a.nextAttemptAt).getTime() - new Date(b.nextAttemptAt).getTime());

    if (candidates.length === 0) return null;

    const item = candidates[0];
    // Guard against a race (faithful to the SQLite UPDATE ... WHERE status='pending')
    if (item.status !== 'pending') return null;

    item.status = 'in_progress';
    item.lastAttemptAt = now;
    item.attemptCount += 1;

    return { ...item };
  }

  markCompleted(id: string): void {
    if (this.closed) return;
    this.items.delete(id);
  }

  markFailed(id: string, error: string, currentAttempt: number): 'pending' | 'escalated' {
    if (this.closed) throw new Error('not initialized');
    // Tenant-scoped visibility check (matches SQLite behavior where
    // markFailed calls this.get(id) before updating).
    const visible = this.get(id);
    if (!visible) return 'escalated';

    const item = this.items.get(id);
    if (!item) return 'escalated';

    if (currentAttempt >= item.maxAttempts) {
      item.status = 'escalated';
      item.lastError = error;
      item.lastAttemptAt = new Date().toISOString();
      return 'escalated';
    }

    // Backoff: base * 2^(attempt-1), capped.
    const delay = Math.min(
      this.config.backoffBaseMs * Math.pow(2, currentAttempt - 1),
      this.config.backoffMaxMs,
    );
    item.status = 'pending';
    item.lastError = error;
    item.nextAttemptAt = new Date(Date.now() + delay).toISOString();
    item.lastAttemptAt = new Date().toISOString();
    return 'pending';
  }

  markEscalated(id: string, error: string): void {
    if (this.closed) return;
    const item = this.items.get(id);
    if (!item) return;
    item.status = 'escalated';
    item.lastError = error;
    item.lastAttemptAt = new Date().toISOString();
  }

  /**
   * Force-retry an escalated item. Resets attempt_count to 0 and
   * schedules immediate next attempt.
   */
  retry(id: string): boolean {
    if (this.closed) return false;
    const item = this.items.get(id);
    if (!item) return false;
    if (item.status !== 'escalated') return false;
    item.status = 'pending';
    item.lastError = undefined;
    item.nextAttemptAt = new Date().toISOString();
    item.attemptCount = 0;
    return true;
  }

  get(id: string): CompensationQueueItem | null {
    if (this.closed) return null;
    const currentTenant = getCurrentTenantId() ?? null;
    const item = this.items.get(id);
    if (!item) return null;
    if (!this.tenantVisible(item, currentTenant)) return null;
    return { ...item };
  }

  list(opts: { limit?: number; status?: CompensationStatus } = {}): CompensationQueueItem[] {
    if (this.closed) return [];
    const limit = opts.limit ?? 100;
    const currentTenant = getCurrentTenantId() ?? null;
    let result = Array.from(this.items.values()).filter((item) =>
      this.tenantVisible(item, currentTenant),
    );
    if (opts.status) {
      result = result.filter((item) => item.status === opts.status);
    }
    result.sort((a, b) => new Date(b.enqueuedAt).getTime() - new Date(a.enqueuedAt).getTime());
    return result.slice(0, limit).map((item) => ({ ...item }));
  }

  countByStatus(): Record<CompensationStatus, number> {
    if (this.closed) return { pending: 0, in_progress: 0, escalated: 0 };
    const currentTenant = getCurrentTenantId() ?? null;
    const result: Record<CompensationStatus, number> = {
      pending: 0,
      in_progress: 0,
      escalated: 0,
    };
    for (const item of this.items.values()) {
      if (!this.tenantVisible(item, currentTenant)) continue;
      result[item.status]++;
    }
    return result;
  }

  close(): void {
    // Mark as closed. Data persists in the module-level store keyed by
    // filePath, enabling crash-recovery simulation when a new instance is
    // created with the same filePath.
    this.closed = true;
  }

  /** Clear all stores (test utility for cleanup). */
  static resetAllStores(): void {
    stores.clear();
  }
}
