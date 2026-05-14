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

  getEntry(id: string): MemoryEntry | undefined {
    return this.entries.get(id);
  }

  setEntry(id: string, entry: MemoryEntry): void {
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
}

export function calculateMemoryScore(
  entry: MemoryEntry,
  queryEmbedding: number[] | undefined,
  entryEmbedding: number[] | undefined,
): number {
  const recencyWeight = 0.5;
  const importanceWeight = 2.0;
  const relevanceWeight = 3.0;

  const hoursSinceAccess = entry.lastAccessedAt
    ? (Date.now() - new Date(entry.lastAccessedAt).getTime()) / (1000 * 3600)
    : 0;
  const recency = Math.exp(-hoursSinceAccess / 24);

  const importance = entry.importance;

  let relevance = 0;
  if (queryEmbedding && entryEmbedding) {
    relevance = Math.max(0, cosineSimilarity(queryEmbedding, entryEmbedding));
  }

  return recencyWeight * recency + importanceWeight * importance + relevanceWeight * relevance;
}
