/// <reference types="node" />

/**
 * Three-Layer Memory System
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 *
 * Core insight: 模拟人类记忆的三个层次
 * - Working Memory: 当前上下文，快速但有限
 * - Episodic Memory: 近期经验，会逐渐遗忘
 * - Long-term Memory: 持久知识，稳定但需要检索
 *
 * Enhanced with:
 * - MemoryQualityGate: Multi-layer quality filtering (Self-RAG, Liang 2023)
 * - ThompsonMemoryScorer: Usefulness tracking (Schaul et al., 2015)
 * - Spreading activation: ACT-R style decay (Sumers et al., 2023)
 */

import { MemoryQualityGate, quickQualityCheck } from './memory/memoryQualityGate.js';
import { ThompsonMemoryScorer } from './memory/thompsonMemoryScorer.js';
// Audit MED item 1 — Phase A additive route-out. Type-only imports keep the
// bundle clean. The value-side MemoryStore dependency is injected via
// constructor or setMemoryStore(); see mapMemoryEntryToWriteOptions.
import type { MemoryStore, MemoryWriteOptions, MemoryKind } from './memory';
import { getGlobalSemanticMemoryStore } from './memory/semanticStore';
import { getGlobalEpisodicStore } from './memory/episodicStore';

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ========================================
// Types
// ========================================

export type MemoryLayer = 'working' | 'episodic' | 'longterm' | 'procedural';

export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  content: string;
  context: string; // 关联上下文
  importance: number; // 0-1, 重要程度
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  decayScore: number; // 衰减分数 (episodic layer)
  tags: string[];
  metadata: Record<string, unknown>;
  // L4 Procedural 层专用字段
  proceduralType?: 'sop' | 'tool' | 'workflow' | 'heuristic';
  successRate?: number; // 使用成功率 0-1
  usageCount?: number; // 被调用次数
  conditions?: string[]; // 适用条件列表
}

export interface MemoryQuery {
  layer?: MemoryLayer;
  keywords?: string[];
  context?: string;
  importanceThreshold?: number;
  limit?: number;
  since?: string; // ISO date string
}

export interface MemoryStats {
  totalEntries: number;
  byLayer: Record<MemoryLayer, number>;
  averageImportance: number;
  averageAccessCount: number;
  totalMemoryUsed: number; // bytes estimate
}

// ========================================
// Layer Configuration
// ========================================

interface LayerConfig {
  maxEntries: number;
  maxMemoryBytes: number;
  decayRate: number; // 每次访问后的衰减
  baseDecayPerHour: number; // 每小时基础衰减
  importanceBoost: number; // 高重要性项衰减减慢
}

const DEFAULT_CONFIG: Record<MemoryLayer, LayerConfig> = {
  working: {
    maxEntries: 50,
    maxMemoryBytes: 100000, // 100KB
    decayRate: 0,
    baseDecayPerHour: 0,
    importanceBoost: 0,
  },
  episodic: {
    maxEntries: 500,
    maxMemoryBytes: 500000, // 500KB
    decayRate: 0.05,
    baseDecayPerHour: 0.01,
    importanceBoost: 0.02,
  },
  longterm: {
    maxEntries: 10000,
    maxMemoryBytes: 5000000, // 5MB
    decayRate: 0,
    baseDecayPerHour: 0,
    importanceBoost: 0,
  },
  procedural: {
    maxEntries: 5000,
    maxMemoryBytes: 2000000, // 2MB
    decayRate: 0.02,
    baseDecayPerHour: 0.005,
    importanceBoost: 0.01,
  },
};

// ========================================
// Three-Layer Memory
// ========================================

import { calculateMemoryScore, InMemoryEmbeddingStore } from './runtime/embedding';
import type { EmbeddingFunction } from './runtime/embedding';
import { getGlobalLogger } from './logging';

export class ThreeLayerMemory {
  private memories: Map<string, MemoryEntry> = new Map();
  private config: Record<MemoryLayer, LayerConfig>;
  private embeddingFn: EmbeddingFunction | null = null;
  private embedStore: InMemoryEmbeddingStore = new InMemoryEmbeddingStore();
  private persistPath: string | null = null;

