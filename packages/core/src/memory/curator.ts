/**
 * Autonomous Memory Curator
 *
 * Self-managing memory system that autonomously curates, promotes, and prunes
 * memories based on usage patterns, importance signals, and decay. Inspired by
 * Hermes Agent's "closed learning loop" where the agent decides what to persist.
 *
 * Key behaviors:
 * - Importance re-evaluation based on access frequency and recency
 * - Decay-based eviction for episodic memories
 * - Duplicate detection and merging
 * - Layer promotion (episodic → long-term based on access patterns)
 * - Contradiction detection and resolution
 * - Periodic summarization of old memories
 * - Auto-tagging based on content analysis
 *
 * Runs as a background process triggered after N memory writes or on a timer.
 */

import { getGlobalLogger } from '../logging';
import type {
  MemoryStore, EpisodicMemoryItem, MemoryWriteOptions,
  MemorySearchQuery, MemorySearchResult, MemoryManageOptions, MemoryStats,
} from '../memory';

// ============================================================================
// Types
// ============================================================================

export interface CuratorConfig {
  /** Run curation after this many writes */
  curationInterval: number;
  /** Minimum similarity score to consider duplicates (0-1) */
  duplicateThreshold: number;
  /** Access count threshold for promotion to long-term */
  promotionAccessThreshold: number;
  /** Days before episodic memories are eviction candidates */
  episodicTtlDays: number;
  /** Maximum memories to process per curation run */
  batchSize: number;
  /** Enable automatic contradiction detection */
  detectContradictions: boolean;
  /** Enable automatic importance re-evaluation */
  reEvaluateImportance: boolean;
  /** Enable automatic duplicate merging */
  mergeDuplicates: boolean;
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

const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
  curationInterval: 50,         // Run every 50 writes
  duplicateThreshold: 0.85,     // 85% similarity = duplicate
  promotionAccessThreshold: 5,  // 5+ accesses promotes to long-term
  episodicTtlDays: 14,          // 14 days for episodic memories
  batchSize: 200,
  detectContradictions: true,
  reEvaluateImportance: true,
  mergeDuplicates: true,
};

// ============================================================================
// Autonomous Memory Curator
// ============================================================================

export class MemoryCurator {
  private config: CuratorConfig;
  private writeCount = 0;
  private lastCuration: CurationResult | null = null;
  private running = false;

  constructor(config?: Partial<CuratorConfig>) {
    this.config = { ...DEFAULT_CURATOR_CONFIG, ...config };
  }

  /**
   * Called after each memory write. Triggers curation when threshold is reached.
   * This is the "autonomous nudge" — the system decides when to curate.
   */
  async onWrite(store: MemoryStore, projectId: string): Promise<CurationResult | null> {
    this.writeCount++;
    if (this.writeCount >= this.config.curationInterval && !this.running) {
      return this.curate(store, projectId);
    }
    return null;
  }

  /**
   * Run a full curation cycle on the memory store.
   * Can be called explicitly or triggered automatically by onWrite().
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

      // Step 1: Evict expired episodic memories
      result.evicted = await this.evictExpired(store, projectId);

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
      result.processed = result.evicted + result.promoted + result.merged + result.importanceAdjusted;

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

  /**
   * Get the last curation result.
   */
  getLastCuration(): CurationResult | null {
    return this.lastCuration;
  }

  // --------------------------------------------------------------------------
  // Curation Steps
  // --------------------------------------------------------------------------

  /**
   * Evict expired episodic memories.
   */
  private async evictExpired(store: MemoryStore, projectId: string): Promise<number> {
    return store.deleteExpired(projectId);
  }

  /**
   * Re-evaluate importance scores based on multi-factor analysis.
   *
   * Factors:
   * - Recency of access: recently accessed = boost, stale = decay
   * - Age of memory: older memories with low access get faster decay
   * - Kind weighting: LESSON and DECISION memories are more resilient
   * - Confidence: high-confidence memories resist decay
   *
   * This implements a more sophisticated importance model than simple
   * access-count-based promotion, similar to how Generative Agents
   * handles memory importance over time.
   */
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

      // Factor 1: Recency-based adjustment
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

      // Factor 2: Kind-based resilience (LESSON and DECISION resist decay)
      if (item.kind === 'LESSON' || item.kind === 'DECISION') {
        // These memories are more valuable — reduce decay by 50%
        if (newPriority < item.priority) {
          newPriority = item.priority - Math.round((item.priority - newPriority) * 0.5);
        }
      }

      // Factor 3: High-confidence memories resist decay
      if (item.confidence >= 0.9 && newPriority < item.priority) {
        newPriority = item.priority - Math.round((item.priority - newPriority) * 0.7);
      }

      // Factor 4: Old memories with no recent access get accelerated decay
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

