/**
 * knowledgeStore — Enterprise knowledge-base persistence layer for RAG.
 *
 * Enterprise users' #1 need: let Agents retrieve internal company documents.
 * This store ingests raw documents (text/plain, application/json, text/markdown,
 * text/html), chunks them, embeds the chunks, and provides semantic search so
 * an Agent can pull relevant context before answering.
 *
 * Storage layout (under `.commander/knowledge-base/`):
 *   documents.json          — document metadata array
 *   chunks/<docId>.ndjson   — one JSON chunk per line (text + embedding)
 *   index.json              — global manifest of chunkId → { docId, chunkIndex }
 *
 * Embeddings use a zero-dependency hashing-trick LocalEmbeddingFunction (copied
 * from packages/core/src/runtime/embedding.ts so we do not depend on the core
 * build output, and because LocalEmbeddingFunction is not re-exported from
 * `@commander/core`). This means NO OpenAI API key is required.
 *
 * Evidence:
 * - Feature hashing is the standard free approximate-similarity approach
 *   (Weinberger et al., 2009); used by Vowpal Wabbit / Facebook / Criteo.
 * - Quality is ~70-80% of real embeddings for near-exact retrieval, which is
 *   sufficient for keyword-overlapping enterprise docs and avoids the cost /
 *   privacy concerns of sending internal docs to an external API.
 */
import { reportSilentFailure } from '@commander/core';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

// ── Types ────────────────────────────────────────────────────────────────

export type KnowledgeDocumentStatus = 'ready' | 'indexing' | 'failed';

export type SupportedContentType =
  | 'text/plain'
  | 'application/json'
  | 'text/markdown'
  | 'text/html';

export const SUPPORTED_CONTENT_TYPES: SupportedContentType[] = [
  'text/plain',
  'application/json',
  'text/markdown',
  'text/html',
];

export interface KnowledgeDocument {
  id: string;
  name: string;
  type: SupportedContentType;
  size: number;
  chunks: number;
  status: KnowledgeDocumentStatus;
  createdAt: string;
  updatedAt: string;
  /** Optional free-form tags / source hint supplied by the uploader. */
  tags?: string[];
  /** Last error message when status === 'failed'. */
  error?: string;
}

export interface KnowledgeChunkMetadata {
  docId: string;
  docName: string;
  chunkIndex: number;
  /** Character offset of the chunk within the original document text. */
  offset: number;
  /** Character length of the chunk. */
  length: number;
}

export interface KnowledgeChunk {
  chunkId: string;
  docId: string;
  chunkIndex: number;
  offset: number;
  length: number;
  text: string;
  embedding: number[];
}

export interface KnowledgeSearchResult {
  chunkId: string;
  docId: string;
  docName: string;
  chunkIndex: number;
  offset: number;
  text: string;
  /** Cosine similarity in [-1, 1]; higher is more relevant. */
  score: number;
}

export interface KnowledgeStats {
  documentCount: number;
  chunkCount: number;
  totalSizeBytes: number;
  embeddingDimension: number;
  /** Breakdown of documents by content type. */
  byType: Record<string, number>;
}

export interface KnowledgeListOptions {
  page?: number;
  limit?: number;
}

export interface KnowledgeListResult {
  documents: KnowledgeDocument[];
  total: number;
  page: number;
  limit: number;
}

export interface KnowledgeSearchOptions {
  query: string;
  topK?: number;
  /** Restrict search to a subset of documents. */
  docIds?: string[];
}

export interface KnowledgeRagContext {
  query: string;
  context: string;
  chunks: KnowledgeSearchResult[];
  topK: number;
}

// ── Embedding (copied from core so we stay build-output-independent) ──────

/**
 * LocalEmbeddingFunction — zero-dependency, API-key-free embedding via the
 * hashing trick with n-gram shingling. Produces L2-normalized fixed-size
 * vectors so cosine similarity is a simple dot product.
 *
 * NOTE: This is a verbatim copy of the class in
 * `packages/core/src/runtime/embedding.ts`. We duplicate it here because the
 * class is not re-exported from the `@commander/core` package entry point
 * (only `MockEmbeddingFunction` and `cosineSimilarity` are). Copying avoids a
 * hard dependency on the core build output and keeps the knowledge store fully
 * self-contained.
 */
