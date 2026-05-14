/**
 * Three-Layer Memory System
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 * 
 * Core insight: 模拟人类记忆的三个层次
 * - Working Memory: 当前上下文，快速但有限
 * - Episodic Memory: 近期经验，会逐渐遗忘
 * - Long-term Memory: 持久知识，稳定但需要检索
 */

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
  metadata: Record<string, any>;
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

export class ThreeLayerMemory {
  private memories: Map<string, MemoryEntry> = new Map();
  private config: Record<MemoryLayer, LayerConfig>;
  private accessOrder: string[] = []; // LRU 顺序
  private embeddingFn: EmbeddingFunction | null = null;
  private embedStore: InMemoryEmbeddingStore = new InMemoryEmbeddingStore();

  constructor(config?: Partial<Record<MemoryLayer, LayerConfig>>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setEmbeddingFunction(fn: EmbeddingFunction): void {
    this.embeddingFn = fn;
  }

  getEmbeddingStore(): InMemoryEmbeddingStore {
    return this.embedStore;
  }

  /**
   * 添加记忆 (with optional embedding)
   */
  add(
    content: string,
    layer: MemoryLayer,
    context: string = '',
    importance: number = 0.5,
    tags: string[] = [],
    metadata: Record<string, any> = {}
  ): MemoryEntry {
    const entry: MemoryEntry = {
      id: generateUUID(),
      layer,
      content,
      context,
      importance,
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      accessCount: 0,
      decayScore: layer === 'episodic' ? 1.0 : 0,
      tags,
      metadata
    };

    this.memories.set(entry.id, entry);
    this.accessOrder.push(entry.id);

    // Generate embedding if function is configured (fire-and-forget for async)
    if (this.embeddingFn && layer !== 'working') {
      const combined = `${content} ${context} ${tags.join(' ')}`;
      const result = this.embeddingFn.generate(combined);
      if (result instanceof Promise) {
        result.then(emb => this.embedStore.setEmbedding(entry.id, emb)).catch(() => {});
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

    // 更新 LRU 顺序
    const idx = this.accessOrder.indexOf(entry.id);
    if (idx > -1) {
      this.accessOrder.splice(idx, 1);
    }
    this.accessOrder.push(entry.id);
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
    const working = this.getByLayer('working', maxEntries);
    const recentEpisodic = this.query({
      layer: 'episodic',
      limit: maxEntries,
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
    const idx = this.accessOrder.indexOf(id);
    if (idx > -1) {
      this.accessOrder.splice(idx, 1);
    }
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
   */
  evictIfNeeded(layer: MemoryLayer): void {
    const config = this.config[layer];
    const layerMemories = Array.from(this.memories.values())
      .filter(m => m.layer === layer);

    // 超出数量限制
    if (layerMemories.length > config.maxEntries) {
      // 按分数排序，低分优先驱逐
      layerMemories.sort((a, b) => {
        const scoreA = a.importance * a.accessCount - a.decayScore * 10;
        const scoreB = b.importance * b.accessCount - b.decayScore * 10;
        return scoreA - scoreB;
      });

      const toRemove = layerMemories.slice(0, layerMemories.length - config.maxEntries);
      for (const entry of toRemove) {
        this.delete(entry.id);
      }
    }
  }

  /**
   * 应用时间衰减 (定时调用)
   */
  applyTimeDecay(hoursElapsed: number): number {
    let decayed = 0;
    for (const entry of this.memories.values()) {
      if (entry.layer === 'episodic') {
        const config = this.config.episodic;
        const decay = config.baseDecayPerHour * hoursElapsed * 
          (1 - entry.importance * config.importanceBoost);
        entry.decayScore = Math.max(0, entry.decayScore - decay);
        
        // 衰减到 0 的记忆自动删除
        if (entry.decayScore <= 0) {
          this.delete(entry.id);
          decayed++;
        }
      }
    }
    return decayed;
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
   * 搜索相关记忆
   */
  searchRelated(content: string, limit: number = 5): MemoryEntry[] {
    // 简单的关键词匹配
    const keywords = content.toLowerCase().split(/\s+/).filter(w => w.length > 3);
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
}

// ========================================
// Factory
// ========================================

let globalMemory: ThreeLayerMemory | null = null;

export function getGlobalThreeLayerMemory(): ThreeLayerMemory {
  if (!globalMemory) {
    globalMemory = new ThreeLayerMemory();
  }
  return globalMemory;
}

export function createThreeLayerMemory(
  config?: Partial<Record<MemoryLayer, LayerConfig>>
): ThreeLayerMemory {
  return new ThreeLayerMemory(config);
}