  /** Quality gate for memory storage decisions (0 tokens per check) */
  private qualityGate: MemoryQualityGate;
  /** Thompson scorer for memory usefulness tracking (0 tokens per check) */
  private thompsonScorer: ThompsonMemoryScorer;
  /** Optional persistent sink for non-working layers (audit MED item 1 Phase A) */
  private memoryStore: MemoryStore | null = null;
  /**
   * Pillar IV contract stores — optional delegates for enhanced retrieval.
   * When available, episodic memories are also recorded in EpisodicMemoryStore
   * (with ACT-R activation tracking), and semantic queries are augmented
   * with SemanticMemoryStore's HNSW vector search + knowledge graph traversal.
   * These are lazily initialized from the global singletons.
   */
  private semanticStore: ReturnType<typeof getGlobalSemanticMemoryStore> | null = null;
  private episodicStore: ReturnType<typeof getGlobalEpisodicStore> | null = null;

  constructor(
    config?: Partial<Record<MemoryLayer, LayerConfig>> & {
      persistPath?: string;
      memoryStore?: MemoryStore;
    },
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.qualityGate = new MemoryQualityGate();
    this.thompsonScorer = new ThompsonMemoryScorer();
    this.memoryStore = config?.memoryStore ?? null;
    if (config?.persistPath) {
      this.persistPath = config.persistPath;
      this.load();
    }
  }

  // ======================================================================
  // Persistence
  // ======================================================================

