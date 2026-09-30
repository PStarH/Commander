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
 * Behavior parity with CompensationQueue (AR-03):
 *   - enqueue(): persist a new pending compensation bound to the ambient
 *     (authenticated) tenant; a duplicate id raises, exactly like the SQLite
 *     PRIMARY KEY conflict
 *   - claimNext(): reap expired claims for reconciliation, then atomically
 *     claim the next due pending item for the authenticated tenant, stamping
 *     a monotonic claim generation and a bounded claim expiry
 *   - markCompleted(): CAS on (tenant, generation, in_progress), keeps a
 *     minimal receipt for idempotency + audit
 *   - markFailed(): CAS-scheduled retry with exponential backoff, or escalate
 *   - markEscalated(): CAS move to escalated state
 *   - retry(): reset an escalated item back to pending (explicit tenant)
 *   - get()/list()/countByStatus()/getReceipt(): tenant-scoped; no tenant
 *     context means no rows, never every tenant's rows
 *   - close(): refuse every later operation explicitly
 *
 * Store isolation mirrors SQLite `:memory:` semantics: the default store is
 * PRIVATE to the instance. Only instances constructed with the same explicit
 * `filePath` share state (the crash-recovery simulation).
 *
 * This double is a test convenience, not proof of SQLite persistence or of
 * multi-process contention: real durability/competition must be verified
 * against the SQLite implementation.
 */

import { getCurrentTenantId } from '../runtime/tenantContext';
import type {
  CompensationClaim,
  CompensationQueueItem,
  CompensationQueueConfig,
  CompensationReceipt,
  CompensationStatus,
  CompensationWriteOutcome,
} from './compensationQueue';
import { CLAIM_EXPIRED_REASON } from './compensationQueue';

interface InMemoryStore {
  items: Map<string, CompensationQueueItem>;
  receipts: Map<string, CompensationReceipt>;
}

// Module-level shared stores keyed by an explicit filePath. A `:memory:`
// store is per-instance (private), matching SQLite's per-connection
// in-memory database.
const stores = new Map<string, InMemoryStore>();
let privateStoreCounter = 0;

function emptyStore(): InMemoryStore {
  return { items: new Map(), receipts: new Map() };
}

function receiptKey(id: string, tenantId: string): string {
  return `${tenantId}\u0000${id}`;
}

export class InMemoryCompensationQueue {
  private config: Required<CompensationQueueConfig>;
  private store: InMemoryStore;
  private closed = false;

