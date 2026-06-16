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
  context: string;         // 关联上下文
  importance: number;      // 0-1, 重要程度
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  decayScore: number;      // 衰减分数 (episodic layer)
  tags: string[];
  metadata: Record<string, unknown>;
  // L4 Procedural 层专用字段
  proceduralType?: 'sop' | 'tool' | 'workflow' | 'heuristic';
  successRate?: number;       // 使用成功率 0-1
  usageCount?: number;         // 被调用次数
  conditions?: string[];       // 适用条件列表
}

export interface MemoryQuery {
  layer?: MemoryLayer;
  keywords?: string[];
  context?: string;
  importanceThreshold?: number;
  limit?: number;
  since?: string;  // ISO date string
}

export interface MemoryStats {
  totalEntries: number;
  byLayer: Record<MemoryLayer, number>;
  averageImportance: number;
  averageAccessCount: number;
  totalMemoryUsed: number;  // bytes estimate
}

// ========================================
// Layer Configuration
// ========================================

interface LayerConfig {
  maxEntries: number;
  maxMemoryBytes: number;
  decayRate: number;        // 每次访问后的衰减
  baseDecayPerHour: number; // 每小时基础衰减
  importanceBoost: number;  // 高重要性项衰减减慢
}

const DEFAULT_CONFIG: Record<MemoryLayer, LayerConfig> = {
  working: {
    maxEntries: 50,
    maxMemoryBytes: 100000,  // 100KB
    decayRate: 0,
    baseDecayPerHour: 0,
    importanceBoost: 0
  },
  episodic: {
    maxEntries: 500,
    maxMemoryBytes: 500000, // 500KB
    decayRate: 0.05,
    baseDecayPerHour: 0.01,
    importanceBoost: 0.02
  },
  longterm: {
    maxEntries: 10000,
    maxMemoryBytes: 5000000, // 5MB
    decayRate: 0,
    baseDecayPerHour: 0,
    importanceBoost: 0
  },
  procedural: {
    maxEntries: 5000,
    maxMemoryBytes: 2000000, // 2MB
    decayRate: 0.02,
    baseDecayPerHour: 0.005,
    importanceBoost: 0.01
  }
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

  /** Quality gate for memory storage decisions (0 tokens per check) */
  private qualityGate: MemoryQualityGate;
  /** Thompson scorer for memory usefulness tracking (0 tokens per check) */
  private thompsonScorer: ThompsonMemoryScorer;

  constructor(config?: Partial<Record<MemoryLayer, LayerConfig>>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.qualityGate = new MemoryQualityGate();
    this.thompsonScorer = new ThompsonMemoryScorer();
  }

  setEmbeddingFunction(fn: EmbeddingFunction): void {
    this.embeddingFn = fn;
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
    metadata: Record<string, unknown> = {}
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

    const entryMetadata: Record<string, unknown> = contradictionIds.length > 0
      ? { ...metadata, contradictions: contradictionIds }
      : metadata;

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
      metadata: entryMetadata
    };

    this.memories.set(entry.id, entry);

    // Generate embedding if function is configured (fire-and-forget for async)
    if (this.embeddingFn && layer !== 'working') {
      const combined = `${content} ${context} ${tags.join(' ')}`;
      const result = this.embeddingFn.generate(combined);
      if (result instanceof Promise) {
        result.then(emb => this.embedStore.setEmbedding(entry.id, emb)).catch(e => getGlobalLogger().debug('ThreeLayerMemory', 'embedding error', { error: (e as Error)?.message }));
      } else {
        this.embedStore.setEmbedding(entry.id, result);
      }
    }
    this.embedStore.setEntry(entry.id, entry);

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
      entry.decayScore = Math.max(0,
        entry.decayScore - config.decayRate * (1 - entry.importance * config.importanceBoost)
      );
    }

    // Procedural 层应用衰减
    if (entry.layer === 'procedural') {
      const config = this.config.procedural;
      entry.decayScore = Math.max(0,
        entry.decayScore - config.decayRate * (1 - entry.importance * config.importanceBoost)
      );
    }
  }

  /**
   * 查询记忆 (with embedding-aware scoring)
   */
  query(query: MemoryQuery): MemoryEntry[] {
    let results = Array.from(this.memories.values());

    // 按层过滤
    if (query.layer) {
      results = results.filter(m => m.layer === query.layer);
    }

    // 按关键词过滤
    if (query.keywords && query.keywords.length > 0) {
      results = results.filter(m => {
        const text = `${m.content} ${m.context} ${m.tags.join(' ')}`.toLowerCase();
        return query.keywords!.some(kw => text.includes(kw.toLowerCase()));
      });
    }

    // 按上下文过滤
    if (query.context) {
      results = results.filter(m => 
        m.context.toLowerCase().includes(query.context!.toLowerCase())
      );
    }

    // 按重要性过滤
    if (query.importanceThreshold !== undefined) {
      results = results.filter(m => m.importance >= query.importanceThreshold!);
    }

    // 按时间过滤
    if (query.since) {
      const since = new Date(query.since);
      results = results.filter(m => new Date(m.createdAt) >= since);
    }

    // Compute query embedding once for similarity scoring
    let queryEmbedding: number[] | undefined;
    if (this.embeddingFn && query.keywords && query.keywords.length > 0) {
      const emb = this.embeddingFn.generate(query.keywords.join(' '));
      if (!(emb instanceof Promise)) {
        queryEmbedding = emb;
      }
      // If async, skip embedding scoring — the embedding was stored asynchronously
      // in add(), so it may not be available yet. Fall back to recency+importance.
    }

    // Sort by embedding-aware three-factor score (Generative Agents formula)
    results.sort((a, b) => {
      const scoreA = calculateMemoryScore(a, queryEmbedding, this.embedStore.getEmbedding(a.id));
      const scoreB = calculateMemoryScore(b, queryEmbedding, this.embedStore.getEmbedding(b.id));
      return scoreB - scoreA;
    });

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
    const results = this.query({ layer, limit });
    return results;
  }

  /**
   * 获取当前上下文 (working memory)
   */
  getWorkingContext(maxEntries: number = 10): MemoryEntry[] {
    const workingSlots = Math.max(1, Math.ceil(maxEntries * 0.7));
    const episodicSlots = Math.max(1, maxEntries - workingSlots);
    const working = this.getByLayer('working', workingSlots);
    const recentEpisodic = this.query({
      layer: 'episodic',
      limit: episodicSlots,
      importanceThreshold: 0.6
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
   * Uses Thompson scorer for better eviction decisions (0 tokens)
   */
  evictIfNeeded(layer: MemoryLayer): void {
    const config = this.config[layer];
    const layerMemories = Array.from(this.memories.values())
      .filter(m => m.layer === layer);

    // 超出数量限制
    if (layerMemories.length > config.maxEntries) {
      // 按综合分数排序，低分优先驱逐
      // Combines: importance, access count, decay score, and Thompson usefulness
      layerMemories.sort((a, b) => {
        const thompsonA = this.thompsonScorer.getMeanUsefulness(a.id);
        const thompsonB = this.thompsonScorer.getMeanUsefulness(b.id);

        const scoreA = (a.importance * 2 + a.accessCount + thompsonA * 3) - a.decayScore * 5;
        const scoreB = (b.importance * 2 + b.accessCount + thompsonB * 3) - b.decayScore * 5;
        return scoreA - scoreB;
      });

      const toRemove = layerMemories.slice(0, layerMemories.length - config.maxEntries);
      for (const entry of toRemove) {
        this.thompsonScorer.remove(entry.id);
        this.delete(entry.id);
      }
    }

    // Also evict Thompson-scorer eviction candidates (0 tokens)
    const thompsonEvictionCandidates = this.thompsonScorer.getEvictionCandidates();
    for (const id of thompsonEvictionCandidates) {
      const entry = this.memories.get(id);
      if (entry && entry.layer === layer) {
        this.delete(id);
        this.thompsonScorer.remove(id);
      }
    }
  }

  /**
   * 应用时间衰减 (定时调用)
   */
  applyTimeDecay(hoursElapsed: number): number {
    const toDelete: string[] = [];
    for (const entry of this.memories.values()) {
      if (entry.layer === 'episodic' || entry.layer === 'procedural') {
        const config = this.config[entry.layer];
        const decay = config.baseDecayPerHour * hoursElapsed *
          (1 - entry.importance * config.importanceBoost);
        entry.decayScore = Math.max(0, entry.decayScore - decay);

        if (entry.decayScore <= 0) {
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
 procedural: 0
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
      totalMemoryUsed: totalMemory
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
      .filter(w => w.length >= 2);

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
          const embScore = entryEmb
            ? calculateMemoryScore(entry, queryEmb, entryEmb)
            : 0;
          // Fallback keyword score for entries without embeddings
          const text = `${entry.content} ${entry.context} ${entry.tags.join(' ')}`.toLowerCase();
          const kwHits = keywords.filter(kw => text.includes(kw)).length;
          const kwScore = kwHits / keywords.length;
          // Blend: 70% embedding if available, 30% keyword
          const score = entryEmb ? embScore * 0.7 + kwScore * 0.3 : kwScore;
          if (score > 0) scored.push({ entry, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map(s => {
          this.updateAccess(s.entry);
          return s.entry;
        });
      }
    }

    // Fallback: keyword-only search
    return this.query({ keywords, limit });
  }

  /**
   * 清除特定层的所有记忆
   */
  clearLayer(layer: MemoryLayer): number {
    const entries = Array.from(this.memories.values()).filter(m => m.layer === layer);
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
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 1));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 1));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
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

const memorySingleton = createTenantAwareSingleton(() => new ThreeLayerMemory());

export function getGlobalThreeLayerMemory(): ThreeLayerMemory {
  return memorySingleton.get();
}

/** Reset the global memory singleton (for test isolation) */
export function resetGlobalThreeLayerMemory(): void {
  memorySingleton.reset();
}

export function createThreeLayerMemory(
  config?: Partial<Record<MemoryLayer, LayerConfig>>
): ThreeLayerMemory {
  return new ThreeLayerMemory(config);
}
