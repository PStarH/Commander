/**
 * JSON-file backed MemoryStore implementation.
 * Persists EpisodicMemoryItems to a JSON file on disk.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { getGlobalLogger } from '../logging';
import type {
  EpisodicMemoryItem, MemoryWriteOptions, MemorySearchQuery,
  MemorySearchResult, MemoryManageOptions, MemoryStats, MemoryStore,
} from '../memory';
import type { MemoryKind, MemoryDuration } from '../memory';

/**
 * JSON-file backed MemoryStore for simple persistence.
 * Falls back gracefully when SQLite is unavailable.
 */
export class JsonMemoryStore implements MemoryStore {
  private items: Map<string, EpisodicMemoryItem> = new Map();
  private filePath: string;
  private nextId = 1;
  private dirty = false;

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
    } catch {
      getGlobalLogger().debug('JsonMemoryStore', 'Init load failed — starting empty');
    }
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return;
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
    if (dir) await mkdir(dir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(Array.from(this.items.values()), null, 2));
    this.dirty = false;
  }

  async write(options: MemoryWriteOptions): Promise<EpisodicMemoryItem> {
    const now = new Date().toISOString();
    const id = `memory-${this.nextId++}`;

    const kindPriority: Record<MemoryKind, number> = {
      DECISION: 80, ISSUE: 70, LESSON: 90, SUMMARY: 50,
    };
    let priority = options.priority ?? (kindPriority[options.kind] ?? 50);
    if (options.missionId) priority += 5;
    if (options.agentId) priority += 5;
    if (options.evidenceRefs?.length) priority += Math.min(options.evidenceRefs.length * 5, 15);
    priority = Math.min(priority, 100);

    const item: EpisodicMemoryItem = {
      id, projectId: options.projectId, missionId: options.missionId,
      agentId: options.agentId, kind: options.kind,
      duration: options.duration ?? 'EPISODIC',
      title: options.title, content: options.content, tags: options.tags ?? [],
      priority, createdAt: now, lastAccessedAt: now,
      expiresAt: options.duration === 'EPISODIC'
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() : undefined,
      evidenceRefs: options.evidenceRefs, confidence: options.confidence ?? 0.8,
    };

    this.items.set(id, item);
    this.dirty = true;
    await this.persist();
    return item;
  }

  async batchWrite(items: MemoryWriteOptions[]): Promise<EpisodicMemoryItem[]> {
    const results: EpisodicMemoryItem[] = [];
    for (const item of items) results.push(await this.write(item));
    return results;
  }

  async update(options: MemoryManageOptions): Promise<EpisodicMemoryItem | null> {
    const item = this.items.get(options.id);
    if (!item || item.projectId !== options.projectId) return null;
    if (options.delete) { this.items.delete(options.id); this.dirty = true; await this.persist(); return null; }
    if (options.updates) { Object.assign(item, options.updates); item.lastAccessedAt = new Date().toISOString(); this.dirty = true; await this.persist(); }
    return item;
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const item = this.items.get(id);
    if (!item || item.projectId !== projectId) return false;
    this.items.delete(id); this.dirty = true; await this.persist();
    return true;
  }

  async deleteByMission(missionId: string, projectId: string): Promise<number> {
    let count = 0;
    for (const [id, item] of this.items) {
      if (item.projectId === projectId && item.missionId === missionId) { this.items.delete(id); count++; }
    }
    if (count > 0) { this.dirty = true; await this.persist(); }
    return count;
  }

  async deleteExpired(projectId: string): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const [id, item] of this.items) {
      if (item.projectId === projectId && item.expiresAt && new Date(item.expiresAt) < now) { this.items.delete(id); count++; }
    }
    if (count > 0) { this.dirty = true; await this.persist(); }
    return count;
  }

  async read(id: string, projectId: string): Promise<EpisodicMemoryItem | null> {
    const item = this.items.get(id);
    if (!item || item.projectId !== projectId) return null;
    item.lastAccessedAt = new Date().toISOString();
    return item;
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
    let results = Array.from(this.items.values()).filter(item => item.projectId === query.projectId);
    if (query.kind) results = results.filter(item => item.kind === query.kind);
    if (query.missionId) results = results.filter(item => item.missionId === query.missionId);
    if (query.agentId) results = results.filter(item => item.agentId === query.agentId);
    if (query.tags?.length) results = results.filter(item => query.tags!.some(tag => item.tags.includes(tag)));
    if (query.minPriority !== undefined) results = results.filter(item => item.priority >= query.minPriority!);
    if (query.minConfidence !== undefined) results = results.filter(item => item.confidence >= query.minConfidence!);
    if (query.query) {
      const lower = query.query.toLowerCase();
      results = results.filter(item => item.title.toLowerCase().includes(lower) || item.content.toLowerCase().includes(lower));
    }
    results.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    const total = results.length;
    const limit = query.limit ?? 50;
    return { items: results.slice(0, limit), total, query };
  }

  async searchSemantic(query: string, projectId: string, limit = 10): Promise<EpisodicMemoryItem[]> {
    const projectItems = Array.from(this.items.values()).filter(item => item.projectId === projectId);
    if (projectItems.length === 0) return [];

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    const N = projectItems.length;
    const idf = new Map<string, number>();
    for (const term of queryTerms) {
      const df = projectItems.filter(item => tokenize(item.title + ' ' + item.content).includes(term)).length;
      idf.set(term, Math.log(N / (df + 1)) + 1);
    }

    const scored = projectItems.map(item => {
      const docTerms = tokenize(item.title + ' ' + item.content);
      const docLen = docTerms.length || 1;
      let score = 0;
      for (const term of queryTerms) {
        const tf = docTerms.filter(t => t === term).length / docLen;
        score += tf * (idf.get(term) ?? 1);
      }
      score *= (1 + item.priority / 100) * (0.5 + item.confidence);
      return { item, score };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.item.createdAt).getTime() - new Date(a.item.createdAt).getTime();
    });

    return scored.slice(0, limit).map(s => {
      s.item.lastAccessedAt = new Date().toISOString();
      return s.item;
    });
  }

  async getStats(projectId: string): Promise<MemoryStats> {
    const projectItems = Array.from(this.items.values()).filter(item => item.projectId === projectId);
    const byKind: Record<MemoryKind, number> = { DECISION: 0, ISSUE: 0, LESSON: 0, SUMMARY: 0 };
    const byDuration: Record<MemoryDuration, number> = { EPISODIC: 0, LONG_TERM: 0 };
    const tagCounts = new Map<string, number>();
    let totalPriority = 0, totalConfidence = 0;
    let oldestItem: string | undefined, newestItem: string | undefined;

    for (const item of projectItems) {
      byKind[item.kind]++; byDuration[item.duration]++;
      totalPriority += item.priority; totalConfidence += item.confidence;
      for (const tag of item.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      if (!oldestItem || item.createdAt < oldestItem) oldestItem = item.createdAt;
      if (!newestItem || item.createdAt > newestItem) newestItem = item.createdAt;
    }

    return {
      totalItems: projectItems.length, byKind, byDuration,
      avgPriority: projectItems.length > 0 ? totalPriority / projectItems.length : 0,
      avgConfidence: projectItems.length > 0 ? totalConfidence / projectItems.length : 0,
      topTags: Array.from(tagCounts.entries()).map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      oldestItem, newestItem,
    };
  }

  async close(): Promise<void> {
    await this.persist();
  }
}

import { tokenize } from './tokenizer';