  /**
   * Persist memory state (non-embedding data) to disk as JSON.
   * Embeddings are regenerated on load and are not persisted.
   * Returns the number of entries persisted.
   */
  save(): number {
    if (!this.persistPath) return 0;
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });

      const data = {
        version: 1,
        savedAt: new Date().toISOString(),
        config: this.config,
        entries: Array.from(this.memories.values()),
      };
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
      return data.entries.length;
    } catch (e) {
      getGlobalLogger().warn('ThreeLayerMemory', 'Save failed', {
        error: (e as Error)?.message,
      });
      return 0;
    }
  }

  /**
   * Load memory state from disk.
   * Returns the number of entries restored, or 0 if no saved state exists.
   */
  load(): number {
    if (!this.persistPath) return 0;
    try {
      const fs = require('fs');
      if (!fs.existsSync(this.persistPath)) return 0;

      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw);
      if (!data.entries || !Array.isArray(data.entries)) return 0;

      for (const entry of data.entries) {
        this.memories.set(entry.id, entry);
      }

      getGlobalLogger().info(
        'ThreeLayerMemory',
        `Loaded ${data.entries.length} entries from ${this.persistPath}`,
      );
      return data.entries.length;
    } catch (e) {
      getGlobalLogger().warn('ThreeLayerMemory', 'Load failed', {
        error: (e as Error)?.message,
      });
      return 0;
    }
  }

  /** Returns true if a persist path is configured */
  hasPersistence(): boolean {
    return this.persistPath !== null;
  }

  /**
   * Wire or replace the persistent MemoryStore (audit MED item 1 Phase A).
   * Pass null to disable route-out. File persistence path stays live in
   * parallel until Phase C retires it; this method is independent of the
   * `persistPath` legacy JSON file.
   *
   * Pre-condition (audit MED item 1 Phase D): once wired, callers MUST
   * also bootstrap a TTL curator (MemoryCurator.deleteExpired) before
   * long-running workloads hit `add()`. `applyTimeDecay` suppresses its
   * own in-memory deletion when a store is wired; decayScore→0 entries
   * therefore persist in memoryStore indefinitely until the curator runs.
   * In-memory eviction (`evictIfNeeded` size-cap) still trims growth, so
   * the failure mode is bounded by working-set cardinality, not unbounded.
   */
  setMemoryStore(store: MemoryStore | null): void {
    this.memoryStore = store;
  }

  setEmbeddingFunction(fn: EmbeddingFunction): void {
    this.embeddingFn = fn;
  }

  /**
   * Enable Pillar IV contract store delegation.
   *
   * When enabled, episodic memories are mirrored to EpisodicMemoryStore
   * (with ACT-R activation formula tracking), and semantic queries are
   * augmented with SemanticMemoryStore's HNSW vector search + knowledge
   * graph traversal. This connects the runtime's memory path to the
   * Pillar IV contract implementations.
   */
  enablePillarIVDelegation(): void {
    try {
      this.semanticStore = getGlobalSemanticMemoryStore();
      this.episodicStore = getGlobalEpisodicStore();
      getGlobalLogger().info('ThreeLayerMemory', 'Pillar IV delegation enabled', {
        semanticStore: !!this.semanticStore,
        episodicStore: !!this.episodicStore,
      });
    } catch (err) {
      getGlobalLogger().warn('ThreeLayerMemory', 'Failed to enable Pillar IV delegation', {
        error: (err as Error)?.message,
      });
    }
  }

  getEmbeddingStore(): InMemoryEmbeddingStore {
    return this.embedStore;
  }

  /**
   * 添加记忆 (with optional embedding and quality gate)
   *
   * Quality gate (0 tokens): rule filter + quality checks
   * Embedding (0 tokens): fire-and-forget for async
   */
  add(
    content: string,
    layer: MemoryLayer,
    context: string = '',
    importance: number = 0.5,
    tags: string[] = [],
    metadata: Record<string, unknown> = {},
  ): MemoryEntry {
    // Quality gate: fast path (0 tokens)
    if (layer !== 'working' && !quickQualityCheck(content, importance)) {
      getGlobalLogger().debug('ThreeLayerMemory', 'Memory rejected by quality gate', {
        contentLength: content.length,
        importance,
        layer,
      });
      // Return a dummy entry but don't store it
      return {
        id: 'rejected',
        layer,
        content,
        context,
        importance,
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
        accessCount: 0,
        decayScore: 0,
        tags,
        metadata: { ...metadata, rejected: true },
      };
    }

    // Contradiction detection: check if new content conflicts with existing memories.
    // Uses text similarity to find potentially conflicting entries, then lowers
    // importance of the new entry. Zero-token cost (pure computation).
    let adjustedImportance = importance;
    const contradictionIds: string[] = [];
    if (layer !== 'working' && content.length > 20) {
      try {
        const similar = this.searchRelated(content, 5);
        for (const existing of similar) {
          if (existing.id === 'rejected') continue;
          const textSim = this.textSimilarity(content, existing.content);
          if (textSim > 0.7 && Math.abs(existing.importance - importance) > 0.4) {
            contradictionIds.push(existing.id);
          }
        }
        if (contradictionIds.length > 0) {
          adjustedImportance *= 0.5;
          getGlobalLogger().debug('ThreeLayerMemory', 'Contradiction detected in memory write', {
            contradictionCount: contradictionIds.length,
            originalImportance: importance,
            adjustedImportance,
          });
        }
      } catch (e) {
        getGlobalLogger().debug('ThreeLayerMemory', 'Contradiction check failed (best-effort)', {
          error: (e as Error)?.message,
        });
      }
    }

    const entryMetadata: Record<string, unknown> =
      contradictionIds.length > 0 ? { ...metadata, contradictions: contradictionIds } : metadata;

    const entry: MemoryEntry = {
      id: generateUUID(),
      layer,
      content,
      context,
      importance: adjustedImportance,
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      accessCount: 0,
      decayScore: layer === 'episodic' ? 1.0 : 0,
      tags,
      metadata: entryMetadata,
    };

    this.memories.set(entry.id, entry);

    // Auto-save after non-working memory writes
    if (this.persistPath && layer !== 'working') {
      this.save();
    }

    // Audit MED item 1 — Phase A additive route-out. Working layer is
    // intentionally excluded so ephemeral session context never touches
    // persistent storage. The async write mirrors the embedding pattern
    // below — never blocks add(); failures are logged, not thrown.
    if (this.memoryStore && layer !== 'working') {
      const opts = mapMemoryEntryToWriteOptions(entry);
      this.memoryStore.write(opts).catch((err: Error) => {
        getGlobalLogger().warn('ThreeLayerMemory', 'route-out to memoryStore failed', {
          entryId: entry.id,
          layer: entry.layer,
          error: err.message,
        });
      });
    }

    // Generate embedding if function is configured (fire-and-forget for async)
    if (this.embeddingFn && layer !== 'working') {
      const combined = `${content} ${context} ${tags.join(' ')}`;
      const result = this.embeddingFn.generate(combined);
      if (result instanceof Promise) {
        result
          .then((emb) => this.embedStore.setEmbedding(entry.id, emb))
          .catch((e) =>
            getGlobalLogger().debug('ThreeLayerMemory', 'embedding error', {
              error: (e as Error)?.message,
            }),
          );
      } else {
        this.embedStore.setEmbedding(entry.id, result);
      }
    }
    this.embedStore.setEntry(entry.id, entry);

    // Pillar IV delegation: mirror episodic memories to EpisodicMemoryStore
    // for ACT-R activation tracking, and ingest semantic entities to
    // SemanticMemoryStore for HNSW vector search + knowledge graph traversal.
    if (layer === 'episodic' && this.episodicStore) {
      try {
        this.episodicStore.record({
          timestamp: Date.now(),
          context: context || 'general',
          action: content.slice(0, 100),
          outcome: 'recorded',
          tags,
        });
      } catch (err) {
        getGlobalLogger().debug('ThreeLayerMemory', 'EpisodicStore mirror failed', {
          error: (err as Error)?.message,
        });
      }
    }
    if (layer !== 'working' && this.semanticStore) {
      try {
        // Ingest as a semantic entity for knowledge graph + HNSW search
        this.semanticStore.ingest({
          name: content.slice(0, 80),
          type: layer,
          description: `${context} ${tags.join(' ')}`.trim() || content,
          embedding: this.embedStore.getEmbedding(entry.id) ?? [],
          relationships: [],
        }).catch((err: unknown) => {
          getGlobalLogger().debug('ThreeLayerMemory', 'SemanticStore ingest failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } catch (err) {
        getGlobalLogger().debug('ThreeLayerMemory', 'SemanticStore ingest error', {
          error: (err as Error)?.message,
        });
      }
    }

    this.evictIfNeeded(layer);

    return entry;
  }

  /**
   * 获取记忆
   */
  get(id: string): MemoryEntry | undefined {
    const entry = this.memories.get(id);
    if (entry) {
      this.updateAccess(entry);
    }
    return entry;
  }

  /**
   * 更新访问
   */
  private updateAccess(entry: MemoryEntry): void {
    entry.accessCount++;
    entry.lastAccessedAt = new Date().toISOString();

    // Episodic 层应用衰减
    if (entry.layer === 'episodic') {
      const config = this.config.episodic;
      entry.decayScore = Math.max(
        0,
        entry.decayScore - config.decayRate * (1 - entry.importance * config.importanceBoost),
      );
    }

    // Procedural 层应用衰减
    if (entry.layer === 'procedural') {
      const config = this.config.procedural;
      entry.decayScore = Math.max(
        0,
        entry.decayScore - config.decayRate * (1 - entry.importance * config.importanceBoost),
      );
    }
  }

  /**
   * 查询记忆 (with embedding-aware scoring) — sync version (no Pillar IV augmentation).
   * Used by internal callers (add contradiction check, searchRelated) that need
   * synchronous results. External callers should use the async `query()` method
   * for Pillar IV augmented results.
   */
  querySync(query: MemoryQuery): MemoryEntry[] {
    let results = Array.from(this.memories.values());

    // 按层过滤
    if (query.layer) {
      results = results.filter((m) => m.layer === query.layer);
    }

    // 按关键词过滤
    if (query.keywords && query.keywords.length > 0) {
      results = results.filter((m) => {
        const text = `${m.content} ${m.context} ${m.tags.join(' ')}`.toLowerCase();
        return query.keywords!.some((kw) => text.includes(kw.toLowerCase()));
      });
    }

    // 按上下文过滤
    if (query.context) {
      results = results.filter((m) =>
        m.context.toLowerCase().includes(query.context!.toLowerCase()),
      );
    }

    // 按重要性过滤
    if (query.importanceThreshold !== undefined) {
      results = results.filter((m) => m.importance >= query.importanceThreshold!);
    }

    // 按时间过滤
    if (query.since) {
      const since = new Date(query.since);
      results = results.filter((m) => new Date(m.createdAt) >= since);
    }

    // Compute query embedding once for similarity scoring
    let queryEmbedding: number[] | undefined;
    if (this.embeddingFn && query.keywords && query.keywords.length > 0) {
      const emb = this.embeddingFn.generate(query.keywords.join(' '));
      if (!(emb instanceof Promise)) {
        queryEmbedding = emb;
      }
    }

    // Sort by embedding-aware three-factor score (Generative Agents formula)
    results.sort((a, b) => {
      const scoreA = calculateMemoryScore(a, queryEmbedding, this.embedStore.getEmbedding(a.id));
      const scoreB = calculateMemoryScore(b, queryEmbedding, this.embedStore.getEmbedding(b.id));
      return scoreB - scoreA;
    });

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  /**
   * 查询记忆 (with embedding-aware scoring) — async version with Pillar IV augmentation.
   * Includes SemanticMemoryStore HNSW search and EpisodicMemoryStore ACT-R recall.
   */
  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    let results = this.querySync(query);

    // Pillar IV delegation: augment with SemanticMemoryStore HNSW results.
    // When semantic store is available and keywords are provided, query the
    // HNSW index for additional candidates that may not match keywords
    // exactly but are semantically close. Results are merged and re-ranked.
    if (this.semanticStore && query.keywords && query.keywords.length > 0) {
      try {
        const semanticResults = await this.semanticStore.query({
          text: query.keywords.join(' '),
          limit: query.limit ?? 10,
          minSimilarity: 0.3,
        });
        // Merge semantic results with existing results, avoiding duplicates
        const existingIds = new Set(results.map((r) => r.id));
        for (const entity of semanticResults) {
          if (!existingIds.has(entity.id)) {
            // Convert semantic entity to memory entry format
            results.push({
              id: entity.id,
              layer: 'semantic' as MemoryLayer,
              content: entity.name + ': ' + entity.description,
              context: 'semantic-augmented',
              importance: 0.5,
              createdAt: new Date().toISOString(),
              lastAccessedAt: new Date().toISOString(),
              accessCount: 0,
              decayScore: 0,
              tags: [entity.type],
              metadata: { source: 'SemanticMemoryStore', semanticScore: true },
            });
          }
        }
        // Re-sort after merge
        results.sort((a, b) => b.importance - a.importance);
      } catch (err) {
        getGlobalLogger().debug('ThreeLayerMemory', 'SemanticStore augmentation failed', {
          error: (err as Error)?.message,
        });
      }
    }

    // Pillar IV delegation: augment with EpisodicMemoryStore recall.
    // Uses ACT-R activation formula to find episodic memories with high
    // activation scores (recent + frequently accessed).
    if (this.episodicStore && query.layer === 'episodic') {
      try {
        const episodicResults = await this.episodicStore.recall({
          context: query.keywords?.join(' ') ?? undefined,
          limit: query.limit ?? 10,
          minActivation: 0.1,
        });
        const existingIds = new Set(results.map((r) => r.id));
        for (const ep of episodicResults) {
          if (!existingIds.has(ep.id)) {
            results.push({
              id: ep.id,
              layer: 'episodic' as MemoryLayer,
              content: `${ep.action} → ${ep.outcome}`,
              context: ep.context,
              importance: 0.5,
              createdAt: new Date(ep.timestamp).toISOString(),
              lastAccessedAt: new Date().toISOString(),
              accessCount: 0,
              decayScore: 0,
              tags: ep.tags ?? [],
              metadata: { source: 'EpisodicMemoryStore', activation: ep.activation },
            });
          }
        }
        // Re-sort after merge
        results.sort((a, b) => b.importance - a.importance);
      } catch (err) {
        getGlobalLogger().debug('ThreeLayerMemory', 'EpisodicStore augmentation failed', {
          error: (err as Error)?.message,
        });
      }
    }

    // 限制数量
    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  /**
   * 获取特定层的记忆
   */
  getByLayer(layer: MemoryLayer, limit?: number): MemoryEntry[] {
    const results = this.querySync({ layer, limit });
    return results;
  }

  /**
   * 获取当前上下文 (working memory)
   */
  getWorkingContext(maxEntries: number = 10): MemoryEntry[] {
    const workingSlots = Math.max(1, Math.ceil(maxEntries * 0.7));
    const episodicSlots = Math.max(1, maxEntries - workingSlots);
    const working = this.getByLayer('working', workingSlots);
    const recentEpisodic = this.querySync({
      layer: 'episodic',
      limit: episodicSlots,
      importanceThreshold: 0.6,
    });
    return [...working, ...recentEpisodic].slice(0, maxEntries);
  }

  /**
   * 删除记忆
   */
  delete(id: string): boolean {
    const entry = this.memories.get(id);
    if (!entry) return false;

    this.memories.delete(id);
    // GAP-18: Also clean up the embedding store to prevent orphaned entries
    this.embedStore.delete(id);
    return true;
  }

  /**
   * 将记忆升级到长期层
   */
  promoteToLongTerm(id: string): boolean {
    const entry = this.memories.get(id);
    if (!entry || entry.layer === 'longterm') return false;

    entry.layer = 'longterm';
    entry.decayScore = 0; // 长期记忆不衰减
    return true;
  }

  /**
   * 归档到情景层
   */
  archiveToEpisodic(id: string): boolean {
    const entry = this.memories.get(id);
    if (!entry || entry.layer !== 'working') return false;

    entry.layer = 'episodic';
    entry.decayScore = 1.0; // 重置衰减
    return true;
  }

  /**
   * 驱逐过期的记忆
   *
   * Uses Thompson scorer for better eviction decisions (0 tokens).
   *
   * Phase B (audit MED item 1): when `memoryStore` is wired, propagate the
   * eviction to the persistent sink so the two stores stay in sync. The
   * working layer is intentionally skipped — ephemeral session context
   * never touched the persistent layer in Phase A's route-out path so
   * there's no row to delete.
   *
   * INVARIANT (audit MED item 1 Phase B — reviewer-flagged): this method
   * MUST complete synchronously relative to the surrounding `add()` call
   * — never `await` between the in-memory `this.delete(id)` and the
   * `routeOutDelete(id)` call, nor between `add()` invocations that might
   * evict each other. SqliteMemoryStore.delete returns `false` (no throw)
   * for missing rows, so any `await` reopens a write/delete race that
   * leaks persistent rows without an error.
   */
  evictIfNeeded(layer: MemoryLayer): void {
    const config = this.config[layer];
    const layerMemories = Array.from(this.memories.values()).filter((m) => m.layer === layer);

    const routeOutDelete = (id: string) => {
      if (this.memoryStore && layer !== 'working') {
        this.memoryStore.delete(id, 'default').catch((err: Error) => {
          getGlobalLogger().warn('ThreeLayerMemory', 'evict route-out to memoryStore failed', {
            entryId: id,
            layer,
            error: err.message,
          });
        });
      }
    };

    // 超出数量限制
    if (layerMemories.length > config.maxEntries) {
      // 按综合分数排序，低分优先驱逐
      // Combines: importance, access count, decay score, and Thompson usefulness
      layerMemories.sort((a, b) => {
        const thompsonA = this.thompsonScorer.getMeanUsefulness(a.id);
        const thompsonB = this.thompsonScorer.getMeanUsefulness(b.id);

        // decayScore starts at 1.0 and decreases over time (fresh entries have higher scores).
        // We ADD decayScore so fresh entries get a retention bonus instead of a penalty.
        const scoreA = a.importance * 2 + a.accessCount + thompsonA * 3 + a.decayScore * 5;
        const scoreB = b.importance * 2 + b.accessCount + thompsonB * 3 + b.decayScore * 5;
        return scoreA - scoreB;
      });

      const toRemove = layerMemories.slice(0, layerMemories.length - config.maxEntries);
      for (const entry of toRemove) {
        this.thompsonScorer.remove(entry.id);
        this.delete(entry.id);
        routeOutDelete(entry.id);
      }
    }

    // Also evict Thompson-scorer eviction candidates (0 tokens)
    const thompsonEvictionCandidates = this.thompsonScorer.getEvictionCandidates();
    for (const id of thompsonEvictionCandidates) {
      const entry = this.memories.get(id);
      if (entry && entry.layer === layer) {
        this.delete(id);
        this.thompsonScorer.remove(id);
        routeOutDelete(id);
      }
    }
  }

  /**
   * 应用时间衰减 (定时调用)
   *
   * Phase B (audit MED item 1): when a `memoryStore` is wired, MemoryCurator
   * owns TTL-based eviction of the persistent layer via `deleteExpired`.
   * The in-memory shard keeps the row as a score-only lookup and the
   * `decayScore` field continues to drive activation scoring via
   * `getActivationScore`. Returning the deletion count is therefore 0 in
   * the wired case; legacy in-memory-only callers (no memoryStore wired)
   * preserve the original deletion path so existing behavior is unchanged.
   * Working layer is filtered out by the outer conditional either way.
   */
  applyTimeDecay(hoursElapsed: number): number {
    const toDelete: string[] = [];
    for (const entry of this.memories.values()) {
      if (entry.layer === 'episodic' || entry.layer === 'procedural') {
        const config = this.config[entry.layer];
        const decay =
          config.baseDecayPerHour * hoursElapsed * (1 - entry.importance * config.importanceBoost);
        entry.decayScore = Math.max(0, entry.decayScore - decay);

        if (!this.memoryStore && entry.decayScore <= 0) {
          toDelete.push(entry.id);
        }
      }
    }
    for (const id of toDelete) this.delete(id);
    return toDelete.length;
  }

  /**
   * 获取统计信息
   */
  getStats(): MemoryStats {
    const entries = Array.from(this.memories.values());

    const byLayer: Record<MemoryLayer, number> = {
      working: 0,
      episodic: 0,
      longterm: 0,
      procedural: 0,
    };

    let totalImportance = 0;
    let totalAccess = 0;
    let totalMemory = 0;

    for (const entry of entries) {
      byLayer[entry.layer]++;
      totalImportance += entry.importance;
      totalAccess += entry.accessCount;
      totalMemory += entry.content.length + entry.context.length;
    }

    return {
      totalEntries: entries.length,
      byLayer,
      averageImportance: entries.length > 0 ? totalImportance / entries.length : 0,
      averageAccessCount: entries.length > 0 ? totalAccess / entries.length : 0,
      totalMemoryUsed: totalMemory,
    };
  }

  /**
   * 搜索相关记忆 — combines keyword matching with embedding similarity
   */
  searchRelated(content: string, limit: number = 5): MemoryEntry[] {
    if (!content || !content.trim()) {
      // Empty query → return most recent important entries
      return Array.from(this.memories.values())
        .sort((a, b) => b.importance - a.importance || b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    }

    // Use tokenizer for better keyword extraction (handles stop words, min length 2)
    const keywords = content
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2);

    if (keywords.length === 0) {
      return Array.from(this.memories.values())
        .sort((a, b) => b.importance - a.importance)
        .slice(0, limit);
    }

    // Try embedding-based search first
    if (this.embeddingFn) {
      const queryEmb = this.embeddingFn.generate(content);
      if (!(queryEmb instanceof Promise)) {
        // Score all entries using embedding similarity + recency + importance
        const scored: Array<{ entry: MemoryEntry; score: number }> = [];
        for (const entry of this.memories.values()) {
          const entryEmb = this.embedStore.getEmbedding(entry.id);
          const embScore = entryEmb ? calculateMemoryScore(entry, queryEmb, entryEmb) : 0;
          // Fallback keyword score for entries without embeddings
          const text = `${entry.content} ${entry.context} ${entry.tags.join(' ')}`.toLowerCase();
          const kwHits = keywords.filter((kw) => text.includes(kw)).length;
          const kwScore = kwHits / keywords.length;
          // Blend: 70% embedding if available, 30% keyword
          const score = entryEmb ? embScore * 0.7 + kwScore * 0.3 : kwScore;
          if (score > 0) scored.push({ entry, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map((s) => {
          this.updateAccess(s.entry);
          return s.entry;
        });
      }
    }

    // Fallback: keyword-only search (use sync version — no Pillar IV augmentation)
    return this.querySync({ keywords, limit });
  }

  /**
   * 清除特定层的所有记忆
   */
  clearLayer(layer: MemoryLayer): number {
    const entries = Array.from(this.memories.values()).filter((m) => m.layer === layer);
    for (const entry of entries) {
      this.delete(entry.id);
    }
    return entries.length;
  }

  /**
   * 获取所有记忆 (调试用)
   */
  getAll(): MemoryEntry[] {
    return Array.from(this.memories.values());
  }

  /**
   * Get the Thompson memory scorer
   *
   * Use to update usefulness after memory retrieval
   */
  getThompsonScorer(): ThompsonMemoryScorer {
    return this.thompsonScorer;
  }

  /**
   * Get the quality gate
   *
   * Use for custom quality checks
   */
  getQualityGate(): MemoryQualityGate {
    return this.qualityGate;
  }

  /**
   * Simple text similarity measure (Jaccard index on word bigrams).
   * Fast and zero-token — used for contradiction detection.
   * Returns 0-1 score where 1 = identical word content.
   */
  private textSimilarity(a: string, b: string): number {
    const wordsA = new Set(
      a
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 1),
    );
    const wordsB = new Set(
      b
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 1),
    );
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);
    return intersection.size / union.size;
  }

  /**
   * Update memory usefulness (Thompson scoring)
   *
   * Call this after retrieving a memory to track if it was useful.
   * Token cost: 0 (pure computation)
   */
  updateMemoryUsefulness(memoryId: string, wasUseful: boolean): void {
    this.thompsonScorer.updateUsefulness(memoryId, wasUseful);
  }

  /**
   * Get spreading activation score for a memory
   *
   * ACT-R style activation: B + exp(-t/S) + log(1 + accessCount)
   * Token cost: 0 (pure computation)
   */
  getActivationScore(entry: MemoryEntry): number {
    const now = Date.now();
    const lastAccess = new Date(entry.lastAccessedAt).getTime();
    const hoursSinceAccess = (now - lastAccess) / 3600000;

    // Base activation from importance
    const B = Math.log(Math.max(entry.importance, 0.01));

    // Stability increases with access count
    const stability = entry.accessCount + 1;

    // Exponential decay (ACT-R style)
    const decay = Math.exp(-hoursSinceAccess / stability);

    // Frequency bonus (logarithmic)
    const frequencyBonus = Math.log(1 + entry.accessCount);

    return B + decay + frequencyBonus;
  }
}

// ========================================
// Factory
// ========================================

import { createTenantAwareSingleton } from './runtime/tenantAwareSingleton';

const DEFAULT_PERSIST_PATH = '.commander/memory/three-layer.json';

const memorySingleton = createTenantAwareSingleton(() => new ThreeLayerMemory());

export function getGlobalThreeLayerMemory(): ThreeLayerMemory {
  return memorySingleton.get();
}

/** Reset the global memory singleton (for test isolation) */
export function resetGlobalThreeLayerMemory(): void {
  memorySingleton.reset();
}

export function createThreeLayerMemory(
  config?: Partial<Record<MemoryLayer, LayerConfig>> & {
    persistPath?: string;
    memoryStore?: MemoryStore;
  },
): ThreeLayerMemory {
  return new ThreeLayerMemory(config);
}

/**
 * Get a persisted three-layer memory instance.
 * Data is stored at `.commander/memory/three-layer.json` relative to the given base path.
 *
 * @deprecated (audit MED item 1 — Phase A additive) Use `createThreeLayerMemory`
 * with `memoryStore` set instead. The `.commander/memory/three-layer.json` file
 * persistence path will be retired in Phase C. This entry point is preserved
 * for backward compatibility only and should not be used in new code.
 */
export function createPersistedThreeLayerMemory(basePath?: string): ThreeLayerMemory {
  const persistPath = basePath ? `${basePath}/three-layer.json` : DEFAULT_PERSIST_PATH;
  return new ThreeLayerMemory({ persistPath });
}

/**
 * Pure mapping from a Three-layer MemoryEntry to MemoryWriteOptions.
 *
 * Exposed top-level so unit tests can lock the contract without spinning up
 * a ThreeLayerMemory instance. Decision matrix per audit MED item 1:
 *
 *   working     → not routed (caller already filters)
 *   episodic    → kind=SUMMARY,  duration=EPISODIC
 *   longterm    → kind=DECISION if importance >= 0.7 else LESSON, duration=LONG_TERM
 *   procedural  → kind=LESSON,   duration=EPISODIC   (Phase D: procedural
 *                   fields proceduralType/successRate/usageCount/conditions
 *                   are now preserved via the `meta` JSON column.)
 */
export function mapMemoryEntryToWriteOptions(
  entry: MemoryEntry,
  projectId: string = 'default',
): MemoryWriteOptions {
  const kind: MemoryKind =
    entry.layer === 'longterm'
      ? entry.importance >= 0.7
        ? 'DECISION'
        : 'LESSON'
      : entry.layer === 'episodic'
        ? 'SUMMARY'
        : 'LESSON'; // procedural or fallback
  const duration = entry.layer === 'longterm' ? 'LONG_TERM' : 'EPISODIC';

  // Phase D: preserve procedural fields via meta
  const meta: import('./memory').MemoryMeta | undefined =
    entry.layer === 'procedural' || entry.proceduralType
      ? {
          proceduralType: entry.proceduralType,
          successRate: entry.successRate,
          usageCount: entry.usageCount,
          conditions: entry.conditions,
        }
      : undefined;

  return {
    // Thread entry.id so SqliteMemoryStore.write uses it as the row's ID —
    // this lets routeOutDelete(entry.id) in evictIfNeeded find and remove the
    // same row. Without this, SqliteMemoryStore auto-generates a
    // `memory-<ts>-<rand>` ID and the eviction delete silently no-ops.
    id: entry.id,
    projectId,
    missionId: undefined,
    agentId: undefined,
    kind,
    duration,
    title: (entry.context || entry.content).substring(0, 100),
    content: entry.content,
    tags: entry.tags,
    priority: Math.round(entry.importance * 100),
    confidence: entry.importance,
    meta,
  };
}

/**
 * Wire the global three-layer singleton to a persistent MemoryStore
 * (audit MED item 1 Phase A). Idempotent — call with null to clear.
 * Caller-controlled initialization avoids implicit module-load coupling
 * with the unified-memory bootstrap.
 */
export function wireGlobalThreeLayerMemory(store: MemoryStore | null): void {
  memorySingleton.get().setMemoryStore(store);
}
