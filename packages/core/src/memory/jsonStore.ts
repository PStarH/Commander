/**
 * JSON-file backed MemoryStore implementation.
 * Persists EpisodicMemoryItems to a JSON file on disk.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { getGlobalLogger } from '../logging';
import type {
  EpisodicMemoryItem,
  MemoryWriteOptions,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryManageOptions,
  MemoryStats,
  MemoryStore,
} from '../memory';
import type { MemoryKind, MemoryDuration } from '../memory';
import { BM25Scorer } from './ftsScorer';

/**
 * JSON-file backed MemoryStore for simple persistence.
 * Falls back gracefully when SQLite is unavailable.
 *
 * Uses BM25 scoring (Okapi BM25) for high-quality full-text search,
 * matching the search quality of SQLite FTS5.
 */
export class JsonMemoryStore implements MemoryStore {
  private items: Map<string, EpisodicMemoryItem> = new Map();
  private filePath: string;
  private nextId = 1;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  // BM25 scorer for full-text search (replaces basic inverted index)
  private bm25: BM25Scorer = new BM25Scorer();
  // Per-item token cache to avoid re-tokenizing on every search
  private tokenCache: Map<string, string[]> = new Map();
  private indexDirty = true;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          this.items.set(item.id, item);
          const num = parseInt(item.id.replace('memory-', ''), 10);
          if (!isNaN(num) && num >= this.nextId) this.nextId = num + 1;
        }
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        getGlobalLogger().debug('JsonMemoryStore', 'No existing memory file — starting empty');
      } else {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        getGlobalLogger().error(
          'JsonMemoryStore',
          'Failed to load memory file — data may be corrupted',
          errorObj,
        );
        throw err;
      }
    }
    // Rebuild inverted index after loading
    this.rebuildIndex();
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return;
    const path = await import('path');
    const dir = path.dirname(this.filePath);
    if (dir && dir !== '.') await mkdir(dir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(Array.from(this.items.values()), null, 2));
    this.dirty = false;
  }

  async write(options: MemoryWriteOptions): Promise<EpisodicMemoryItem> {
    // Auto-cleanup expired items periodically to prevent unbounded growth
    if (this.items.size > 0 && this.items.size % 100 === 0) {
      await this.deleteExpired(options.projectId || 'default');
    }

    const now = new Date().toISOString();
    const id = `memory-${this.nextId++}`;

    const kindPriority: Record<MemoryKind, number> = {
      DECISION: 80,
      ISSUE: 70,
      LESSON: 90,
      SUMMARY: 50,
    };
    let priority = options.priority ?? kindPriority[options.kind] ?? 50;
    if (options.missionId) priority += 5;
    if (options.agentId) priority += 5;
    if (options.evidenceRefs?.length) priority += Math.min(options.evidenceRefs.length * 5, 15);
    priority = Math.min(priority, 100);

    const item: EpisodicMemoryItem = {
      id,
      projectId: options.projectId,
      missionId: options.missionId,
      agentId: options.agentId,
      kind: options.kind,
      duration: options.duration ?? 'EPISODIC',
      title: options.title,
      content: options.content,
      tags: options.tags ?? [],
      priority,
      createdAt: now,
      lastAccessedAt: now,
      expiresAt:
        (options.duration ?? 'EPISODIC') === 'EPISODIC'
          ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
          : undefined,
      evidenceRefs: options.evidenceRefs,
      confidence: options.confidence ?? 0.8,
    };

    this.items.set(id, item);
    this.indexItem(item);
    this.dirty = true;
    await this.persist();
    return item;
  }

  async batchWrite(items: MemoryWriteOptions[]): Promise<EpisodicMemoryItem[]> {
    const results: EpisodicMemoryItem[] = [];
    for (const item of items) {
      const now = new Date().toISOString();
      const id = `memory-${this.nextId++}`;
      const kindPriority: Record<MemoryKind, number> = {
        DECISION: 80,
        ISSUE: 70,
        LESSON: 90,
        SUMMARY: 50,
      };
      let priority = item.priority ?? kindPriority[item.kind] ?? 50;
      if (item.missionId) priority += 5;
      if (item.agentId) priority += 5;
      if (item.evidenceRefs?.length) priority += Math.min(item.evidenceRefs.length * 5, 15);
      priority = Math.min(priority, 100);

      const entry: EpisodicMemoryItem = {
        id,
        projectId: item.projectId,
        missionId: item.missionId,
        agentId: item.agentId,
        kind: item.kind,
        duration: item.duration ?? 'EPISODIC',
        title: item.title,
        content: item.content,
        tags: item.tags ?? [],
        priority,
        createdAt: now,
        lastAccessedAt: now,
        expiresAt:
          (item.duration ?? 'EPISODIC') === 'EPISODIC'
            ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
            : undefined,
        evidenceRefs: item.evidenceRefs,
        confidence: item.confidence ?? 0.8,
      };
      this.items.set(id, entry);
      this.indexItem(entry);
      results.push(entry);
    }
    this.dirty = true;
    await this.persist();
    return results;
  }

  async update(options: MemoryManageOptions): Promise<EpisodicMemoryItem | null> {
    const item = this.items.get(options.id);
    if (!item || item.projectId !== options.projectId) return null;
    if (options.delete) {
      this.deindexItem(options.id);
      this.items.delete(options.id);
      this.dirty = true;
      await this.persist();
      return null;
    }
    if (options.updates) {
      this.deindexItem(options.id);
      // Security: Prevent prototype pollution by filtering dangerous keys.
      const safeUpdates = { ...options.updates };
      delete (safeUpdates as any).__proto__;
      delete (safeUpdates as any).constructor;
      delete (safeUpdates as any).prototype;
      Object.assign(item, safeUpdates);
      item.lastAccessedAt = new Date().toISOString();
      this.indexItem(item);
      this.dirty = true;
      await this.persist();
    }
    return item;
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const item = this.items.get(id);
    if (!item || item.projectId !== projectId) return false;
    this.deindexItem(id);
    this.items.delete(id);
    this.dirty = true;
    await this.persist();
    return true;
  }

  async deleteByMission(missionId: string, projectId: string): Promise<number> {
    let count = 0;
    for (const [id, item] of this.items) {
      if (item.projectId === projectId && item.missionId === missionId) {
        this.deindexItem(id);
        this.items.delete(id);
        count++;
      }
    }
    if (count > 0) {
      this.dirty = true;
      await this.persist();
    }
    return count;
  }

  async deleteExpired(projectId: string): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const [id, item] of this.items) {
      if (item.projectId === projectId && item.expiresAt && new Date(item.expiresAt) < now) {
        this.deindexItem(id);
        this.items.delete(id);
        count++;
      }
    }
    if (count > 0) {
      this.dirty = true;
      await this.persist();
    }
    return count;
  }

  async read(id: string, projectId: string): Promise<EpisodicMemoryItem | null> {
    const item = this.items.get(id);
    if (!item || item.projectId !== projectId) return null;
    item.lastAccessedAt = new Date().toISOString();
    this.dirty = true;
    this.schedulePersist();
    return item;
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist().catch((err) => {
        getGlobalLogger().warn('JsonMemoryStore', 'Deferred persist failed', {
          error: (err as Error)?.message,
        });
      });
    }, 2000);
    this.persistTimer.unref();
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
    // Use BM25 scorer to narrow candidates for text query
    let candidateIds: Set<string> | null = null;
    if (query.query) {
      if (this.indexDirty) this.rebuildIndex();
      const bm25Results = this.bm25.score(query.query, this.items.size);
      candidateIds = new Set(bm25Results.map((r) => r.id));
    }

    // Single-pass filter: combine all conditions to avoid intermediate array allocations
    const lowerQuery = query.query?.toLowerCase();
    const hasTags = query.tags && query.tags.length > 0;
    const results: EpisodicMemoryItem[] = [];

    for (const item of this.items.values()) {
      if (item.projectId !== query.projectId) continue;
      if (candidateIds && !candidateIds.has(item.id)) continue;
      if (query.kind && item.kind !== query.kind) continue;
      if (query.missionId && item.missionId !== query.missionId) continue;
      if (query.agentId && item.agentId !== query.agentId) continue;
      if (hasTags && !query.tags!.some((tag) => item.tags.includes(tag))) continue;
      if (query.minPriority !== undefined && item.priority < query.minPriority) continue;
      if (query.minConfidence !== undefined && item.confidence < query.minConfidence) continue;
      if (
        lowerQuery &&
        !item.title.toLowerCase().includes(lowerQuery) &&
        !item.content.toLowerCase().includes(lowerQuery)
      )
        continue;
      results.push(item);
    }

    // Sort by priority (descending) then by createdAt (descending, ISO string comparison)
    results.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      // ISO date strings are lexicographically comparable — no Date parsing needed
      return b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : 0;
    });

    const total = results.length;
    const limit = query.limit ?? 50;
    return { items: results.slice(0, limit), total, query };
  }

  /** Rebuild BM25 index from all items. Called lazily on first search. */
  private rebuildIndex(): void {
    this.bm25 = new BM25Scorer();
    this.tokenCache.clear();
    for (const [id, item] of this.items) {
      const fullText = `${item.title} ${item.content} ${item.tags.join(' ')}`;
      const fieldTexts = new Map<string, string>();
      fieldTexts.set('title', item.title);
      this.bm25.addDocument(id, fullText, fieldTexts);
      this.tokenCache.set(id, tokenize(item.title + ' ' + item.content));
    }
    this.indexDirty = false;
  }

  /** Add a single item to the BM25 index. */
  private indexItem(item: EpisodicMemoryItem): void {
    const fullText = `${item.title} ${item.content} ${item.tags.join(' ')}`;
    const fieldTexts = new Map<string, string>();
    fieldTexts.set('title', item.title);
    this.bm25.addDocument(item.id, fullText, fieldTexts);
    this.tokenCache.set(item.id, tokenize(item.title + ' ' + item.content));
  }

  /** Remove a single item from the BM25 index. */
  private deindexItem(id: string): void {
    this.bm25.removeDocument(id);
    this.tokenCache.delete(id);
  }

  async searchSemantic(
    query: string,
    projectId: string,
    limit = 10,
  ): Promise<EpisodicMemoryItem[]> {
    // Lazy rebuild index if dirty
    if (this.indexDirty) this.rebuildIndex();

    const projectItems = Array.from(this.items.values()).filter(
      (item) => item.projectId === projectId,
    );
    if (projectItems.length === 0) return [];

    // Use BM25 for high-quality full-text search
    const bm25Results = this.bm25.score(query, projectItems.length);
    const bm25ScoreMap = new Map(bm25Results.map((r) => [r.id, r.score]));

    // Score project items with BM25 + priority + confidence boost
    const scored: Array<{ item: EpisodicMemoryItem; score: number }> = [];
    for (const item of projectItems) {
      const bm25Score = bm25ScoreMap.get(item.id) ?? 0;
      // Combine BM25 score with priority and confidence
      // Formula: bm25 * (1 + priority/100) * (0.5 + confidence)
      const score = bm25Score * (1 + item.priority / 100) * (0.5 + item.confidence);
      if (score > 0) {
        scored.push({ item, score });
      }
    }

    // ISO string comparison — no Date parsing needed
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.item.createdAt < a.item.createdAt ? -1 : b.item.createdAt > a.item.createdAt ? 1 : 0;
    });

    return scored.slice(0, limit).map((s) => {
      s.item.lastAccessedAt = new Date().toISOString();
      return s.item;
    });
  }

  async getStats(projectId: string): Promise<MemoryStats> {
    const projectItems = Array.from(this.items.values()).filter(
      (item) => item.projectId === projectId,
    );
    const byKind: Record<MemoryKind, number> = { DECISION: 0, ISSUE: 0, LESSON: 0, SUMMARY: 0 };
    const byDuration: Record<MemoryDuration, number> = { EPISODIC: 0, LONG_TERM: 0 };
    const tagCounts = new Map<string, number>();
    let totalPriority = 0,
      totalConfidence = 0;
    let oldestItem: string | undefined, newestItem: string | undefined;

    for (const item of projectItems) {
      byKind[item.kind]++;
      byDuration[item.duration]++;
      totalPriority += item.priority;
      totalConfidence += item.confidence;
      for (const tag of item.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      if (!oldestItem || item.createdAt < oldestItem) oldestItem = item.createdAt;
      if (!newestItem || item.createdAt > newestItem) newestItem = item.createdAt;
    }

    return {
      totalItems: projectItems.length,
      byKind,
      byDuration,
      avgPriority: projectItems.length > 0 ? totalPriority / projectItems.length : 0,
      avgConfidence: projectItems.length > 0 ? totalConfidence / projectItems.length : 0,
      topTags: Array.from(tagCounts.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      oldestItem,
      newestItem,
    };
  }

  async close(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
  }
}

import { tokenize } from './tokenizer';