  constructor(config: Partial<CompensationQueueConfig> = {}) {
    const filePath = config.filePath ?? ':memory:';
    this.config = {
      filePath,
      defaultMaxAttempts: config.defaultMaxAttempts ?? 10,
      backoffBaseMs: config.backoffBaseMs ?? 1000,
      backoffMaxMs: config.backoffMaxMs ?? 5 * 60 * 1000,
      claimTtlSeconds: config.claimTtlSeconds ?? 60,
    };
    // `:memory:` (the default) is private to this instance, mirroring SQLite.
    const storeKey = filePath === ':memory:' ? `:memory:${++privateStoreCounter}` : filePath;
    let store = stores.get(storeKey);
    if (!store) {
      store = emptyStore();
      stores.set(storeKey, store);
    }
    this.store = store;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('CompensationQueue is closed: further operations are refused');
    }
  }

  private currentTenant(): string | null {
    return getCurrentTenantId() ?? null;
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
    this.assertOpen();
    const owner = this.currentTenant();
    if (!owner) {
      throw new Error(
        'CompensationQueue.enqueue refused: no authenticated tenant context to bind the owner',
      );
    }
    if (input.tenantId && input.tenantId !== owner) {
      throw new Error(
        `CompensationQueue.enqueue refused: input.tenantId (${input.tenantId}) does not match the authenticated tenant (${owner})`,
      );
    }
    // Duplicate ids raise, exactly like the SQLite PRIMARY KEY conflict
    // (the previous Map.set silently overwrote — a memory/SQLite divergence).
    if (this.store.items.has(input.id)) {
      throw new Error(`CompensationQueue.enqueue refused: duplicate id ${input.id}`);
    }
    const now = new Date().toISOString();
    this.store.items.set(input.id, {
      id: input.id,
      runId: input.runId,
      agentId: input.agentId,
      tenantId: owner,
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
      claimGeneration: 0,
      claimExpiresAt: undefined,
    });
  }

  /**
   * Atomically claim the next due item for the authenticated tenant. Expired
   * in-progress claims are escalated for reconciliation first — never
   * replayed.
   */
  claimNext(): CompensationQueueItem | null {
    this.assertOpen();
    const tenantId = this.currentTenant();
    if (!tenantId) return null;
    const now = new Date();
    const nowIso = now.toISOString();

    for (const item of this.store.items.values()) {
      if (item.tenantId !== tenantId) continue;
      if (item.status !== 'in_progress') continue;
      if (item.claimExpiresAt && new Date(item.claimExpiresAt).getTime() <= now.getTime()) {
        item.status = 'escalated';
        item.lastError = CLAIM_EXPIRED_REASON;
        item.lastAttemptAt = nowIso;
        item.claimExpiresAt = undefined;
      }
    }

    const candidates = Array.from(this.store.items.values())
      .filter((item) => item.tenantId === tenantId && item.status === 'pending')
      .filter((item) => new Date(item.nextAttemptAt).getTime() <= now.getTime())
      .sort((a, b) => new Date(a.nextAttemptAt).getTime() - new Date(b.nextAttemptAt).getTime());

    if (candidates.length === 0) return null;

    const item = candidates[0];
    // Guard against a race (faithful to the SQLite UPDATE ... WHERE status='pending')
    if (item.status !== 'pending') return null;

    item.status = 'in_progress';
    item.lastAttemptAt = nowIso;
    item.attemptCount += 1;
    item.claimGeneration += 1;
    item.claimExpiresAt = new Date(
      now.getTime() + this.config.claimTtlSeconds * 1000,
    ).toISOString();

    return { ...item };
  }

  markCompleted(id: string, claim: CompensationClaim): boolean;
  /** @deprecated Legacy shape without a claim is refused — it carries no ownership. */
  markCompleted(id: string): boolean;
  markCompleted(id: string, claim?: CompensationClaim): boolean {
    this.assertOpen();
    if (!isClaim(claim)) return false;
    const item = this.store.items.get(id);
    if (
      item &&
      item.tenantId === claim.tenantId &&
      item.status === 'in_progress' &&
      item.claimGeneration === claim.claimGeneration
    ) {
      this.store.receipts.set(receiptKey(id, claim.tenantId), {
        id,
        tenantId: claim.tenantId,
        runId: item.runId,
        claimGeneration: claim.claimGeneration,
        completedAt: new Date().toISOString(),
      });
      this.store.items.delete(id);
      return true;
    }
    // Already completed by this tenant → idempotent success; anything else refused.
    return this.store.receipts.has(receiptKey(id, claim.tenantId));
  }

  markFailed(id: string, error: string, claim: CompensationClaim): CompensationWriteOutcome;
  /** @deprecated Legacy shape without a claim is refused — it carries no ownership. */
  markFailed(id: string, error: string, currentAttempt: number): CompensationWriteOutcome;
  markFailed(
    id: string,
    error: string,
    claim?: CompensationClaim | number,
  ): CompensationWriteOutcome {
    this.assertOpen();
    if (!isClaim(claim)) return 'refused';
    const item = this.store.items.get(id);
    if (
      !item ||
      item.tenantId !== claim.tenantId ||
      item.status !== 'in_progress' ||
      item.claimGeneration !== claim.claimGeneration
    ) {
      return 'refused';
    }

    const nowIso = new Date().toISOString();
    if (item.attemptCount >= item.maxAttempts) {
      item.status = 'escalated';
      item.lastError = error;
      item.lastAttemptAt = nowIso;
      item.claimExpiresAt = undefined;
      return 'escalated';
    }

    // Backoff: base * 2^(attempt-1), capped.
    const delay = Math.min(
      this.config.backoffBaseMs * Math.pow(2, item.attemptCount - 1),
      this.config.backoffMaxMs,
    );
    item.status = 'pending';
    item.lastError = error;
    item.nextAttemptAt = new Date(Date.now() + delay).toISOString();
    item.lastAttemptAt = nowIso;
    item.claimExpiresAt = undefined;
    return 'pending';
  }

  markEscalated(id: string, error: string, claim: CompensationClaim): boolean;
  /** @deprecated Legacy shape without a claim is refused — it carries no ownership. */
  markEscalated(id: string, error: string): boolean;
  markEscalated(id: string, error: string, claim?: CompensationClaim): boolean {
    this.assertOpen();
    if (!isClaim(claim)) return false;
    const item = this.store.items.get(id);
    if (
      !item ||
      item.tenantId !== claim.tenantId ||
      item.status !== 'in_progress' ||
      item.claimGeneration !== claim.claimGeneration
    ) {
      return false;
    }
    item.status = 'escalated';
    item.lastError = error;
    item.lastAttemptAt = new Date().toISOString();
    item.claimExpiresAt = undefined;
    return true;
  }

  /**
   * Force-retry an escalated item for an explicit tenant. Resets
   * attempt_count to 0 and schedules an immediate next attempt.
   */
  retry(id: string, tenantId: string): boolean;
  /** @deprecated Legacy shape without a tenant is refused — no implicit admin. */
  retry(id: string): boolean;
  retry(id: string, tenantId?: string): boolean {
    this.assertOpen();
    if (!tenantId) return false;
    const item = this.store.items.get(id);
    if (!item || item.tenantId !== tenantId || item.status !== 'escalated') return false;
    item.status = 'pending';
    item.lastError = undefined;
    item.nextAttemptAt = new Date().toISOString();
    item.attemptCount = 0;
    item.claimExpiresAt = undefined;
    return true;
  }

  get(id: string): CompensationQueueItem | null {
    this.assertOpen();
    const tenantId = this.currentTenant();
    if (!tenantId) return null;
    const item = this.store.items.get(id);
    if (!item || item.tenantId !== tenantId) return null;
    return { ...item };
  }

  getReceipt(id: string): CompensationReceipt | null {
    this.assertOpen();
    const tenantId = this.currentTenant();
    if (!tenantId) return null;
    const receipt = this.store.receipts.get(receiptKey(id, tenantId));
    return receipt ? { ...receipt } : null;
  }

  list(opts: { limit?: number; status?: CompensationStatus } = {}): CompensationQueueItem[] {
    this.assertOpen();
    const tenantId = this.currentTenant();
    if (!tenantId) return [];
    const limit = opts.limit ?? 100;
    let result = Array.from(this.store.items.values()).filter((item) => item.tenantId === tenantId);
    if (opts.status) {
      result = result.filter((item) => item.status === opts.status);
    }
    result.sort((a, b) => new Date(b.enqueuedAt).getTime() - new Date(a.enqueuedAt).getTime());
    return result.slice(0, limit).map((item) => ({ ...item }));
  }

  countByStatus(): Record<CompensationStatus, number> {
    this.assertOpen();
    const result: Record<CompensationStatus, number> = {
      pending: 0,
      in_progress: 0,
      escalated: 0,
    };
    const tenantId = this.currentTenant();
    if (!tenantId) return result;
    for (const item of this.store.items.values()) {
      if (item.tenantId !== tenantId) continue;
      result[item.status]++;
    }
    return result;
  }

  close(): void {
    // Mark as closed and refuse later operations. Data persists in the
    // module-level store keyed by filePath, enabling crash-recovery
    // simulation when a new instance is created with the same filePath.
    this.closed = true;
  }

  /** Clear all stores (test utility for cleanup). */
  static resetAllStores(): void {
    stores.clear();
  }
}

function isClaim(value: CompensationClaim | number | undefined): value is CompensationClaim {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CompensationClaim).tenantId === 'string' &&
    (value as CompensationClaim).tenantId.length > 0 &&
    typeof (value as CompensationClaim).claimGeneration === 'number'
  );
}
