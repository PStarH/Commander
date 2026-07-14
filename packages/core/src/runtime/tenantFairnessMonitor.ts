/**
 * TenantFairnessMonitor — Jain fairness index tracking for per-tenant run
 * completion shares.
 *
 * Records run completion timestamps in a sliding 60-second window and exposes
 * Jain's fairness index plus per-tenant share metrics. When fairness drops,
 * callers can throttle high-share tenants to protect low-share tenants from
 * starvation.
 */

export class TenantFairnessMonitor {
  private history = new Map<string, number[]>();
  private readonly windowMs: number;

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
  }

  /**
   * Record that a run completed for the given tenant. The timestamp is stored
   * in a sliding window; older entries are evicted lazily.
   */
  recordCompletion(tenantId: string): void {
    const list = this.history.get(tenantId) ?? [];
    const now = Date.now();
    list.push(now);
    this.history.set(tenantId, list);
    this.prune(now);
  }

  /**
   * Return Jain's fairness index over the current window.
   * 1.0 = perfectly fair; lower values indicate higher skew.
   */
  getJainIndex(): number {
    const counts = this.getTenantCounts();
    if (counts.length === 0) return 1;
    const sum = counts.reduce((a, b) => a + b, 0);
    if (sum === 0) return 1;
    const sumSq = counts.reduce((a, b) => a + b * b, 0);
    return (sum * sum) / (counts.length * sumSq);
  }

  /**
   * Return the share of completed runs belonging to the given tenant in the
   * current window. Returns 0 if the tenant has no completions.
   */
  getTenantShare(tenantId: string): number {
    const total = this.getTotalCompletions();
    if (total === 0) return 0;
    return (this.history.get(tenantId)?.length ?? 0) / total;
  }

  /**
   * Return all tenant IDs that currently have completions in the window.
   */
  getActiveTenantIds(): string[] {
    return Array.from(this.history.keys());
  }

  /**
   * Return tenant IDs whose share exceeds the supplied threshold.
   * Useful for admission controllers that want to reject high-share tenants
   * when overall fairness degrades.
   */
  getThrottledTenants(threshold: number): string[] {
    if (threshold <= 0) return [];
    const result: string[] = [];
    for (const tenantId of this.history.keys()) {
      if (this.getTenantShare(tenantId) > threshold) {
        result.push(tenantId);
      }
    }
    return result;
  }

  /** Remove all recorded history. */
  reset(): void {
    this.history.clear();
  }

  private prune(now = Date.now()): void {
    for (const [tenantId, list] of this.history) {
      const filtered = list.filter((t) => now - t <= this.windowMs);
      if (filtered.length === 0) {
        this.history.delete(tenantId);
      } else {
        this.history.set(tenantId, filtered);
      }
    }
  }

  private getTenantCounts(): number[] {
    this.prune();
    return Array.from(this.history.values()).map((v) => v.length);
  }

  private getTotalCompletions(): number {
    return this.getTenantCounts().reduce((a, b) => a + b, 0);
  }
}

let defaultMonitor: TenantFairnessMonitor | null = null;

/** Return the process-default fairness monitor. */
export function getTenantFairnessMonitor(): TenantFairnessMonitor {
  if (!defaultMonitor) {
    defaultMonitor = new TenantFairnessMonitor();
  }
  return defaultMonitor;
}

/** Reset the process-default fairness monitor (helpful in tests). */
export function resetTenantFairnessMonitor(): void {
  defaultMonitor = null;
}
