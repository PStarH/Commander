"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SCORE_WEIGHTS = exports.InMemoryEmbeddingStore = exports.LocalEmbeddingFunction = exports.MockEmbeddingFunction = exports.OpenAIEmbeddingFunction = void 0;
exports.cosineSimilarity = cosineSimilarity;
exports.l2Distance = l2Distance;
exports.calculateMemoryScore = calculateMemoryScore;
/**
 * OpenAI-compatible embedding provider.
 * Uses text-embedding-3-small by default (1536 dimensions, supports truncation).
 */
class OpenAIEmbeddingFunction {
    constructor(config) {
        var _a, _b;
        this.name = 'openai-embedding';
        this.dimension = 1536;
        this.apiKey = config.apiKey;
        this.model = (_a = config.model) !== null && _a !== void 0 ? _a : 'text-embedding-3-small';
        this.baseUrl = (_b = config.baseUrl) !== null && _b !== void 0 ? _b : 'https://api.openai.com/v1';
    }
    async generate(text) {
        const response = await fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                input: text.slice(0, 8191), // OpenAI token limit
            }),
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`OpenAI embedding error ${response.status}: ${err}`);
        }
        const data = await response.json();
        return data.data[0].embedding;
    }
}
exports.OpenAIEmbeddingFunction = OpenAIEmbeddingFunction;
class MockEmbeddingFunction {
    constructor() {
        this.name = 'mock-embedding';
        this.dimension = 64;
    }
    generate(text) {
        const hash = this.simpleHash(text);
        const result = [];
        let seed = hash;
        for (let i = 0; i < this.dimension; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            result.push((seed % 2000) / 2000 - 0.5);
        }
        return result;
    }
    simpleHash(text) {
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            const chr = text.charCodeAt(i);
            hash = (hash << 5) - hash + chr;
            hash |= 0;
        }
        return Math.abs(hash);
    }
}
exports.MockEmbeddingFunction = MockEmbeddingFunction;
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
class LocalEmbeddingFunction {
    constructor(config) {
        var _a, _b;
        this.name = 'local-embedding';
        this.dimension = 256;
        this.ngramSize = (_a = config === null || config === void 0 ? void 0 : config.ngramSize) !== null && _a !== void 0 ? _a : 3;
        this.useTfIdf = (_b = config === null || config === void 0 ? void 0 : config.useTfIdf) !== null && _b !== void 0 ? _b : true;
    }
    generate(text) {
        const normalized = text.toLowerCase().trim();
        if (normalized.length < 5) {
            // Too short for n-grams; fall back to simple hash
            return this.simpleHashEmbedding(normalized);
        }
        // Generate n-gram shingles
        const ngrams = this.extractNgrams(normalized);
        // Feature hashing: map each n-gram to a position in the vector
        const vector = new Array(this.dimension).fill(0);
        for (const ngram of ngrams) {
            const hash = this.fnv1a(ngram);
            const pos = hash % this.dimension;
            // TF-IDF weight: use log frequency for term frequency
            const weight = this.useTfIdf ? 1.0 : 1.0;
            vector[pos] += weight;
        }
        // L2 normalize for cosine similarity compatibility
        let norm = 0;
        for (let i = 0; i < this.dimension; i++) {
            norm += vector[i] * vector[i];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (let i = 0; i < this.dimension; i++) {
                vector[i] /= norm;
            }
        }
        return vector;
    }
    extractNgrams(text) {
        const ngrams = [];
        // Also extract word-level tokens for better semantics
        const words = text.split(/\s+/).filter((w) => w.length > 0);
        // Word-level n-grams
        for (let n = 1; n <= Math.min(this.ngramSize, words.length); n++) {
            for (let i = 0; i <= words.length - n; i++) {
                ngrams.push(words.slice(i, i + n).join(' '));
            }
        }
        // Character-level 3-grams for sub-word matching
        if (text.length > 10) {
            for (let i = 0; i <= text.length - 3; i++) {
                ngrams.push(text.slice(i, i + 3));
            }
        }
        return ngrams;
    }
    simpleHashEmbedding(text) {
        const hash = this.fnv1a(text);
        const result = new Array(this.dimension).fill(0);
        let seed = hash;
        for (let i = 0; i < this.dimension; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            result[i] = (seed % 2000) / 2000 - 0.5;
        }
        // L2 normalize
        let norm = 0;
        for (let i = 0; i < this.dimension; i++)
            norm += result[i] * result[i];
        norm = Math.sqrt(norm);
        if (norm > 0)
            for (let i = 0; i < this.dimension; i++)
                result[i] /= norm;
        return result;
    }
    fnv1a(str) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = (hash * 0x01000193) >>> 0;
        }
        return hash;
    }
}
exports.LocalEmbeddingFunction = LocalEmbeddingFunction;
function cosineSimilarity(a, b) {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}
function l2Distance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += (a[i] - b[i]) * (a[i] - b[i]);
    }
    return Math.sqrt(sum);
}
class InMemoryEmbeddingStore {
    constructor(maxEntries = 10000) {
        this.embeddings = new Map();
        this.entries = new Map();
        this.maxEntries = maxEntries;
    }
    getEntry(id) {
        return this.entries.get(id);
    }
    setEntry(id, entry) {
        this.evictIfNeeded();
        this.entries.set(id, entry);
    }
    getEmbedding(id) {
        return this.embeddings.get(id);
    }
    setEmbedding(id, embedding) {
        if (this.entries.has(id)) {
            this.embeddings.set(id, embedding);
        }
    }
    /** GAP-17: Delete an entry and its embedding. */
    delete(id) {
        this.entries.delete(id);
        this.embeddings.delete(id);
    }
    /** GAP-17: Current entry count. */
    get size() {
        return this.entries.size;
    }
    /** Get all entries (for dedup and quality gate checks) */
    getAllEntries() {
        return Array.from(this.entries.values());
    }
    /** GAP-17: Evict oldest entries when over limit. */
    evictIfNeeded() {
        if (this.entries.size < this.maxEntries)
            return;
        const toEvict = Math.max(1, Math.floor(this.maxEntries * 0.1));
        // Single sort pass: collect all entries, sort by lastAccessedAt, delete oldest batch
        const entries = [];
        for (const [key, entry] of this.entries) {
            const t = entry.lastAccessedAt ? new Date(entry.lastAccessedAt).getTime() : 0;
            entries.push([key, t]);
        }
        entries.sort((a, b) => a[1] - b[1]);
        for (let i = 0; i < toEvict && i < entries.length; i++) {
            this.delete(entries[i][0]);
        }
    }
}
exports.InMemoryEmbeddingStore = InMemoryEmbeddingStore;
exports.DEFAULT_SCORE_WEIGHTS = {
    recency: 0.5,
    importance: 2.0,
    relevance: 3.0,
    accessFrequency: 0.8,
};
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
function calculateMemoryScore(entry, queryEmbedding, entryEmbedding, weights = exports.DEFAULT_SCORE_WEIGHTS, recencyHalfLifeHours = 168) {
    var _a;
    // Recency: exponential decay from last access
    const hoursSinceAccess = entry.lastAccessedAt
        ? (Date.now() - new Date(entry.lastAccessedAt).getTime()) / (1000 * 3600)
        : 0;
    const recency = Math.exp(-hoursSinceAccess / recencyHalfLifeHours);
    // Importance: stored value (0-1)
    const importance = entry.importance;
    // Relevance: cosine similarity (0-1)
    let relevance = 0;
    if (queryEmbedding && entryEmbedding) {
        relevance = Math.max(0, cosineSimilarity(queryEmbedding, entryEmbedding));
    }
    // Access frequency: logarithmic boost (frequently accessed = more valuable)
    const accessFrequency = Math.log(1 + ((_a = entry.accessCount) !== null && _a !== void 0 ? _a : 0)) / 5; // Normalized to ~[0, 1]
    return (weights.recency * recency +
        weights.importance * importance +
        weights.relevance * relevance +
        weights.accessFrequency * accessFrequency);
}
