/**
 * KnowledgeBaseStore — Enterprise RAG knowledge base persistence + retrieval.
 *
 * This is the core-layer store backing the `builtin-rag` CommanderPlugin. It
 * ingests documents (chunk → embed → index), persists them to disk under
 * `.commander/knowledge-base/`, and serves semantic search via the existing
 * HNSW vector index.
 *
 * Storage layout (under `kbPath`):
 *   kb-documents.json  — document metadata array (id, filename, chunks, ...)
 *   kb-vectors.json    — chunk payloads (id, docId, content, source, vector)
 *
 * On load the HNSW index is rebuilt from the persisted chunk vectors. This
 * keeps serialization simple (plain JSON) while still leveraging O(log n)
 * approximate nearest-neighbor search once the dataset exceeds the HNSW
 * brute-force threshold.
 *
 * Embeddings: uses OpenAIEmbeddingFunction when OPENAI_API_KEY is present,
 * otherwise falls back to the zero-dependency LocalEmbeddingFunction so the
 * knowledge base works with no external API key.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  LocalEmbeddingFunction,
  OpenAIEmbeddingFunction,
  type EmbeddingFunction,
} from '../../runtime/embedding';
import { HNSWIndex } from '../../memory/hnswIndex';
import { getGlobalLogger } from '../../logging';

// ============================================================================
// Types
// ============================================================================

export interface KbDocumentMeta {
  id: string;
  filename: string;
  /** Number of chunks indexed for this document. */
  chunks: number;
  uploadedAt: string;
  /** Source attribution (defaults to filename). */
  source?: string;
  /** Original content size in bytes. */
  size: number;
}

export interface KbSearchResult {
  content: string;
  source: string;
  /** Cosine similarity in [-1, 1]; higher is more relevant. */
  score: number;
  docId: string;
  chunkId: string;
}

export interface KbIngestResult {
  documentId: string;
  chunksIndexed: number;
}

interface KbChunk {
  id: string;
  docId: string;
  content: string;
  source: string;
  vector: number[];
}

interface PersistedVectors {
  dimension: number;
  chunks: KbChunk[];
}

// ============================================================================
// Embedding factory
// ============================================================================

/**
 * Create the embedding function for the knowledge base.
 *
 * - If `OPENAI_API_KEY` is set, use the real OpenAI embedding API (better
 *   semantic quality, but sends text to an external service).
 * - Otherwise fall back to the zero-dependency LocalEmbeddingFunction
 *   (hashing-trick n-gram embeddings) so the KB works offline with no key.
 */
export function createKbEmbeddingFunction(model?: string): EmbeddingFunction {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey && apiKey.trim().length > 0) {
    return new OpenAIEmbeddingFunction({
      apiKey,
      model: model ?? 'text-embedding-3-small',
    });
  }
  return new LocalEmbeddingFunction();
}

// ============================================================================
// KnowledgeBaseStore
// ============================================================================

export class KnowledgeBaseStore {
  private readonly baseDir: string;
  private readonly embedder: EmbeddingFunction;
  private readonly index: HNSWIndex;
  private readonly documents = new Map<string, KbDocumentMeta>();
  private readonly chunks = new Map<string, KbChunk>();
  private readonly chunkIdsByDoc = new Map<string, Set<string>>();
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;
  private readonly maxResults: number;
  private initPromise: Promise<void> | null = null;

