import type { MemoryStore } from '../episodicMemory';

export interface TtlMemoryCuratorConfig {
  /** Run interval in milliseconds (default: 5 minutes) */
  intervalMs: number;
  /** Whether to also decay long-term memories based on lastAccessedAt */
  enableLongTermDecay: boolean;
  /** Long-term memory inactivity threshold in days (default: 90) */
  longTermInactivityDays: number;
}

export const DEFAULT_TTL_CURATOR_CONFIG: TtlMemoryCuratorConfig = {
  intervalMs: 5 * 60 * 1000,
  enableLongTermDecay: true,
  longTermInactivityDays: 90,
};

/**
 * TtlMemoryCurator — TTL / inactivity expiry for the canonical MemoryStore.
 *
 * Distinct from `memory/curator.ts` `MemoryCurator` (autonomous duplicate/
 * quality curation for UnifiedMemory). Same name was a PRINCIPLES §3/§5 debt.
 *
 * Responsibilities: deleteExpired, optional long-term inactivity decay, periodic tick.
 * Works across InMemory, JSON, and SQLite MemoryStore backends.
 */
export class TtlMemoryCurator {
  private store: MemoryStore;
  private config: TtlMemoryCuratorConfig;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(store: MemoryStore, config?: Partial<TtlMemoryCuratorConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_TTL_CURATOR_CONFIG, ...config };
  }

  /** Run once for a specific project. Returns number of removed records. */
  async runForProject(projectId: string): Promise<number> {
    let removed = await this.store.deleteExpired(projectId);

    if (this.config.enableLongTermDecay) {
      removed += await this.applyLongTermDecay(projectId);
    }

    return removed;
  }

  private async applyLongTermDecay(projectId: string): Promise<number> {
    const threshold = new Date(
      Date.now() - this.config.longTermInactivityDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    // MemoryStore does not expose a list-by-duration API. We use a broad
    // search with minPriority=0 and filter in-memory. For very large stores
    // this can be replaced with a dedicated store.list({ duration }) call.
    const result = await this.store.search({ projectId, minPriority: 0, limit: 10000 });

    let removed = 0;
    for (const item of result.items) {
      if (item.duration === 'LONG_TERM' && item.lastAccessedAt < threshold) {
        await this.store.delete(item.id, projectId);
        removed++;
      }
    }

    return removed;
  }

  /** Start periodic curation. Callers should invoke runForProject per project inside the tick. */
  start(onTick?: (curator: TtlMemoryCurator) => Promise<void> | void): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      try {
        if (onTick) {
          await onTick(this);
        }
      } catch {
        // Silent best-effort periodic cleanup. Errors should be logged by caller.
      }
    }, this.config.intervalMs);
  }

  /** Stop periodic curation. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Release all resources. */
  close(): void {
    this.stop();
  }
}

/** @deprecated Use TtlMemoryCurator — kept for one transition window. */
export type MemoryCurator = TtlMemoryCurator;
/** @deprecated Use TtlMemoryCurator */
export const MemoryCurator = TtlMemoryCurator;
/** @deprecated Use DEFAULT_TTL_CURATOR_CONFIG */
export const DEFAULT_CURATOR_CONFIG = DEFAULT_TTL_CURATOR_CONFIG;
/** @deprecated Use TtlMemoryCuratorConfig */
export type MemoryCuratorConfig = TtlMemoryCuratorConfig;
