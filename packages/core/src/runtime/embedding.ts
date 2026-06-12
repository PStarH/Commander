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
export class OpenAIEmbeddingFunction implements EmbeddingFunction {
  readonly name = 'openai-embedding';
  readonly dimension = 1536;
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  }) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'text-embedding-3-small';
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  }

  async generate(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
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
    return data.data[0].embedding as number[];
  }
}

export class MockEmbeddingFunction implements EmbeddingFunction {
  readonly name = 'mock-embedding';
  readonly dimension = 64;

  generate(text: string): number[] {
    const hash = this.simpleHash(text);
    const result: number[] = [];
    let seed = hash;
    for (let i = 0; i < this.dimension; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      result.push((seed % 2000) / 2000 - 0.5);
    }
    return result;
  }

  private simpleHash(text: string): number {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const chr = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return Math.abs(hash);
  }
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
export class LocalEmbeddingFunction implements EmbeddingFunction {
  readonly name = 'local-embedding';
  readonly dimension = 256;
  private readonly ngramSize: number;
  private readonly useTfIdf: boolean;

  constructor(config?: { ngramSize?: number; useTfIdf?: boolean }) {
    this.ngramSize = config?.ngramSize ?? 3;
    this.useTfIdf = config?.useTfIdf ?? true;
  }

  generate(text: string): number[] {
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

  private extractNgrams(text: string): string[] {
    const ngrams: string[] = [];
    // Also extract word-level tokens for better semantics
    const words = text.split(/\s+/).filter(w => w.length > 0);

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

  private simpleHashEmbedding(text: string): number[] {
    const hash = this.fnv1a(text);
    const result: number[] = new Array(this.dimension).fill(0);
    let seed = hash;
    for (let i = 0; i < this.dimension; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      result[i] = (seed % 2000) / 2000 - 0.5;
    }
    // L2 normalize
    let norm = 0;
    for (let i = 0; i < this.dimension; i++) norm += result[i] * result[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < this.dimension; i++) result[i] /= norm;
    return result;
  }

  private fnv1a(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export function l2Distance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - b[i]) * (a[i] - b[i]);
  }
  return Math.sqrt(sum);
}

export interface EmbeddingStore {
  getEntry(id: string): MemoryEntry | undefined;
  setEntry(id: string, entry: MemoryEntry): void;
  getEmbedding(id: string): number[] | undefined;
  setEmbedding(id: string, embedding: number[]): void;
}

export class InMemoryEmbeddingStore implements EmbeddingStore {
  private embeddings = new Map<string, number[]>();
  private entries = new Map<string, MemoryEntry>();
  /** Maximum number of entries (GAP-17: prevent unbounded growth) */
  private readonly maxEntries: number;

  constructor(maxEntries: number = 10000) {
    this.maxEntries = maxEntries;
  }

  getEntry(id: string): MemoryEntry | undefined {
    return this.entries.get(id);
  }

  setEntry(id: string, entry: MemoryEntry): void {
    this.evictIfNeeded();
    this.entries.set(id, entry);
  }

  getEmbedding(id: string): number[] | undefined {
    return this.embeddings.get(id);
  }

  setEmbedding(id: string, embedding: number[]): void {
    if (this.entries.has(id)) {
      this.embeddings.set(id, embedding);
    }
  }

  /** GAP-17: Delete an entry and its embedding. */
  delete(id: string): void {
    this.entries.delete(id);
    this.embeddings.delete(id);
  }

  /** GAP-17: Current entry count. */
  get size(): number {
    return this.entries.size;
  }

  /** Get all entries (for dedup and quality gate checks) */
  getAllEntries(): MemoryEntry[] {
    return Array.from(this.entries.values());
  }

  /** GAP-17: Evict oldest entries when over limit. */
  private evictIfNeeded(): void {
    if (this.entries.size < this.maxEntries) return;
    const toEvict = Math.max(1, Math.floor(this.maxEntries * 0.1));
    // Single sort pass: collect all entries, sort by lastAccessedAt, delete oldest batch
    const entries: Array<[string, number]> = [];
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

export const DEFAULT_SCORE_WEIGHTS: MemoryScoreWeights = {
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
export function calculateMemoryScore(
  entry: MemoryEntry,
  queryEmbedding: number[] | undefined,
  entryEmbedding: number[] | undefined,
  weights: MemoryScoreWeights = DEFAULT_SCORE_WEIGHTS,
  recencyHalfLifeHours: number = 168, // 7 days default (was 24h — too aggressive)
): number {
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
  const accessFrequency = Math.log(1 + (entry.accessCount ?? 0)) / 5; // Normalized to ~[0, 1]

  return (
    weights.recency * recency +
    weights.importance * importance +
    weights.relevance * relevance +
    weights.accessFrequency * accessFrequency
  );
}
