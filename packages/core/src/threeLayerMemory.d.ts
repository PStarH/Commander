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
import { MemoryQualityGate } from './memory/memoryQualityGate.js';
import { ThompsonMemoryScorer } from './memory/thompsonMemoryScorer.js';
export type MemoryLayer = 'working' | 'episodic' | 'longterm' | 'procedural';
export interface MemoryEntry {
    id: string;
    layer: MemoryLayer;
    content: string;
    context: string;
    importance: number;
    createdAt: string;
    lastAccessedAt: string;
    accessCount: number;
    decayScore: number;
    tags: string[];
    metadata: Record<string, unknown>;
    proceduralType?: 'sop' | 'tool' | 'workflow' | 'heuristic';
    successRate?: number;
    usageCount?: number;
    conditions?: string[];
}
export interface MemoryQuery {
    layer?: MemoryLayer;
    keywords?: string[];
    context?: string;
    importanceThreshold?: number;
    limit?: number;
    since?: string;
}
export interface MemoryStats {
    totalEntries: number;
    byLayer: Record<MemoryLayer, number>;
    averageImportance: number;
    averageAccessCount: number;
    totalMemoryUsed: number;
}
interface LayerConfig {
    maxEntries: number;
    maxMemoryBytes: number;
    decayRate: number;
    baseDecayPerHour: number;
    importanceBoost: number;
}
import { InMemoryEmbeddingStore } from './runtime/embedding';
import type { EmbeddingFunction } from './runtime/embedding';
export declare class ThreeLayerMemory {
    private memories;
    private config;
    private embeddingFn;
    private embedStore;
    /** Quality gate for memory storage decisions (0 tokens per check) */
    private qualityGate;
    /** Thompson scorer for memory usefulness tracking (0 tokens per check) */
    private thompsonScorer;
    constructor(config?: Partial<Record<MemoryLayer, LayerConfig>>);
    setEmbeddingFunction(fn: EmbeddingFunction): void;
    getEmbeddingStore(): InMemoryEmbeddingStore;
    /**
     * 添加记忆 (with optional embedding and quality gate)
     *
     * Quality gate (0 tokens): rule filter + quality checks
     * Embedding (0 tokens): fire-and-forget for async
     */
    add(content: string, layer: MemoryLayer, context?: string, importance?: number, tags?: string[], metadata?: Record<string, unknown>): MemoryEntry;
    /**
     * 获取记忆
     */
    get(id: string): MemoryEntry | undefined;
    /**
     * 更新访问
     */
    private updateAccess;
    /**
     * 查询记忆 (with embedding-aware scoring)
     */
    query(query: MemoryQuery): MemoryEntry[];
    /**
     * 获取特定层的记忆
     */
    getByLayer(layer: MemoryLayer, limit?: number): MemoryEntry[];
    /**
     * 获取当前上下文 (working memory)
     */
    getWorkingContext(maxEntries?: number): MemoryEntry[];
    /**
     * 删除记忆
     */
    delete(id: string): boolean;
    /**
     * 将记忆升级到长期层
     */
    promoteToLongTerm(id: string): boolean;
    /**
     * 归档到情景层
     */
    archiveToEpisodic(id: string): boolean;
    /**
     * 驱逐过期的记忆
     *
     * Uses Thompson scorer for better eviction decisions (0 tokens)
     */
    evictIfNeeded(layer: MemoryLayer): void;
    /**
     * 应用时间衰减 (定时调用)
     */
    applyTimeDecay(hoursElapsed: number): number;
    /**
     * 获取统计信息
     */
    getStats(): MemoryStats;
    /**
     * 搜索相关记忆 — combines keyword matching with embedding similarity
     */
    searchRelated(content: string, limit?: number): MemoryEntry[];
    /**
     * 清除特定层的所有记忆
     */
    clearLayer(layer: MemoryLayer): number;
    /**
     * 获取所有记忆 (调试用)
     */
    getAll(): MemoryEntry[];
    /**
     * Get the Thompson memory scorer
     *
     * Use to update usefulness after memory retrieval
     */
    getThompsonScorer(): ThompsonMemoryScorer;
    /**
     * Get the quality gate
     *
     * Use for custom quality checks
     */
    getQualityGate(): MemoryQualityGate;
    /**
     * Simple text similarity measure (Jaccard index on word bigrams).
     * Fast and zero-token — used for contradiction detection.
     * Returns 0-1 score where 1 = identical word content.
     */
    private textSimilarity;
    /**
     * Update memory usefulness (Thompson scoring)
     *
     * Call this after retrieving a memory to track if it was useful.
     * Token cost: 0 (pure computation)
     */
    updateMemoryUsefulness(memoryId: string, wasUseful: boolean): void;
    /**
     * Get spreading activation score for a memory
     *
     * ACT-R style activation: B + exp(-t/S) + log(1 + accessCount)
     * Token cost: 0 (pure computation)
     */
    getActivationScore(entry: MemoryEntry): number;
}
export declare function getGlobalThreeLayerMemory(): ThreeLayerMemory;
/** Reset the global memory singleton (for test isolation) */
export declare function resetGlobalThreeLayerMemory(): void;
export declare function createThreeLayerMemory(config?: Partial<Record<MemoryLayer, LayerConfig>>): ThreeLayerMemory;
export {};
//# sourceMappingURL=threeLayerMemory.d.ts.map