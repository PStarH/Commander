/**
 * JSON-file backed MemoryStore implementation.
 * Persists EpisodicMemoryItems to a JSON file on disk.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'node:path';
import { atomicWriteFile } from '../runtime/atomicWrite';
import { getGlobalLogger } from '../logging';
import { getCurrentTenantId } from '../runtime/tenantContext';
import type {
  EpisodicMemoryItem,
  MemoryWriteOptions,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryManageOptions,
  MemoryStats,
  MemoryStore,
} from '../episodicMemory';
import type { MemoryKind, MemoryDuration } from '../episodicMemory';
import { BM25Scorer } from './ftsScorer';

/**
 * Per-project in-memory cache. In multi-tenant mode each (tenant, project)
 * pair gets its own file; in legacy single-file mode all projects share one
 * cache backed by the constructor-provided file path.
 */
interface ProjectCache {
  items: Map<string, EpisodicMemoryItem>;
  filePath: string;
  nextId: number;
  bm25: BM25Scorer;
  tokenCache: Map<string, string[]>;
  indexDirty: boolean;
  dirty: boolean;
  loaded: boolean;
}

/**
 * JSON-file backed MemoryStore for simple persistence.
 * Falls back gracefully when SQLite is unavailable.
 *
 * Uses BM25 scoring (Okapi BM25) for high-quality full-text search,
 * matching the search quality of SQLite FTS5.
 *
 * Tenant isolation:
 *   - When constructed with a directory path, files are stored under
 *     <baseDir>/tenant_<tenantId>/projects/<projectId>/memories.jsonl
 *   - When constructed with a .json/.jsonl file path, the store operates in
 *     legacy single-file mode for backward compatibility with existing tests.
 */