  /**
   * Promote frequently-accessed episodic memories to long-term.
   * This is the key "learning" behavior — the system recognizes valuable memories.
   */
  private async promoteAccessed(store: MemoryStore, projectId: string): Promise<number> {
    let promoted = 0;

    const result = await store.search({
      projectId,
      limit: this.config.batchSize,
    });

    for (const item of result.items) {
      // Only promote episodic memories
      if (item.duration !== 'EPISODIC') continue;

      // Check if accessed enough times to warrant promotion
      // We approximate access count from the time since creation and last access frequency
      const createdAt = new Date(item.createdAt).getTime();
      const lastAccess = new Date(item.lastAccessedAt).getTime();
      const ageDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
      const recencyDays = (Date.now() - lastAccess) / (1000 * 60 * 60 * 24);

      // High-priority + recently accessed = promote
      if (item.priority >= 80 && recencyDays < 3 && ageDays > 1) {
        await store.update({
          id: item.id,
          projectId,
          updates: {
            expiresAt: undefined, // Remove expiration for long-term
          },
        });
        promoted++;
      }

      // High-confidence lessons and decisions are always worth promoting
      if ((item.kind === 'LESSON' || item.kind === 'DECISION') && item.confidence >= 0.9) {
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

  /**
   * Detect and merge duplicate memories.
   * Uses content similarity (token overlap) to find duplicates.
   */
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
        // Keep the highest-priority item, merge metadata from others
        duplicates.sort((a, b) => b.priority - a.priority);
        const keeper = duplicates[0];
        const toMerge = duplicates.slice(1);

        // Merge tags and evidence refs
        const allTags = new Set(keeper.tags);
        const allEvidence = new Set(keeper.evidenceRefs ?? []);
        let maxConfidence = keeper.confidence;

        for (const dup of toMerge) {
          dup.tags.forEach((t: string) => allTags.add(t));
          (dup.evidenceRefs ?? []).forEach((e: string) => allEvidence.add(e));
          maxConfidence = Math.max(maxConfidence, dup.confidence);
          processed.add(dup.id);
        }

        // Update keeper with merged data
        await store.update({
          id: keeper.id,
          projectId,
          updates: {
            tags: Array.from(allTags),
            confidence: maxConfidence,
          },
        });

        // Delete duplicates
        for (const dup of toMerge) {
          await store.delete(dup.id, projectId);
          merged++;
        }
      }

      processed.add(items[i].id);
    }

    return merged;
  }

  /**
   * Detect contradictions between memories.
   * Flag memories that contradict each other for review.
   */
  private async detectContradictions(store: MemoryStore, projectId: string): Promise<number> {
    let contradictions = 0;

    const result = await store.search({
      projectId,
      kind: 'DECISION',
      limit: this.config.batchSize,
    });

    const decisions = result.items;

    // Compare decisions with same tags for contradictions
    for (let i = 0; i < decisions.length; i++) {
      for (let j = i + 1; j < decisions.length; j++) {
        // Only check decisions with overlapping tags
        const sharedTags = decisions[i].tags.filter(t => decisions[j].tags.includes(t));
        if (sharedTags.length === 0) continue;

        // Check for negation patterns
        if (this.detectNegation(decisions[i].content, decisions[j].content)) {
          // Lower confidence on the older/less-priority one
          const older = new Date(decisions[i].createdAt) < new Date(decisions[j].createdAt)
            ? decisions[i] : decisions[j];

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

  /**
   * Calculate text similarity using token overlap (Jaccard index).
   */
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

  /**
   * Tokenize text for similarity comparison.
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);
  }

  /**
   * Detect if two texts contradict each other.
   * Simple heuristic: look for negation patterns near similar content.
   */
  private detectNegation(a: string, b: string): boolean {
    const negationWords = ['not', "don't", "doesn't", "didn't", "won't", "shouldn't",
      "never", 'no', 'avoid', 'reject', 'deny', 'contradict', 'opposite'];

    const tokensA = this.tokenize(a);
    const tokensB = this.tokenize(b);

    const hasNegA = tokensA.some(t => negationWords.includes(t));
    const hasNegB = tokensB.some(t => negationWords.includes(t));

    // One has negation, the other doesn't, and they share significant content
    if (hasNegA !== hasNegB) {
      const similarity = this.calculateSimilarity(a, b);
      return similarity > 0.5; // High similarity + different negation = contradiction
    }

    return false;
  }

  private buildSummary(result: CurationResult): string {
    const parts: string[] = [];
    if (result.evicted > 0) parts.push(`${result.evicted} expired memories evicted`);
    if (result.promoted > 0) parts.push(`${result.promoted} memories promoted to long-term`);
    if (result.merged > 0) parts.push(`${result.merged} duplicates merged`);
    if (result.contradictionsFound > 0) parts.push(`${result.contradictionsFound} contradictions detected`);
    if (result.importanceAdjusted > 0) parts.push(`${result.importanceAdjusted} importance scores adjusted`);
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

// ============================================================================
// Singleton
// ============================================================================

let globalCurator: MemoryCurator | null = null;

export function getMemoryCurator(config?: Partial<CuratorConfig>): MemoryCurator {
  if (!globalCurator) {
    globalCurator = new MemoryCurator(config);
  }
  return globalCurator;
}
