/**
 * Memory Curator — single stack for TTL expiry + autonomous quality curation.
 *
 * Merges the former dual stack:
 * - TtlMemoryCurator (timer / deleteExpired / long-term inactivity decay)
 * - autonomous curator (importance, promotion, duplicate merge, contradictions)
 *
 * Trigger modes:
 * - Write-driven: onWrite() after N writes (UnifiedMemory)
 * - Explicit: curate() full cycle
 * - Lightweight TTL: runForProject() (deleteExpired + optional long-term decay)
 * - Periodic timer: start() / stop() / close() (ThreeLayerMemory)
 */

import { getGlobalLogger } from '../logging';
import type { MemoryStore, EpisodicMemoryItem } from '../episodicMemory';

// ============================================================================
// Types
// ============================================================================

export interface CuratorConfig {
  /** Run full curation after this many writes (autonomous path) */
  curationInterval: number;
  /** Minimum similarity score to consider duplicates (0-1) */
  duplicateThreshold: number;
  /** Access count threshold for promotion to long-term */
  promotionAccessThreshold: number;
  /** Days before episodic memories are eviction candidates (policy hint) */
  episodicTtlDays: number;
  /** Maximum memories to process per full curation run */
  batchSize: number;
  /** Enable automatic contradiction detection */
  detectContradictions: boolean;
  /** Enable automatic importance re-evaluation */
  reEvaluateImportance: boolean;
  /** Enable automatic duplicate merging */
  mergeDuplicates: boolean;
  /** Periodic timer interval in ms (default: 5 minutes) */
  intervalMs: number;
  /** Whether to decay long-term memories based on lastAccessedAt */
  enableLongTermDecay: boolean;
  /** Long-term memory inactivity threshold in days (default: 90) */
  longTermInactivityDays: number;
}

export interface CurationResult {
  timestamp: string;
  duration: number;
  processed: number;
  promoted: number;
  evicted: number;
  merged: number;
  contradictionsFound: number;
  importanceAdjusted: number;
  summary: string;
}

export interface CuratorMemoryItem extends EpisodicMemoryItem {
  accessFrequency?: number;
  lastCuratedAt?: string;
  curationCount?: number;
}

// ============================================================================
// Default Config
// ============================================================================

export const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
  curationInterval: 50,
  duplicateThreshold: 0.85,
  promotionAccessThreshold: 5,
  episodicTtlDays: 14,
  batchSize: 200,
  detectContradictions: true,
  reEvaluateImportance: true,
  mergeDuplicates: true,
  intervalMs: 5 * 60 * 1000,
  enableLongTermDecay: true,
  longTermInactivityDays: 90,
};

/** @deprecated Use DEFAULT_CURATOR_CONFIG */
export const DEFAULT_TTL_CURATOR_CONFIG = DEFAULT_CURATOR_CONFIG;

/** @deprecated Use CuratorConfig */
export type TtlMemoryCuratorConfig = CuratorConfig;

// ============================================================================
// Memory Curator (single stack)
// ============================================================================

function isMemoryStore(value: unknown): value is MemoryStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MemoryStore).deleteExpired === 'function' &&
    typeof (value as MemoryStore).search === 'function'
  );
}

export class MemoryCurator {
  private config: CuratorConfig;
  private store: MemoryStore | null = null;
  private writeCount = 0;
  private lastCuration: CurationResult | null = null;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param storeOrConfig Optional bound MemoryStore (ThreeLayer style) or config
   * @param config Optional config when first arg is a store
   */
  constructor(
    storeOrConfig?: MemoryStore | Partial<CuratorConfig>,
    config?: Partial<CuratorConfig>,
  ) {
    if (isMemoryStore(storeOrConfig)) {
      this.store = storeOrConfig;
      this.config = { ...DEFAULT_CURATOR_CONFIG, ...config };
    } else {
      this.config = { ...DEFAULT_CURATOR_CONFIG, ...storeOrConfig };
    }
  }

  /** Bind or replace the store used by TTL/timer paths. */
  setStore(store: MemoryStore | null): void {
    this.store = store;
  }

  // --------------------------------------------------------------------------
  // TTL / lightweight path (former TtlMemoryCurator)
  // --------------------------------------------------------------------------

