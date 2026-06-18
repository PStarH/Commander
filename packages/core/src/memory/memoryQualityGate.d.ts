/**
 * Memory Quality Gate
 *
 * Multi-layer quality gate for memory storage decisions.
 * Based on Self-RAG (Asai et al., 2023) and Multi-Agent Debate (Liang et al., 2023).
 *
 * Layers:
 * 1. Rule filter (0 tokens) - fast rejection of low-quality content
 * 2. Quality gate (0 tokens) - heuristic quality checks
 * 3. Deduplication (0-100 tokens) - embedding similarity check
 * 4. Consensus voting (0 tokens) - multi-signal agreement
 *
 * @module memory/memoryQualityGate
 */
import type { MemoryEntry } from '../threeLayerMemory.js';
import type { InMemoryEmbeddingStore } from '../runtime/embedding.js';
/** A single consensus vote */
export interface ConsensusVote {
    signal: string;
    shouldStore: boolean;
    confidence: number;
    reason: string;
}
/** Result of quality gate evaluation */
export interface QualityGateResult {
    store: boolean;
    confidence: number;
    reason: string;
    votes: ConsensusVote[];
    layer: 'rule_filter' | 'quality_gate' | 'dedup' | 'consensus' | 'passed';
}
/** Configuration for MemoryQualityGate */
export interface QualityGateConfig {
    /** Minimum content length (default: 20) */
    minContentLength: number;
    /** Maximum content length before compression required (default: 500) */
    maxContentLength: number;
    /** Minimum information density (uniqueWords / totalWords, default: 0.3) */
    minDensity: number;
    /** Embedding similarity threshold for dedup (default: 0.85) */
    dedupThreshold: number;
    /** Consensus threshold for final decision (default: 0.6) */
    consensusThreshold: number;
    /** Action keywords that indicate actionable content */
    actionKeywords: string[];
    /** Fact keywords that indicate factual content */
    factKeywords: string[];
}
/**
 * Memory Quality Gate
 *
 * Multi-layer quality gate for memory storage decisions.
 * All checks are zero-cost (no LLM calls) except optional embedding dedup.
 */
export declare class MemoryQualityGate {
    private config;
    constructor(config?: Partial<QualityGateConfig>);
    /**
     * Full quality gate evaluation
     *
     * Runs all layers in order. Stops at first rejection.
     *
     * Token cost: 0-100 (only if dedup uses embedding)
     */
    evaluate(entry: MemoryEntry, embedStore?: InMemoryEmbeddingStore, queryEmbedding?: number[]): Promise<QualityGateResult>;
    /**
     * Rule filter - fast rejection of obviously low-quality content
     *
     * Token cost: 0 (pure string operations)
     */
    passesRuleFilter(content: string): {
        passed: boolean;
        reason: string;
    };
    /**
     * Quality gate - heuristic quality checks
     *
     * Token cost: 0 (pure computation)
     */
    passesQualityGate(entry: MemoryEntry): {
        passed: boolean;
        reason: string;
    };
    /**
     * Check for duplicate memories using embedding similarity
     *
     * Token cost: 0 (uses existing embeddings)
     */
    checkDuplicate(content: string, embedStore: InMemoryEmbeddingStore, queryEmbedding: number[]): Promise<{
        isDuplicate: boolean;
        similarity: number;
        duplicateId?: string;
    }>;
    /**
     * Collect consensus votes from multiple signals
     *
     * Token cost: 0 (uses existing data)
     */
    private collectVotes;
    /**
     * Evaluate consensus from votes
     *
     * Token cost: 0 (pure computation)
     */
    private evaluateConsensus;
}
/**
 * Lightweight quality check for fast path (no async, no embedding)
 *
 * Token cost: 0
 */
export declare function quickQualityCheck(content: string, importance: number): boolean;
//# sourceMappingURL=memoryQualityGate.d.ts.map