  constructor(config: {
    kbPath?: string;
    embeddingModel?: string;
    chunkSize?: number;
    chunkOverlap?: number;
    maxResults?: number;
  } = {}) {
    const rawPath = config.kbPath ?? '.commander/knowledge-base';
    this.baseDir = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(process.cwd(), rawPath);
    this.embedder = createKbEmbeddingFunction(config.embeddingModel);
    this.index = new HNSWIndex({ bruteForceThreshold: 1000 });
    this.chunkSize = config.chunkSize ?? 512;
    this.chunkOverlap = config.chunkOverlap ?? 50;
    this.maxResults = config.maxResults ?? 5;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Lazily initialize: ensure directory exists and load persisted state. */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      await fsp.mkdir(this.baseDir, { recursive: true });
      await this.load();
    } catch (err) {
      getGlobalLogger().warn(
        'KnowledgeBaseStore',
        `init failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Persist all state to disk. Safe to call repeatedly. */
  async save(): Promise<void> {
    await fsp.mkdir(this.baseDir, { recursive: true });
    const docs = Array.from(this.documents.values());
    const vectors: PersistedVectors = {
      dimension: this.embedder.dimension,
      chunks: Array.from(this.chunks.values()),
    };
    await this.atomicWrite(this.docsPath, JSON.stringify(docs, null, 2));
    await this.atomicWrite(this.vectorsPath, JSON.stringify(vectors, null, 2));
  }

  // ── Persistence helpers ─────────────────────────────────────────────────

  private get docsPath(): string {
    return path.join(this.baseDir, 'kb-documents.json');
  }

  private get vectorsPath(): string {
    return path.join(this.baseDir, 'kb-vectors.json');
  }

  private async load(): Promise<void> {
    // Load document metadata
    try {
      const raw = await fsp.readFile(this.docsPath, 'utf-8');
      const docs = JSON.parse(raw) as KbDocumentMeta[];
      if (Array.isArray(docs)) {
        for (const d of docs) {
          this.documents.set(d.id, d);
          if (!this.chunkIdsByDoc.has(d.id)) {
            this.chunkIdsByDoc.set(d.id, new Set());
          }
        }
      }
    } catch {
      /* no documents file yet — ignore */
    }

    // Load chunk vectors and rebuild the HNSW index
    try {
      const raw = await fsp.readFile(this.vectorsPath, 'utf-8');
      const state = JSON.parse(raw) as PersistedVectors;
      if (state && Array.isArray(state.chunks)) {
        for (const c of state.chunks) {
          this.chunks.set(c.id, c);
          const set = this.chunkIdsByDoc.get(c.docId) ?? new Set();
          set.add(c.id);
          this.chunkIdsByDoc.set(c.docId, set);
          this.index.add(c.id, c.vector);
        }
      }
    } catch {
      /* no vectors file yet — ignore */
    }
  }

  private async atomicWrite(filePath: string, data: string): Promise<void> {
    const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
    await fsp.writeFile(tmp, data, 'utf-8');
    await fsp.rename(tmp, filePath);
  }

  // ── Chunking ───────────────────────────────────────────────────────────

  /**
   * Split text into retrieval-friendly chunks.
   *
   * Strategy: split on paragraph boundaries (blank lines), then hard-truncate
   * any paragraph longer than `chunkSize` into overlapping pieces. This is the
   * simple method required by the task spec.
   */
  chunkText(text: string, chunkSize?: number, overlap?: number): string[] {
    const size = Math.max(1, chunkSize ?? this.chunkSize);
    const ov = Math.max(0, Math.min(overlap ?? this.chunkOverlap, size - 1));
    const clean = text.replace(/\r\n/g, '\n');
    if (clean.trim().length === 0) return [];

    const paragraphs = clean
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const chunks: string[] = [];
    for (const para of paragraphs) {
      if (para.length <= size) {
        chunks.push(para);
        continue;
      }
      // Hard-split the long paragraph into `size`-length overlapping slices.
      let i = 0;
      while (i < para.length) {
        const end = Math.min(i + size, para.length);
        chunks.push(para.slice(i, end));
        if (end >= para.length) break;
        i = end - ov;
        if (i <= 0) i = end; // guard against zero progress
      }
    }
    return chunks;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Ingest a document: chunk → embed → index → persist.
   * Returns the new document id and the number of chunks indexed.
   */
  async ingestDocument(
    filename: string,
    content: string,
    source?: string,
  ): Promise<KbIngestResult> {
    await this.init();
    const id = randomUUID();
    const now = new Date().toISOString();
    const src = source ?? filename;
    const pieces = this.chunkText(content);
    let count = 0;

    for (const piece of pieces) {
      const vector = await this.embedder.generate(piece);
      const chunkId = randomUUID();
      const chunk: KbChunk = {
        id: chunkId,
        docId: id,
        content: piece,
        source: src,
        vector,
      };
      this.chunks.set(chunkId, chunk);
      this.index.add(chunkId, vector);
      const set = this.chunkIdsByDoc.get(id) ?? new Set();
      set.add(chunkId);
      this.chunkIdsByDoc.set(id, set);
      count++;
    }

    const meta: KbDocumentMeta = {
      id,
      filename: filename.slice(0, 256) || 'untitled',
      chunks: count,
      uploadedAt: now,
      source: src,
      size: Buffer.byteLength(content, 'utf-8'),
    };
    this.documents.set(id, meta);
    await this.save();
    return { documentId: id, chunksIndexed: count };
  }

  /**
   * Semantic search: embed the query and return the top-K most similar chunks
   * (cosine similarity via the HNSW index).
   */
  async search(query: string, topK?: number): Promise<KbSearchResult[]> {
    await this.init();
    const q = (query ?? '').trim();
    if (q.length === 0 || this.chunks.size === 0) return [];
    const k = Math.min(50, Math.max(1, topK ?? this.maxResults));
    const queryVec = await this.embedder.generate(q);
    const results = this.index.search(queryVec, k);

    const out: KbSearchResult[] = [];
    for (const r of results) {
      const chunk = this.chunks.get(r.id);
      if (!chunk) continue;
      out.push({
        content: chunk.content,
        source: chunk.source,
        score: r.score,
        docId: chunk.docId,
        chunkId: chunk.id,
      });
    }
    return out;
  }

  /** List all indexed documents (newest first). */
  listDocuments(): KbDocumentMeta[] {
    return Array.from(this.documents.values()).sort((a, b) =>
      b.uploadedAt.localeCompare(a.uploadedAt),
    );
  }

  /** Delete a document and all of its chunks. Returns false if not found. */
  async deleteDocument(id: string): Promise<boolean> {
    await this.init();
    if (!this.documents.has(id)) return false;
    this.documents.delete(id);
    const chunkIds = this.chunkIdsByDoc.get(id);
    if (chunkIds) {
      for (const cid of chunkIds) {
        this.chunks.delete(cid);
        this.index.remove(cid);
      }
    }
    this.chunkIdsByDoc.delete(id);
    await this.save();
    return true;
  }

  // ── Stats ──────────────────────────────────────────────────────────────

  get documentCount(): number {
    return this.documents.size;
  }

  get vectorCount(): number {
    return this.chunks.size;
  }

  get embeddingDimension(): number {
    return this.embedder.dimension;
  }

  get embeddingName(): string {
    return this.embedder.name;
  }
}

// ============================================================================
// Process-wide singleton (used by the API endpoints to share the store with
// the plugin instance without re-creating it on every request).
// ============================================================================

let sharedStore: KnowledgeBaseStore | null = null;

export function getSharedKnowledgeBaseStore(): KnowledgeBaseStore {
  if (!sharedStore) {
    sharedStore = new KnowledgeBaseStore();
  }
  return sharedStore;
}

export function setSharedKnowledgeBaseStore(store: KnowledgeBaseStore | null): void {
  sharedStore = store;
}
