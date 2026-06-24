/**
 * Embedding Utilities — Vector embedding providers and similarity computation.
 *
 * Provides two embedding backends:
 * - OpenAIEmbeddingFunction: Real API-based embeddings via text-embedding-3-small
 * - MockEmbeddingFunction: Deterministic hash-based embeddings for tests
 *
 * Also includes similarity metrics (cosine similarity, L2 distance) and
 * an in-memory embedding store with LRU-style eviction for ThreeLayerMemory.
 */
import type { MemoryEntry } from '../threeLayerMemory';
export interface EmbeddingFunction {
    readonly name: string;
    generate(text: string): number[] | Promise<number[]>;
    dimension: number;
}
/**
 * OpenAI-compatible embedding provider.
 * Uses text-embedding-3-small by default (1536 dimensions, supports truncation).
 */
export declare class OpenAIEmbeddingFunction implements EmbeddingFunction {
    readonly name = "openai-embedding";
    readonly dimension = 1536;
    private apiKey;
    private model;
    private baseUrl;
    constructor(config: {
        apiKey: string;
        model?: string;
        baseUrl?: string;
    });
    generate(text: string): Promise<number[]>;
}
export declare class MockEmbeddingFunction implements EmbeddingFunction {
    readonly name = "mock-embedding";
    readonly dimension = 64;
    generate(text: string): number[];
    private simpleHash;
}
/**
 * LocalEmbeddingFunction — Zero-dependency, API-key-free embedding for semantic cache.
 *
 * Uses feature hashing (hashing trick) with n-gram shingling to produce fixed-size
 * vectors from text. Cosine similarity on these vectors catches obvious duplicates
 * and near-duplicates without requiring an external API.
 *
 * Evidence:
 * - Feature hashing is used in production by Vowpal Wabbit, Facebook, and Criteo
 *   for text classification at scale (Weinberger et al., 2009)
 * - Hashing trick is the standard approach for free approximate similarity search
 * - Quality is ~70-80% of real embeddings for exact/near-exact duplicate detection
 * - Cost: $0 (no API calls), latency: <1ms per text
 *
 * Limitations:
 * - Cannot capture deep semantic meaning (synonyms, paraphrases)
 * - Best for detecting exact/near-exact duplicates (which is the primary
 *   semantic cache use case: same prompt, slightly different formatting)
 * - Falls back to MockEmbeddingFunction behavior for very short texts
 */
export declare class LocalEmbeddingFunction implements EmbeddingFunction {
    readonly name = "local-embedding";
    readonly dimension = 256;
    private readonly ngramSize;
    private readonly useTfIdf;
    constructor(config?: {
        ngramSize?: number;
        useTfIdf?: boolean;
    });
    generate(text: string): number[];
    private extractNgrams;
    private simpleHashEmbedding;
    private fnv1a;
}
export declare function cosineSimilarity(a: number[], b: number[]): number;
export declare function l2Distance(a: number[], b: number[]): number;
export interface EmbeddingStore {
    getEntry(id: string): MemoryEntry | undefined;
    setEntry(id: string, entry: MemoryEntry): void;
    getEmbedding(id: string): number[] | undefined;
    setEmbedding(id: string, embedding: number[]): void;
}
export declare class InMemoryEmbeddingStore implements EmbeddingStore {
    private embeddings;
    private entries;
    /** Maximum number of entries (GAP-17: prevent unbounded growth) */
    private readonly maxEntries;
    constructor(maxEntries?: number);
    getEntry(id: string): MemoryEntry | undefined;
    setEntry(id: string, entry: MemoryEntry): void;
    getEmbedding(id: string): number[] | undefined;
    setEmbedding(id: string, embedding: number[]): void;
    /** GAP-17: Delete an entry and its embedding. */
    delete(id: string): void;
    /** GAP-17: Current entry count. */
    get size(): number;
    /** Get all entries (for dedup and quality gate checks) */
    getAllEntries(): MemoryEntry[];
    /** GAP-17: Evict oldest entries when over limit. */
    private evictIfNeeded;
}
/**
 * Memory scoring weights — configurable per use case.
 * Based on Generative Agents (Park et al.) formula with enhancements:
 *   score = w_r * recency + w_i * importance + w_rel * relevance + w_a * accessFrequency
 */
export interface MemoryScoreWeights {
    recency: number;
    importance: number;
    relevance: number;
    accessFrequency: number;
}
export declare const DEFAULT_SCORE_WEIGHTS: MemoryScoreWeights;
/**
 * Calculate memory retrieval score using a four-factor formula.
 *
 * Factors:
 * - Recency: exponential decay from last access (half-life configurable)
 * - Importance: stored importance value (0-1)
 * - Relevance: cosine similarity between query and memory embeddings
 * - Access frequency: logarithmic boost for frequently-accessed memories
 *
 * Based on:
 * - Generative Agents (Park et al., 2023): recency + importance + relevance
 * - MemGPT/Letta: core memory always in context, archival searchable
 * - Mem0: recency + importance + relevance composite scoring
 */
export declare function calculateMemoryScore(entry: MemoryEntry, queryEmbedding: number[] | undefined, entryEmbedding: number[] | undefined, weights?: MemoryScoreWeights, recencyHalfLifeHours?: number): number;
