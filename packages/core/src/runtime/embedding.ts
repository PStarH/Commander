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