class LocalEmbeddingFunction {
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
      return this.simpleHashEmbedding(normalized);
    }

    const ngrams = this.extractNgrams(normalized);
    const vector = new Array(this.dimension).fill(0);
    for (const ngram of ngrams) {
      const hash = this.fnv1a(ngram);
      const pos = hash % this.dimension;
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
    const words = text.split(/\s+/).filter((w) => w.length > 0);

    for (let n = 1; n <= Math.min(this.ngramSize, words.length); n++) {
      for (let i = 0; i <= words.length - n; i++) {
        ngrams.push(words.slice(i, i + n).join(' '));
      }
    }

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

/** Cosine similarity for two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Chunking ─────────────────────────────────────────────────────────────

const CHUNK_MIN_CHARS = 500;
const CHUNK_MAX_CHARS = 1000;
const CHUNK_OVERLAP_CHARS = 100;

/**
 * Split text into retrieval-friendly chunks.
 *
 * Strategy: split on paragraph boundaries (blank lines), then greedily pack
 * paragraphs into chunks of [CHUNK_MIN_CHARS, CHUNK_MAX_CHARS]. A paragraph
 * longer than the max is hard-split at word boundaries. Successive chunks
 * overlap by CHUNK_OVERLAP_CHARS so retrieval can catch context that straddles
 * a boundary.
 */
export function chunkText(
  text: string,
  options?: { minChars?: number; maxChars?: number; overlap?: number },
): Array<{ text: string; offset: number }> {
  const minChars = options?.minChars ?? CHUNK_MIN_CHARS;
  const maxChars = options?.maxChars ?? CHUNK_MAX_CHARS;
  const overlap = options?.overlap ?? CHUNK_OVERLAP_CHARS;

  const clean = text.replace(/\r\n/g, '\n').replace(/\t/g, '  ');
  if (clean.length === 0) return [];

  // Split into paragraphs on blank lines; keep paragraph boundaries as part
  // of the text so offsets stay meaningful.
  const paragraphs = clean.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (paragraphs.length === 0) return [];

  // First, expand any over-long paragraph into <=maxChars pieces (word-aware).
  const expanded: Array<{ text: string; offset: number }> = [];
  let cursor = 0; // absolute offset within `clean`
  for (const para of paragraphs) {
    // Locate the paragraph's start offset in `clean` (skipping the blank-line
    // separator that was consumed by the split). We search forward from cursor.
    const startIdx = clean.indexOf(para, cursor);
    const paraOffset = startIdx >= 0 ? startIdx : cursor;
    cursor = paraOffset + para.length;

    if (para.length <= maxChars) {
      expanded.push({ text: para, offset: paraOffset });
    } else {
      // Hard-split long paragraph at word boundaries.
      let i = 0;
      while (i < para.length) {
        let end = Math.min(i + maxChars, para.length);
        if (end < para.length) {
          // Walk back to the last space to avoid splitting words.
          const lastSpace = para.lastIndexOf(' ', end);
          if (lastSpace > i + minChars) end = lastSpace;
        }
        const piece = para.slice(i, end).trim();
        if (piece.length > 0) {
          expanded.push({ text: piece, offset: paraOffset + i });
        }
        i = end;
      }
    }
  }

  // Greedily pack pieces into chunks within [minChars, maxChars].
  const chunks: Array<{ text: string; offset: number }> = [];
  let buffer = '';
  let bufferOffset = 0;
  const flush = (): void => {
    if (buffer.length > 0) {
      chunks.push({ text: buffer, offset: bufferOffset });
      buffer = '';
    }
  };

  for (const piece of expanded) {
    if (buffer.length === 0) {
      buffer = piece.text;
      bufferOffset = piece.offset;
    } else if (buffer.length + 1 + piece.text.length <= maxChars) {
      buffer += '\n\n' + piece.text;
    } else {
      flush();
      // Carry overlap from the previous chunk for context continuity.
      const prev = chunks.length > 0 ? chunks[chunks.length - 1].text : '';
      const tail = prev.length > overlap ? prev.slice(prev.length - overlap) : prev;
      buffer = (tail ? tail + '\n\n' : '') + piece.text;
      bufferOffset = piece.offset;
    }
  }
  flush();

  return chunks;
}

// ── Plain-text extraction ────────────────────────────────────────────────

/**
 * Convert a raw document body of a given content type into plain text suitable
 * for chunking + embedding.
 *
 * - text/plain: returned as-is.
 * - text/markdown: returned as-is (markdown is already human-readable text;
 *   stripping syntax would harm retrieval of code fences / headings).
 * - application/json: pretty-printed so structure is preserved.
 * - text/html: tags + scripts/styles stripped to plain text.
 */
export function extractPlainText(
  content: string,
  type: SupportedContentType,
): string {
  switch (type) {
    case 'text/plain':
    case 'text/markdown':
      return content;
    case 'application/json': {
      try {
        return JSON.stringify(JSON.parse(content), null, 2);
      } catch {
        // Not valid JSON — fall back to raw content so it is still searchable.
        return content;
      }
    }
    case 'text/html': {
      // Remove <script> and <style> blocks entirely, then strip remaining tags.
      return content
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    default:
      return content;
  }
}

/** Coerce an arbitrary content-type string into our supported enum. */
export function normalizeContentType(raw: string): SupportedContentType {
  const lower = (raw || '').toLowerCase().split(';')[0].trim();
  if (lower === 'application/json') return 'application/json';
  if (lower === 'text/markdown' || lower === 'text/x-markdown') return 'text/markdown';
  if (lower === 'text/html') return 'text/html';
  // Default to plain text for anything else (text/plain, unknown, etc.)
  return 'text/plain';
}

// ── Store ────────────────────────────────────────────────────────────────

interface IndexManifest {
  /** Embedding dimension (so consumers can validate vector shape). */
  dimension: number;
  /** chunkId → { docId, chunkIndex } for all chunks on disk. */
  chunks: Record<string, { docId: string; chunkIndex: number }>;
}

interface DocumentsFile {
  documents: KnowledgeDocument[];
}

const DEFAULT_DIMENSION = 256;

export class KnowledgeStore {
  private readonly baseDir: string;
  private readonly chunksDir: string;
  private readonly documentsPath: string;
  private readonly indexPath: string;
  private readonly embedder = new LocalEmbeddingFunction();
  private readonly dimension = DEFAULT_DIMENSION;

  // In-memory cache of all chunks (chunkId → chunk), lazily loaded.
  private cache: Map<string, KnowledgeChunk> | null = null;
  private documentsCache: KnowledgeDocument[] | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(baseDir?: string) {
    this.baseDir = path.resolve(baseDir ?? path.join(process.cwd(), '.commander', 'knowledge-base'));
    this.chunksDir = path.join(this.baseDir, 'chunks');
    this.documentsPath = path.join(this.baseDir, 'documents.json');
    this.indexPath = path.join(this.baseDir, 'index.json');
  }

  /** Lazily ensure the storage directory tree exists. */
  private async ensureDirs(): Promise<void> {
    await fsp.mkdir(this.chunksDir, { recursive: true });
  }

  /**
   * Initialize the store: ensure directories exist and load metadata files.
   * Safe to call multiple times; the first call wins.
   */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      await this.ensureDirs();
      await this.loadDocuments();
      await this.loadIndex();
    } catch (err) {
      reportSilentFailure(err, 'knowledgeStore:init');
    }
  }

  // ── Persistence helpers ───────────────────────────────────────────────

  private async loadDocuments(): Promise<KnowledgeDocument[]> {
    if (this.documentsCache) return this.documentsCache;
    try {
      const raw = await fsp.readFile(this.documentsPath, 'utf-8');
      const parsed = JSON.parse(raw) as DocumentsFile;
      this.documentsCache = Array.isArray(parsed.documents) ? parsed.documents : [];
    } catch (err) {
      reportSilentFailure(err, 'knowledgeStore:loadDocuments');
      this.documentsCache = [];
    }
    return this.documentsCache;
  }

  private async persistDocuments(): Promise<void> {
    await this.ensureDirs();
    const docs = this.documentsCache ?? [];
    const payload: DocumentsFile = { documents: docs };
    await this.atomicWrite(this.documentsPath, JSON.stringify(payload, null, 2));
  }

  private async loadIndex(): Promise<IndexManifest> {
    try {
      const raw = await fsp.readFile(this.indexPath, 'utf-8');
      const parsed = JSON.parse(raw) as IndexManifest;
      if (!parsed || typeof parsed !== 'object' || !parsed.chunks) {
        return { dimension: this.dimension, chunks: {} };
      }
      return parsed;
    } catch (err) {
      reportSilentFailure(err, 'knowledgeStore:loadIndex');
      return { dimension: this.dimension, chunks: {} };
    }
  }

  private async persistIndex(manifest: IndexManifest): Promise<void> {
    await this.ensureDirs();
    await this.atomicWrite(this.indexPath, JSON.stringify(manifest, null, 2));
  }

  /** Atomic write via temp file + rename to avoid torn reads. */
  private async atomicWrite(filePath: string, data: string): Promise<void> {
    const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
    await fsp.writeFile(tmp, data, 'utf-8');
    await fsp.rename(tmp, filePath);
  }

  private chunkFilePath(docId: string): string {
    return path.join(this.chunksDir, `${docId}.ndjson`);
  }

  /** Load all chunks from disk into the in-memory cache. */
  private async loadCache(): Promise<Map<string, KnowledgeChunk>> {
    if (this.cache) return this.cache;
    await this.ensureDirs();
    const cache = new Map<string, KnowledgeChunk>();
    let files: string[] = [];
    try {
      files = await fsp.readdir(this.chunksDir);
    } catch (err) {
      reportSilentFailure(err, 'knowledgeStore:loadCache:readdir');
    }
    for (const file of files) {
      if (!file.endsWith('.ndjson')) continue;
      const filePath = path.join(this.chunksDir, file);
      try {
        const raw = (await fsp.readFile(filePath, 'utf-8')).trim();
        if (!raw) continue;
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line) as KnowledgeChunk;
            if (chunk && chunk.chunkId) cache.set(chunk.chunkId, chunk);
          } catch (err) {
            reportSilentFailure(err, 'knowledgeStore:loadCache:parse');
          }
        }
      } catch (err) {
        reportSilentFailure(err, 'knowledgeStore:loadCache:read');
      }
    }
    this.cache = cache;
    return cache;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Add a document: extract plain text, chunk, embed, and persist.
   * Returns the document metadata (status 'ready' on success, 'failed' on
   * embedding/persistence error with an `error` message).
   */
  async addDocument(params: {
    name: string;
    type: SupportedContentType;
    content: string;
    tags?: string[];
  }): Promise<KnowledgeDocument> {
    await this.init();
    const { name, type, content, tags } = params;
    const docId = uuidv4();
    const now = new Date().toISOString();

    const doc: KnowledgeDocument = {
      id: docId,
      name: name.slice(0, 256) || 'untitled',
      type,
      size: Buffer.byteLength(content, 'utf-8'),
      chunks: 0,
      status: 'indexing',
      createdAt: now,
      updatedAt: now,
      tags: tags && tags.length > 0 ? tags.slice(0, 20) : undefined,
    };

    const docs = await this.loadDocuments();
    docs.push(doc);
    await this.persistDocuments();

    try {
      const plainText = extractPlainText(content, type);
      const pieces = chunkText(plainText);
      if (pieces.length === 0) {
        // Empty / whitespace-only document — keep it but with zero chunks.
        doc.status = 'ready';
        doc.chunks = 0;
        doc.updatedAt = new Date().toISOString();
        await this.persistDocuments();
        return doc;
      }

      const chunks: KnowledgeChunk[] = pieces.map((piece, idx) => ({
        chunkId: uuidv4(),
        docId,
        chunkIndex: idx,
        offset: piece.offset,
        length: piece.text.length,
        text: piece.text,
        embedding: this.embedder.generate(piece.text),
      }));

      // Persist chunks as ndjson (one JSON object per line).
      const ndjson = chunks.map((c) => JSON.stringify(c)).join('\n') + '\n';
      await this.ensureDirs();
      await this.atomicWrite(this.chunkFilePath(docId), ndjson);

      // Update global index manifest.
      const manifest = await this.loadIndex();
      for (const c of chunks) {
        manifest.chunks[c.chunkId] = { docId, chunkIndex: c.chunkIndex };
      }
      manifest.dimension = this.dimension;
      await this.persistIndex(manifest);

      // Update in-memory caches.
      const cache = await this.loadCache();
      for (const c of chunks) cache.set(c.chunkId, c);

      doc.chunks = chunks.length;
      doc.status = 'ready';
      doc.updatedAt = new Date().toISOString();
      await this.persistDocuments();
      return doc;
    } catch (err) {
      reportSilentFailure(err, 'knowledgeStore:addDocument');
      doc.status = 'failed';
      doc.error = err instanceof Error ? err.message : 'Unknown indexing error';
      doc.updatedAt = new Date().toISOString();
      await this.persistDocuments();
      return doc;
    }
  }

  /** Get a single document's metadata by id. */
  async getDocument(id: string): Promise<KnowledgeDocument | null> {
    await this.init();
    const docs = await this.loadDocuments();
    return docs.find((d) => d.id === id) ?? null;
  }

  /** List documents with simple page/limit pagination. */
  async listDocuments(options?: KnowledgeListOptions): Promise<KnowledgeListResult> {
    await this.init();
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 20));
    const docs = await this.loadDocuments();
    // Newest first — enterprise users typically want to see recent uploads.
    const sorted = [...docs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const start = (page - 1) * limit;
    const slice = sorted.slice(start, start + limit);
    return { documents: slice, total: docs.length, page, limit };
  }

  /** Delete a document and all of its chunks. */
  async deleteDocument(id: string): Promise<boolean> {
    await this.init();
    const docs = await this.loadDocuments();
    const idx = docs.findIndex((d) => d.id === id);
    if (idx < 0) return false;

    docs.splice(idx, 1);
    await this.persistDocuments();

    // Remove the chunk file.
    try {
      await fsp.unlink(this.chunkFilePath(id));
    } catch (err) {
      reportSilentFailure(err, 'knowledgeStore:deleteDocument:unlink');
    }

    // Update index manifest + in-memory cache.
    const manifest = await this.loadIndex();
    const cache = await this.loadCache();
    const toRemove: string[] = [];
    for (const [chunkId, entry] of Object.entries(manifest.chunks)) {
      if (entry.docId === id) toRemove.push(chunkId);
    }
    for (const chunkId of toRemove) {
      delete manifest.chunks[chunkId];
      cache.delete(chunkId);
    }
    await this.persistIndex(manifest);
    return true;
  }

  /**
   * Semantic search: embed the query and return the top-K most similar chunks
   * (cosine similarity). Optionally restrict to a subset of docIds.
   */
  async search(options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult[]> {
    await this.init();
    const query = options.query?.trim() ?? '';
    if (!query) return [];
    const topK = Math.min(50, Math.max(1, options.topK ?? 5));
    const docIdFilter =
      options.docIds && options.docIds.length > 0 ? new Set(options.docIds) : null;

    const cache = await this.loadCache();
    if (cache.size === 0) return [];

    const queryVec = this.embedder.generate(query);
    const docs = await this.loadDocuments();
    const docNameById = new Map(docs.map((d) => [d.id, d.name]));

    const scored: KnowledgeSearchResult[] = [];
    for (const chunk of cache.values()) {
      if (docIdFilter && !docIdFilter.has(chunk.docId)) continue;
      // Skip chunks whose document no longer exists (defensive).
      if (!docNameById.has(chunk.docId)) continue;
      const score = cosineSimilarity(queryVec, chunk.embedding);
      scored.push({
        chunkId: chunk.chunkId,
        docId: chunk.docId,
        docName: docNameById.get(chunk.docId) ?? '',
        chunkIndex: chunk.chunkIndex,
        offset: chunk.offset,
        text: chunk.text,
        score,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * RAG query: run a semantic search, then assemble a context string ready to
   * be injected into an LLM prompt. Chunks are numbered and attributed to
   * their source document so the model can cite sources.
   */
  async query(options: KnowledgeSearchOptions): Promise<KnowledgeRagContext> {
    const topK = Math.min(50, Math.max(1, options.topK ?? 5));
    const results = await this.search({ ...options, topK });

    const parts: string[] = [];
    parts.push(`Found ${results.length} relevant knowledge chunk(s) for query: "${options.query}"`);
    parts.push('');
    results.forEach((r, i) => {
      parts.push(`--- [${i + 1}] Source: ${r.docName} (chunk ${r.chunkIndex + 1}, score ${r.score.toFixed(3)}) ---`);
      parts.push(r.text);
      parts.push('');
    });

    return {
      query: options.query,
      context: parts.join('\n'),
      chunks: results,
      topK,
    };
  }

  /** Aggregate statistics for the dashboard. */
  async stats(): Promise<KnowledgeStats> {
    await this.init();
    const docs = await this.loadDocuments();
    const cache = await this.loadCache();
    const byType: Record<string, number> = {};
    let totalSize = 0;
    for (const d of docs) {
      byType[d.type] = (byType[d.type] ?? 0) + 1;
      totalSize += d.size;
    }
    return {
      documentCount: docs.length,
      chunkCount: cache.size,
      totalSizeBytes: totalSize,
      embeddingDimension: this.dimension,
      byType,
    };
  }
}

// ── Singleton accessor (mirrors other stores in the API) ─────────────────

let singleton: KnowledgeStore | null = null;

/** Return the process-wide KnowledgeStore singleton. */
export function getKnowledgeStore(): KnowledgeStore {
  if (!singleton) {
    singleton = new KnowledgeStore();
  }
  return singleton;
}

// Export helpers for unit testing / reuse by the endpoints module.
export { LocalEmbeddingFunction };

// Allow callers to override the storage dir (used by tests). Not exported via
// the singleton; construct `new KnowledgeStore(dir)` directly to override.
export function _resetKnowledgeStoreSingletonForTests(): void {
  singleton = null;
}
