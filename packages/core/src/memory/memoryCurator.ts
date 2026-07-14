import type { MemoryStore } from '../episodicMemory';

export interface MemoryCuratorConfig {
  /** Run interval in milliseconds (default: 5 minutes) */
  intervalMs: number;
  /** Whether to also decay long-term memories based on lastAccessedAt */
  enableLongTermDecay: boolean;
  /** Long-term memory inactivity threshold in days (default: 90) */
  longTermInactivityDays: number;
}

export const DEFAULT_CURATOR_CONFIG: MemoryCuratorConfig = {
  intervalMs: 5 * 60 * 1000,
  enableLongTermDecay: true,
  longTermInactivityDays: 90,
};

/**
 * MemoryCurator is responsible for the "Manage" phase of the memory lifecycle:
 * deleting expired memories, decaying long-term memories that have not been
 * accessed for a configured threshold, and (in the future) triggering
 * compaction/summarization of dense episodic records.
 *
 * It operates against the canonical MemoryStore interface so it works across
 * InMemory, JSON, and SQLite backends without backend-specific logic.
 */
export class MemoryCurator {
  private store: MemoryStore;
  private config: MemoryCuratorConfig;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(store: MemoryStore, config?: Partial<MemoryCuratorConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_CURATOR_CONFIG, ...config };
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
  start(onTick?: (curator: MemoryCurator) => Promise<void> | void): void {
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