  /**
   * Run TTL sweep for a project: deleteExpired + optional long-term inactivity decay.
   * Returns number of removed records.
   */
  async runForProject(projectId: string, store?: MemoryStore): Promise<number> {
    const s = this.resolveStore(store);
    let removed = await s.deleteExpired(projectId);

    if (this.config.enableLongTermDecay) {
      removed += await this.applyLongTermDecay(s, projectId);
    }

    return removed;
  }

  /**
   * Start periodic tick. If onTick is omitted and a store is bound, the tick
   * is a no-op shell (callers should pass onTick that invokes runForProject per
   * project — stores do not expose list-all-projects).
   */
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

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  close(): void {
    this.stop();
  }

  // --------------------------------------------------------------------------
  // Autonomous path (write-driven + full cycle)
  // --------------------------------------------------------------------------

  /**
   * Called after each memory write. Triggers full curation when threshold is reached.
   */
  async onWrite(store: MemoryStore, projectId: string): Promise<CurationResult | null> {
    this.writeCount++;
    if (this.writeCount >= this.config.curationInterval && !this.running) {
      return this.curate(store, projectId);
    }
    return null;
  }

  /**
   * Full curation cycle: TTL eviction, long-term decay, importance, promotion,
   * duplicate merge, contradiction detection.
   */
  async curate(store: MemoryStore, projectId: string): Promise<CurationResult> {
    if (this.running) {
      return this.lastCuration ?? this.emptyResult();
    }

    this.running = true;
    const startTime = Date.now();
    const result: CurationResult = {
      timestamp: new Date().toISOString(),
      duration: 0,
      processed: 0,
      promoted: 0,
      evicted: 0,
      merged: 0,
      contradictionsFound: 0,
      importanceAdjusted: 0,
      summary: '',
    };

    try {
      getGlobalLogger().info('MemoryCurator', 'Starting curation cycle', { projectId });

      // Step 1: TTL expiry + optional long-term inactivity decay
      result.evicted = await this.runForProject(projectId, store);

      // Step 2: Re-evaluate importance based on access patterns
      if (this.config.reEvaluateImportance) {
        result.importanceAdjusted = await this.reEvaluateImportance(store, projectId);
      }

      // Step 3: Promote frequently-accessed episodic memories to long-term
      result.promoted = await this.promoteAccessed(store, projectId);

      // Step 4: Detect and merge duplicates
      if (this.config.mergeDuplicates) {
        result.merged = await this.mergeDuplicates(store, projectId);
      }

      // Step 5: Detect contradictions
      if (this.config.detectContradictions) {
        result.contradictionsFound = await this.detectContradictions(store, projectId);
      }

      result.duration = Date.now() - startTime;
      result.summary = this.buildSummary(result);
      result.processed =
        result.evicted + result.promoted + result.merged + result.importanceAdjusted;

      this.lastCuration = result;
      this.writeCount = 0;

      getGlobalLogger().info('MemoryCurator', 'Curation complete', {
        duration: result.duration,
        evicted: result.evicted,
        promoted: result.promoted,
        merged: result.merged,
        contradictions: result.contradictionsFound,
      });

      return result;
    } catch (err) {
      getGlobalLogger().error('MemoryCurator', `Curation failed: ${(err as Error).message}`);
      result.duration = Date.now() - startTime;
      result.summary = `Curation failed: ${String(err)}`;
      return result;
    } finally {
      this.running = false;
    }
  }

  getLastCuration(): CurationResult | null {
    return this.lastCuration;
  }

  // --------------------------------------------------------------------------
  // Curation Steps
  // --------------------------------------------------------------------------