export class JsonMemoryStore implements MemoryStore {
  private baseDataPath: string;
  private legacyFilePath: string | null = null;
  private caches: Map<string, ProjectCache> = new Map();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePathOrDataDir: string) {
    this.baseDataPath = filePathOrDataDir;
    if (filePathOrDataDir.endsWith('.json') || filePathOrDataDir.endsWith('.jsonl')) {
      this.legacyFilePath = filePathOrDataDir;
    }
    // Index is rebuilt lazily per project cache after load (see loadProjectCache).
  }

  async init(): Promise<void> {
    if (this.legacyFilePath) {
      const cache = this.getProjectCache('__legacy__', this.legacyFilePath);
      await this.loadProjectCache(cache);
      return;
    }
    // In tenant mode directories are created lazily per project.
  }

  private getTenantId(): string {
    return getCurrentTenantId() ?? '__default__';
  }

  private cacheKey(projectId: string): string {
    return `${this.getTenantId()}|${projectId}`;
  }

  private getProjectFilePath(projectId: string): string {
    if (this.legacyFilePath) return this.legacyFilePath;
    const safeTenantId = this.getTenantId().replace(/[^a-zA-Z0-9_.-]/g, '_');
    const safeProjectId = projectId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return `${this.baseDataPath}/tenant_${safeTenantId}/projects/${safeProjectId}/memories.jsonl`;
  }

  private getProjectCache(projectId: string, explicitFilePath?: string): ProjectCache {
    const key = this.legacyFilePath ? '__legacy__' : this.cacheKey(projectId);
    let cache = this.caches.get(key);
    if (!cache) {
      cache = {
        items: new Map(),
        filePath: explicitFilePath ?? this.getProjectFilePath(projectId),
        nextId: 1,
        bm25: new BM25Scorer(),
        tokenCache: new Map(),
        indexDirty: true,
        dirty: false,
        loaded: false,
      };
      this.caches.set(key, cache);
    }
    return cache;
  }

  private async ensureProjectCache(projectId: string): Promise<ProjectCache> {
    const cache = this.getProjectCache(projectId);
    if (!cache.loaded) {
      await this.loadProjectCache(cache);
    }
    return cache;
  }

  private async loadProjectCache(cache: ProjectCache): Promise<void> {
    if (cache.loaded) return;
    try {
      const data = await readFile(cache.filePath, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          cache.items.set(item.id, item);
          const num = parseInt(item.id.replace('memory-', ''), 10);
          if (!isNaN(num) && num >= cache.nextId) cache.nextId = num + 1;
        }
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        getGlobalLogger().debug('JsonMemoryStore', 'No existing memory file — starting empty', {
          path: cache.filePath,
        });
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
    this.rebuildIndex(cache);
    cache.loaded = true;
  }

  private async persistCache(cache: ProjectCache): Promise<void> {
    if (!cache.dirty) return;
    const dir = dirname(cache.filePath);
    if (dir && dir !== '.') await mkdir(dir, { recursive: true });
    // REL-4: atomic write — an in-place rewrite that crashes mid-way corrupts the
    // whole memory file (and load() then throws). Write → fsync → rename.
    await atomicWriteFile(
      cache.filePath,
      JSON.stringify(Array.from(cache.items.values()), null, 2),
    );
    cache.dirty = false;
  }

  private async persist(): Promise<void> {
    for (const cache of this.caches.values()) {
      await this.persistCache(cache);
    }
  }

  async write(options: MemoryWriteOptions): Promise<EpisodicMemoryItem> {
    const cache = await this.ensureProjectCache(options.projectId);

    // Auto-cleanup expired items periodically to prevent unbounded growth
    if (cache.items.size > 0 && cache.items.size % 100 === 0) {
      await this.deleteExpiredForCache(cache);
    }

    const now = new Date().toISOString();
    const id = `memory-${cache.nextId++}`;

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

    cache.items.set(id, item);
    this.indexItem(cache, item);
    cache.dirty = true;
    await this.persistCache(cache);
    return item;
  }

  async batchWrite(items: MemoryWriteOptions[]): Promise<EpisodicMemoryItem[]> {
    const results: EpisodicMemoryItem[] = [];
    // Group by project so each cache is loaded/persisted once.
    const byProject = new Map<string, MemoryWriteOptions[]>();
    for (const item of items) {
      const list = byProject.get(item.projectId) ?? [];
      list.push(item);
      byProject.set(item.projectId, list);
    }

    for (const [projectId, projectItems] of byProject) {
      const cache = await this.ensureProjectCache(projectId);
      for (const options of projectItems) {
        const now = new Date().toISOString();
        const id = `memory-${cache.nextId++}`;
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

        const entry: EpisodicMemoryItem = {
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
        cache.items.set(id, entry);
        this.indexItem(cache, entry);
        results.push(entry);
      }
      cache.dirty = true;
      await this.persistCache(cache);
    }
    return results;
  }

  async update(options: MemoryManageOptions): Promise<EpisodicMemoryItem | null> {
    const cache = await this.ensureProjectCache(options.projectId);
    const item = cache.items.get(options.id);
    if (!item || item.projectId !== options.projectId) return null;
    if (options.delete) {
      this.deindexItem(cache, options.id);
      cache.items.delete(options.id);
      cache.dirty = true;
      await this.persistCache(cache);
      return null;
    }
    if (options.updates) {
      this.deindexItem(cache, options.id);
      // Security: Prevent prototype pollution by filtering dangerous keys.
      const safeUpdates = { ...options.updates };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (safeUpdates as any).__proto__;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (safeUpdates as any).constructor;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (safeUpdates as any).prototype;
      Object.assign(item, safeUpdates);
      item.lastAccessedAt = new Date().toISOString();
      this.indexItem(cache, item);
      cache.dirty = true;
      await this.persistCache(cache);
    }
    return item;
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const cache = await this.ensureProjectCache(projectId);
    const item = cache.items.get(id);
    if (!item || item.projectId !== projectId) return false;
    this.deindexItem(cache, id);
    cache.items.delete(id);
    cache.dirty = true;
    await this.persistCache(cache);
    return true;
  }

  async deleteByMission(missionId: string, projectId: string): Promise<number> {
    const cache = await this.ensureProjectCache(projectId);
    let count = 0;
    for (const [id, item] of cache.items) {
      if (item.projectId === projectId && item.missionId === missionId) {
        this.deindexItem(cache, id);
        cache.items.delete(id);
        count++;
      }
    }
    if (count > 0) {
      cache.dirty = true;
      await this.persistCache(cache);
    }
    return count;
  }

  async deleteExpired(projectId: string): Promise<number> {
    const cache = await this.ensureProjectCache(projectId);
    return this.deleteExpiredForCache(cache);
  }

  private deleteExpiredForCache(cache: ProjectCache): number {
    const now = new Date();
    let count = 0;
    for (const [id, item] of cache.items) {
      if (item.expiresAt && new Date(item.expiresAt) < now) {
        this.deindexItem(cache, id);
        cache.items.delete(id);
        count++;
      }
    }
    if (count > 0) {
      cache.dirty = true;
      this.persistCache(cache).catch((err) => {
        getGlobalLogger().warn('JsonMemoryStore', 'Deferred expire persist failed', {
          error: (err as Error)?.message,
        });
      });
    }
    return count;
  }

  async read(id: string, projectId: string): Promise<EpisodicMemoryItem | null> {
    const cache = await this.ensureProjectCache(projectId);
    const item = cache.items.get(id);
    if (!item || item.projectId !== projectId) return null;
    item.lastAccessedAt = new Date().toISOString();
    cache.dirty = true;
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
    const cache = await this.ensureProjectCache(query.projectId);

    // Use BM25 scorer to narrow candidates for text query
    let candidateIds: Set<string> | null = null;
    if (query.query) {
      if (cache.indexDirty) this.rebuildIndex(cache);
      const bm25Results = cache.bm25.score(query.query, cache.items.size);
      candidateIds = new Set(bm25Results.map((r) => r.id));
    }

    // Single-pass filter: combine all conditions to avoid intermediate array allocations
    const lowerQuery = query.query?.toLowerCase();
    const hasTags = query.tags && query.tags.length > 0;
    const results: EpisodicMemoryItem[] = [];

    for (const item of cache.items.values()) {
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
  private rebuildIndex(cache: ProjectCache): void {
    cache.bm25 = new BM25Scorer();
    cache.tokenCache.clear();
    for (const [id, item] of cache.items) {
      const fullText = `${item.title} ${item.content} ${item.tags.join(' ')}`;
      const fieldTexts = new Map<string, string>();
      fieldTexts.set('title', item.title);
      cache.bm25.addDocument(id, fullText, fieldTexts);
      cache.tokenCache.set(id, tokenize(item.title + ' ' + item.content));
    }
    cache.indexDirty = false;
  }

  /** Add a single item to the BM25 index. */
  private indexItem(cache: ProjectCache, item: EpisodicMemoryItem): void {
    const fullText = `${item.title} ${item.content} ${item.tags.join(' ')}`;
    const fieldTexts = new Map<string, string>();
    fieldTexts.set('title', item.title);
    cache.bm25.addDocument(item.id, fullText, fieldTexts);
    cache.tokenCache.set(item.id, tokenize(item.title + ' ' + item.content));
  }

  /** Remove a single item from the BM25 index. */
  private deindexItem(cache: ProjectCache, id: string): void {
    cache.bm25.removeDocument(id);
    cache.tokenCache.delete(id);
  }

  async searchSemantic(
    query: string,
    projectId: string,
    limit = 10,
  ): Promise<EpisodicMemoryItem[]> {
    const cache = await this.ensureProjectCache(projectId);

    // Lazy rebuild index if dirty
    if (cache.indexDirty) this.rebuildIndex(cache);

    const projectItems = Array.from(cache.items.values()).filter(
      (item) => item.projectId === projectId,
    );
    if (projectItems.length === 0) return [];

    // Use BM25 for high-quality full-text search
    const bm25Results = cache.bm25.score(query, projectItems.length);
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
    const cache = await this.ensureProjectCache(projectId);
    const projectItems = Array.from(cache.items.values()).filter(
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
