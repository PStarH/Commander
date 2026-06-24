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
import type { MemoryStore, MemoryWriteOptions } from './memory';
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
    private persistPath;
    /** Quality gate for memory storage decisions (0 tokens per check) */
    private qualityGate;
    /** Thompson scorer for memory usefulness tracking (0 tokens per check) */
    private thompsonScorer;
    /** Optional persistent sink for non-working layers (audit MED item 1 Phase A) */
    private memoryStore;
    constructor(config?: Partial<Record<MemoryLayer, LayerConfig>> & {
        persistPath?: string;
        memoryStore?: MemoryStore;
    });
    /**
     * Persist memory state (non-embedding data) to disk as JSON.
     * Embeddings are regenerated on load and are not persisted.
     * Returns the number of entries persisted.
     */
    save(): number;
    /**
     * Load memory state from disk.
     * Returns the number of entries restored, or 0 if no saved state exists.
     */
    load(): number;
    /** Returns true if a persist path is configured */
    hasPersistence(): boolean;
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
    setMemoryStore(store: MemoryStore | null): void;
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
    evictIfNeeded(layer: MemoryLayer): void;
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
export declare function createThreeLayerMemory(config?: Partial<Record<MemoryLayer, LayerConfig>> & {
    persistPath?: string;
    memoryStore?: MemoryStore;
}): ThreeLayerMemory;
/**
 * Get a persisted three-layer memory instance.
 * Data is stored at `.commander/memory/three-layer.json` relative to the given base path.
 *
 * @deprecated (audit MED item 1 — Phase A additive) Use `createThreeLayerMemory`
 * with `memoryStore` set instead. The `.commander/memory/three-layer.json` file
 * persistence path will be retired in Phase C. This entry point is preserved
 * for backward compatibility only and should not be used in new code.
 */
export declare function createPersistedThreeLayerMemory(basePath?: string): ThreeLayerMemory;
/**
 * Pure mapping from a Three-layer MemoryEntry to MemoryWriteOptions.
 *
 * Exposed top-level so unit tests can lock the contract without spinning up
 * a ThreeLayerMemory instance. Decision matrix per audit MED item 1:
 *
 *   working     → not routed (caller already filters)
 *   episodic    → kind=SUMMARY,  duration=EPISODIC
 *   longterm    → kind=DECISION if importance >= 0.7 else LESSON, duration=LONG_TERM
 *   procedural  → kind=LESSON,   duration=EPISODIC   (Phase A lossiness —
 *                   accepts that the typed proceduralType/successRate/
 *                   usageCount/conditions fields are dropped. Verified by
 *                   pre-flight grep: no production code reads them on a
 *                   MemoryEntry. Phase D restores via a `meta` JSON column.)
 */
export declare function mapMemoryEntryToWriteOptions(entry: MemoryEntry, projectId?: string): MemoryWriteOptions;
/**
 * Wire the global three-layer singleton to a persistent MemoryStore
 * (audit MED item 1 Phase A). Idempotent — call with null to clear.
 * Caller-controlled initialization avoids implicit module-load coupling
 * with the unified-memory bootstrap.
 */
export declare function wireGlobalThreeLayerMemory(store: MemoryStore | null): void;
export {};
