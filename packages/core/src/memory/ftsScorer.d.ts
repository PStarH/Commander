/**
 * FTS5-style BM25 Scorer for In-Memory Memory Stores
 *
 * Implements Okapi BM25 ranking without requiring SQLite.
 * Used by JsonMemoryStore and ThreeLayerMemory for high-quality
 * full-text search across memory entries.
 *
 * BM25 formula:
 *   score(D, Q) = Σ IDF(qi) * (f(qi, D) * (k1 + 1)) / (f(qi, D) + k1 * (1 - b + b * |D| / avgdl))
 *
 * Where:
 *   - IDF(qi) = log((N - n(qi) + 0.5) / (n(qi) + 0.5) + 1)
 *   - f(qi, D) = term frequency of qi in document D
 *   - |D| = document length (in tokens)
 *   - avgdl = average document length
 *   - k1 = 1.2 (term frequency saturation)
 *   - b = 0.75 (length normalization)
 *
 * Reference: SQLite FTS5 bm25() function, Robertson & Zaragoza (2009)
 */
export interface BM25Config {
    /** Term frequency saturation (default: 1.2) */
    k1: number;
    /** Length normalization (default: 0.75) */
    b: number;
    /** Minimum token length to index (default: 2) */
    minTokenLength: number;
}
/**
 * Tokenize text for BM25 indexing.
 * Handles English, CJK (Chinese/Japanese/Korean), and programming terms.
 */
export declare function tokenizeForBM25(text: string, minLength?: number): string[];
export interface BM25Document {
    id: string;
    tokens: string[];
    /** Additional fields to boost (e.g., title weighted 2x) */
    fieldTokens?: Map<string, string[]>;
}
export interface BM25Result {
    id: string;
    score: number;
}
/**
 * In-memory BM25 scorer for fast full-text search.
 * Indexes documents and scores queries using Okapi BM25.
 */
export declare class BM25Scorer {
    private config;
    /** Document frequency: term → number of documents containing it */
    private df;
    /** All indexed documents */
    private documents;
    /** Total document count */
    private N;
    /** Average document length */
    private avgDocLength;
    /** Total token count (for computing avgDocLength) */
    private totalTokens;
    /** Whether the index needs rebuilding */
    private dirty;
    constructor(config?: Partial<BM25Config>);
    /**
     * Index a document for BM25 search.
     */
    addDocument(id: string, text: string, fieldTexts?: Map<string, string>): void;
    /**
     * Remove a document from the index.
     */
    removeDocument(id: string): void;
    /**
     * Score a query against all indexed documents using BM25.
     * Returns results sorted by score (highest first).
     */
    score(query: string, limit?: number): BM25Result[];
    /**
     * Score a single document against query terms using BM25.
     */
    private scoreDocument;
    /**
     * Get index statistics.
     */
    getStats(): {
        documents: number;
        terms: number;
        avgDocLength: number;
    };
    /**
     * Serialize the index for persistence.
     */
    serialize(): object;
    /**
     * Deserialize a previously serialized index.
     */
    static deserialize(data: {
        config?: Partial<BM25Config>;
        df: Array<[string, number]>;
        documents: Array<{
            id: string;
            tokens: string[];
            fieldTokens?: Array<[string, string[]]>;
        }>;
        N: number;
        totalTokens: number;
        avgDocLength: number;
    }): BM25Scorer;
}