  private async applyLongTermDecay(store: MemoryStore, projectId: string): Promise<number> {
    const threshold = new Date(
      Date.now() - this.config.longTermInactivityDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const result = await store.search({
      projectId,
      minPriority: 0,
      limit: this.config.batchSize > 0 ? Math.max(this.config.batchSize, 10000) : 10000,
    });

    let removed = 0;
    for (const item of result.items) {
      if (item.duration === 'LONG_TERM' && item.lastAccessedAt < threshold) {
        await store.delete(item.id, projectId);
        removed++;
      }
    }

    return removed;
  }

  private async reEvaluateImportance(store: MemoryStore, projectId: string): Promise<number> {
    let adjusted = 0;

    const result = await store.search({
      projectId,
      limit: this.config.batchSize,
    });

    const now = Date.now();
    for (const item of result.items) {
      const lastAccess = new Date(item.lastAccessedAt).getTime();
      const createdAt = new Date(item.createdAt).getTime();
      const daysSinceAccess = (now - lastAccess) / (1000 * 60 * 60 * 24);
      const daysSinceCreation = (now - createdAt) / (1000 * 60 * 60 * 24);

      let newPriority = item.priority;

      if (daysSinceAccess < 1) {
        newPriority = Math.min(100, item.priority + 5);
      } else if (daysSinceAccess < 3) {
        newPriority = Math.min(100, item.priority + 3);
      } else if (daysSinceAccess < 7) {
        newPriority = Math.min(100, item.priority + 1);
      } else if (daysSinceAccess > 30) {
        newPriority = Math.max(0, item.priority - 10);
      } else if (daysSinceAccess > 14) {
        newPriority = Math.max(0, item.priority - 5);
      }

      if (item.kind === 'LESSON' || item.kind === 'DECISION') {
        if (newPriority < item.priority) {
          newPriority = item.priority - Math.round((item.priority - newPriority) * 0.5);
        }
      }

      if (item.confidence >= 0.9 && newPriority < item.priority) {
        newPriority = item.priority - Math.round((item.priority - newPriority) * 0.7);
      }

      if (daysSinceCreation > 60 && daysSinceAccess > 14) {
        newPriority = Math.max(0, newPriority - 5);
      }

      if (newPriority !== item.priority) {
        await store.update({
          id: item.id,
          projectId,
          updates: { priority: newPriority },
        });
        adjusted++;
      }
    }

    return adjusted;
  }

  private async promoteAccessed(store: MemoryStore, projectId: string): Promise<number> {
    let promoted = 0;

    const result = await store.search({
      projectId,
      limit: this.config.batchSize,
    });

    for (const item of result.items) {
      if (item.duration !== 'EPISODIC') continue;

      const createdAt = new Date(item.createdAt).getTime();
      const lastAccess = new Date(item.lastAccessedAt).getTime();
      const ageDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
      const recencyDays = (Date.now() - lastAccess) / (1000 * 60 * 60 * 24);

      if (item.priority >= 80 && recencyDays < 3 && ageDays > 1) {
        await store.update({
          id: item.id,
          projectId,
          updates: {
            expiresAt: undefined,
          },
        });
        promoted++;
      } else if ((item.kind === 'LESSON' || item.kind === 'DECISION') && item.confidence >= 0.9) {
        await store.update({
          id: item.id,
          projectId,
          updates: {
            expiresAt: undefined,
          },
        });
        promoted++;
      }
    }

    return promoted;
  }

  private async mergeDuplicates(store: MemoryStore, projectId: string): Promise<number> {
    let merged = 0;

    const result = await store.search({
      projectId,
      limit: this.config.batchSize,
    });

    const items = result.items;
    const processed = new Set<string>();

    for (let i = 0; i < items.length; i++) {
      if (processed.has(items[i].id)) continue;

      const duplicates: EpisodicMemoryItem[] = [items[i]];

      for (let j = i + 1; j < items.length; j++) {
        if (processed.has(items[j].id)) continue;
        if (items[i].kind !== items[j].kind) continue;

        const similarity = this.calculateSimilarity(items[i].content, items[j].content);
        if (similarity >= this.config.duplicateThreshold) {
          duplicates.push(items[j]);
        }
      }

      if (duplicates.length > 1) {
        duplicates.sort((a, b) => b.priority - a.priority);
        const keeper = duplicates[0];
        const toMerge = duplicates.slice(1);

        const allTags = new Set(keeper.tags);
        let maxConfidence = keeper.confidence;

        for (const dup of toMerge) {
          dup.tags.forEach((t: string) => allTags.add(t));
          maxConfidence = Math.max(maxConfidence, dup.confidence);
          processed.add(dup.id);
        }

        await store.update({
          id: keeper.id,
          projectId,
          updates: {
            tags: Array.from(allTags),
            confidence: maxConfidence,
          },
        });

        for (const dup of toMerge) {
          await store.delete(dup.id, projectId);
          merged++;
        }
      }

      processed.add(items[i].id);
    }

    return merged;
  }

  private async detectContradictions(store: MemoryStore, projectId: string): Promise<number> {
    let contradictions = 0;

    const result = await store.search({
      projectId,
      kind: 'DECISION',
      limit: this.config.batchSize,
    });

    const decisions = result.items;

    for (let i = 0; i < decisions.length; i++) {
      for (let j = i + 1; j < decisions.length; j++) {
        const sharedTags = decisions[i].tags.filter((t) => decisions[j].tags.includes(t));
        if (sharedTags.length === 0) continue;

        if (this.detectNegation(decisions[i].content, decisions[j].content)) {
          const older =
            new Date(decisions[i].createdAt) < new Date(decisions[j].createdAt)
              ? decisions[i]
              : decisions[j];

          await store.update({
            id: older.id,
            projectId,
            updates: {
              confidence: Math.max(0.1, older.confidence - 0.3),
              tags: [...older.tags, 'contradicted'],
            },
          });
          contradictions++;
        }
      }
    }

    return contradictions;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private resolveStore(store?: MemoryStore): MemoryStore {
    const s = store ?? this.store;
    if (!s) {
      throw new Error('MemoryCurator: no MemoryStore bound; pass store or construct with one');
    }
    return s;
  }

  private calculateSimilarity(a: string, b: string): number {
    const tokensA = new Set(this.tokenize(a));
    const tokensB = new Set(this.tokenize(b));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let intersection = 0;
    const tokensAArray = Array.from(tokensA);
    for (let i = 0; i < tokensAArray.length; i++) {
      if (tokensB.has(tokensAArray[i])) intersection++;
    }

    const union = tokensA.size + tokensB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);
  }

  private detectNegation(a: string, b: string): boolean {
    const negationWords = [
      'not',
      "don't",
      "doesn't",
      "didn't",
      "won't",
      "shouldn't",
      'never',
      'no',
      'avoid',
      'reject',
      'deny',
      'contradict',
      'opposite',
    ];

    const tokensA = this.tokenize(a);
    const tokensB = this.tokenize(b);

    const hasNegA = tokensA.some((t) => negationWords.includes(t));
    const hasNegB = tokensB.some((t) => negationWords.includes(t));

    if (hasNegA !== hasNegB) {
      const similarity = this.calculateSimilarity(a, b);
      return similarity > 0.5;
    }

    return false;
  }

  private buildSummary(result: CurationResult): string {
    const parts: string[] = [];
    if (result.evicted > 0) parts.push(`${result.evicted} expired memories evicted`);
    if (result.promoted > 0) parts.push(`${result.promoted} memories promoted to long-term`);
    if (result.merged > 0) parts.push(`${result.merged} duplicates merged`);
    if (result.contradictionsFound > 0)
      parts.push(`${result.contradictionsFound} contradictions detected`);
    if (result.importanceAdjusted > 0)
      parts.push(`${result.importanceAdjusted} importance scores adjusted`);
    if (parts.length === 0) return 'No curation actions needed';
    return parts.join('; ');
  }

  private emptyResult(): CurationResult {
    return {
      timestamp: new Date().toISOString(),
      duration: 0,
      processed: 0,
      promoted: 0,
      evicted: 0,
      merged: 0,
      contradictionsFound: 0,
      importanceAdjusted: 0,
      summary: 'No curation performed',
    };
  }
}

/** @deprecated Use MemoryCurator — kept for one transition window after Ttl merge. */
export const TtlMemoryCurator = MemoryCurator;
/** @deprecated Use MemoryCurator */
export type TtlMemoryCurator = MemoryCurator;

// ============================================================================
// Singleton (UnifiedMemory write-driven path)
// ============================================================================

let globalCurator: MemoryCurator | null = null;

export function getMemoryCurator(config?: Partial<CuratorConfig>): MemoryCurator {
  if (!globalCurator) {
    globalCurator = new MemoryCurator(config);
  }
  return globalCurator;
}

/** Test helper: reset singleton between suites. */
export function resetMemoryCurator(): void {
  globalCurator?.close();
  globalCurator = null;
}
