/**
 * Episodic Memory Store with SQLite + Vector Index
 * Based on research: Memory for Autonomous LLM Agents (arXiv:2603.07670v1)
 *
 * Architecture:
 * - SQLite: Structured storage for episodic memory with metadata
 * - Vector Index: Semantic search via simple TF-IDF (can upgrade to embeddings)
 * - Write-Manage-Read Loop (𝒰-ℛ pattern)
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// ============================================
// Type Definitions
// ============================================

export interface EpisodicMemory {
  id: string;
  projectId: string;
  agentId?: string;
  missionId?: string;
  sessionId?: string;

  // Core content
  title: string;
  content: string;

  // Metadata
  timestamp: string;
  importance: number; // 0-1, for retrieval prioritization
  accessCount: number;
  lastAccessedAt?: string;

  // Classification
  type: 'decision' | 'action' | 'observation' | 'reflection' | 'context';
  tags: string[];

  // Contradiction tracking
  contradicts?: string[]; // IDs of memories this contradicts
  supersededBy?: string; // ID of memory that supersedes this

  // Vector representation (simplified)
  vector?: number[];
}

export interface EpisodicMemorySearchOptions {
  query?: string;
  agentId?: string;
  missionId?: string;
  type?: EpisodicMemory['type'];
  tags?: string[];
  minImportance?: number;
  limit?: number;
  includeSuperseded?: boolean;
}

export interface WriteOptions {
  deduplicate?: boolean;
  scorePriority?: boolean;
  resolveContradictions?: boolean;
}

export interface MemoryStats {
  totalMemories: number;
  byType: Record<EpisodicMemory['type'], number>;
  avgImportance: number;
  avgAccessCount: number;
  oldestMemory?: string;
  newestMemory?: string;
}

// ============================================
// SQLite-like Storage (File-based for simplicity)
// ============================================

const EPISODIC_MEMORY_FILE = path.resolve(__dirname, '../data/episodic-memory.json');
const VECTOR_INDEX_FILE = path.resolve(__dirname, '../data/episodic-memory-vectors.json');

/**
 * Simple TF-IDF Vector Index
 * Can be upgraded to proper embeddings (OpenAI, local model) in production
 */
class SimpleVectorIndex {
  private documentFrequency: Map<string, number> = new Map();
  private vectors: Map<string, number[]> = new Map();
  private totalDocuments: number = 0;

  /**
   * Tokenize and normalize text
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2 && !this.isStopWord(token));
  }

  /**
   * Common stop words to ignore
   */
  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'must',
      'shall',
      'can',
      'need',
      'dare',
      'ought',
      'used',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'as',
      'into',
      'through',
      'during',
      'before',
      'after',
      'above',
      'below',
      'between',
      'under',
      'again',
      'further',
      'then',
      'once',
      'here',
      'there',
      'when',
      'where',
      'why',
      'how',
      'all',
      'each',
      'few',
      'more',
      'most',
      'other',
      'some',
      'such',
      'no',
      'nor',
      'only',
      'own',
      'same',
      'so',
      'than',
      'too',
      'very',
      'just',
      'and',
      'but',
      'or',
      'if',
      'because',
      'as',
      'until',
      'while',
      'this',
      'that',
      'these',
      'those',
      'it',
      'its',
      'they',
      'them',
      'their',
      'we',
      'our',
      'you',
      'your',
    ]);
    return stopWords.has(word);
  }

  /**
   * Compute TF-IDF vector for a document
   */
  private computeTFIDF(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    const uniqueTokens = new Set(tokens);

    // Term Frequency
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    // Normalize by document length
    const maxTF = Math.max(...Array.from(tf.values()));
    for (const [token, count] of tf.entries()) {
      tf.set(token, count / maxTF);
    }

    // TF-IDF
    const tfidf = new Map<string, number>();
    for (const token of uniqueTokens) {
      const idf = Math.log(this.totalDocuments / (this.documentFrequency.get(token) || 1));
      tfidf.set(token, (tf.get(token) || 0) * idf);
    }

    return tfidf;
  }

  /**
   * Add document to index
   */
  addDocument(id: string, text: string): void {
    const tokens = this.tokenize(text);
    this.totalDocuments++;

    // Update document frequency
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      this.documentFrequency.set(token, (this.documentFrequency.get(token) || 0) + 1);
    }

    // Store TF-IDF vector (sparse representation)
    const tfidf = this.computeTFIDF(tokens);
    const vector = Array.from(tfidf.entries()).flatMap(([token, score]) => [
      this.hashToken(token),
      score,
    ]);

    this.vectors.set(id, vector);
  }

  /**
   * Simple hash function for tokens
   */
  private hashToken(token: string): number {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      const char = token.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Compute cosine similarity between two vectors
   */
  private cosineSimilarity(vec1: number[], vec2: number[]): number {
    // Sparse vector comparison
    const map1 = new Map<number, number>();
    const map2 = new Map<number, number>();

    for (let i = 0; i < vec1.length; i += 2) {
      map1.set(vec1[i], vec1[i + 1]);
    }
    for (let i = 0; i < vec2.length; i += 2) {
      map2.set(vec2[i], vec2[i + 1]);
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (const [key, val1] of map1.entries()) {
      const val2 = map2.get(key) || 0;
      dotProduct += val1 * val2;
      norm1 += val1 * val1;
    }

    for (const val of map2.values()) {
      norm2 += val * val;
    }

    if (norm1 === 0 || norm2 === 0) return 0;
    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }

  /**
   * Search for similar documents
   */
  search(query: string, limit: number = 10): Array<{ id: string; score: number }> {
    const queryTokens = this.tokenize(query);
    const queryTFIDF = this.computeTFIDF(queryTokens);
    const queryVector = Array.from(queryTFIDF.entries()).flatMap(([token, score]) => [
      this.hashToken(token),
      score,
    ]);

    const scores: Array<{ id: string; score: number }> = [];

    for (const [id, vector] of this.vectors.entries()) {
      const similarity = this.cosineSimilarity(queryVector, vector);
      if (similarity > 0) {
        scores.push({ id, score: similarity });
      }
    }

    return scores.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Remove document from index
   * Also updates document frequency to keep IDF scores accurate
   */
  removeDocument(id: string): void {
    const vector = this.vectors.get(id);
    if (!vector) return;

    // Reconstruct tokens from vector to update document frequency
    // Since we store [hash, score] pairs, we need to decrement DF for each term
    // Approximate: remove from document frequency for all terms in this doc
    // This is a best-effort approach since we don't store the original tokens
    this.vectors.delete(id);
    this.totalDocuments = Math.max(0, this.totalDocuments - 1);
    // Note: DF counts become slightly inflated over time. For production,
    // store token lists alongside vectors for exact DF updates.
  }

  /**
   * Save index to disk
   */
  save(filePath: string): void {
    const data = {
      documentFrequency: Array.from(this.documentFrequency.entries()),
      vectors: Array.from(this.vectors.entries()),
      totalDocuments: this.totalDocuments,
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  /**
   * Load index from disk
   */
  load(filePath: string): void {
    if (!fs.existsSync(filePath)) return;

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      this.documentFrequency = new Map(data.documentFrequency);
      this.vectors = new Map(data.vectors);
      this.totalDocuments = data.totalDocuments;
    } catch (e) {
      process.stderr.write(`[EpisodicMemoryStore] Error: ${(e as Error)?.message ?? String(e)}\n`);
    }
  }
}

// ============================================
// Episodic Memory Store
// ============================================

export class EpisodicMemoryStore {
  private memories: EpisodicMemory[] = [];
  private vectorIndex: SimpleVectorIndex;
  private filePath: string;
  private vectorPath: string;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string = EPISODIC_MEMORY_FILE, vectorPath: string = VECTOR_INDEX_FILE) {
    this.filePath = filePath;
    this.vectorPath = vectorPath;
    this.vectorIndex = new SimpleVectorIndex();
    this.load();
  }

  // ============================================
  // Write Path (𝒰 - Update)
  // ============================================

  /**
   * Write new episodic memory
   */
  write(
    input: Omit<EpisodicMemory, 'id' | 'timestamp' | 'accessCount'>,
    options: WriteOptions = {},
  ): EpisodicMemory {
    const { deduplicate = true, scorePriority = true, resolveContradictions = true } = options;

    // Step 1: Check for duplicates
    if (deduplicate) {
      const duplicate = this.findDuplicate(input);
      if (duplicate) {
        // Update importance instead of creating duplicate
        return this.updateImportance(
          duplicate.id,
          Math.max(duplicate.importance, input.importance),
        );
      }
    }

    // Step 2: Check for contradictions
    if (resolveContradictions && input.type === 'observation') {
      const contradictions = this.findContradictions(input);
      if (contradictions.length > 0) {
        input.contradicts = contradictions.map((m) => m.id);
      }
    }

    // Step 3: Calculate importance if not provided
    if (scorePriority && !input.importance) {
      input.importance = this.calculateImportance(input);
    }

    // Step 4: Create memory
    const memory: EpisodicMemory = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      accessCount: 0,
      ...input,
    };

    // Step 5: Add to storage
    this.memories.unshift(memory);

    // Step 6: Add to vector index
    const indexText = `${memory.title} ${memory.content} ${memory.tags.join(' ')}`;
    this.vectorIndex.addDocument(memory.id, indexText);

    // Step 7: Persist
    this.persist();

    return memory;
  }

  /**
   * Batch write multiple memories
   */
  batchWrite(
    inputs: Array<Omit<EpisodicMemory, 'id' | 'timestamp' | 'accessCount'>>,
  ): EpisodicMemory[] {
    return inputs.map((input) => this.write(input, { deduplicate: false }));
  }

  /**
   * Find duplicate memory
   */
  private findDuplicate(
    input: Pick<EpisodicMemory, 'projectId' | 'title' | 'type'>,
  ): EpisodicMemory | undefined {
    return this.memories.find(
      (m) => m.projectId === input.projectId && m.title === input.title && m.type === input.type,
    );
  }

  /**
   * Find memories that contradict this observation.
   * Uses keyword overlap + negation pattern detection.
   */
  private findContradictions(
    input: Pick<EpisodicMemory, 'projectId' | 'content' | 'type'>,
  ): EpisodicMemory[] {
    const keywords = this.extractKeywords(input.content);
    const negationWords = [
      'not',
      "don't",
      "doesn't",
      "didn't",
      "won't",
      "shouldn't",
      'never',
      'no',
      'avoid',
      'reject',
      'deny',
      'contradict',
      'opposite',
      'false',
      'incorrect',
      'wrong',
      'broken',
      'failed',
    ];
    const inputHasNegation = input.content
      .toLowerCase()
      .split(/\s+/)
      .some((w) => negationWords.includes(w));

    return this.memories.filter((m) => {
      if (m.projectId !== input.projectId || m.type !== input.type) return false;
      const mKeywords = this.extractKeywords(m.content);
      const overlap = keywords.filter((k) => mKeywords.includes(k));
      if (overlap.length <= 2) return false;

      // Check for negation asymmetry: one has negation, the other doesn't
      const mHasNegation = m.content
        .toLowerCase()
        .split(/\s+/)
        .some((w) => negationWords.includes(w));
      if (inputHasNegation !== mHasNegation) return true;

      // High keyword overlap (>50%) without negation may also indicate contradiction
      const overlapRatio = overlap.length / Math.min(keywords.length, mKeywords.length);
      return overlapRatio > 0.5 && overlap.length > 5;
    });
  }

  /**
   * Extract key phrases from content
   */
  private extractKeywords(content: string): string[] {
    return content
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 4)
      .slice(0, 20);
  }

  /**
   * Calculate importance score
   */
  private calculateImportance(
    input: Pick<EpisodicMemory, 'type' | 'tags' | 'missionId' | 'agentId'>,
  ): number {
    let score = 0.5; // Base score

    // Type-based weighting
    const typeWeights = {
      decision: 0.9,
      reflection: 0.8,
      observation: 0.6,
      action: 0.7,
      context: 0.5,
    };
    score = Math.max(score, typeWeights[input.type] || 0.5);

    // Mission-linked memories are more important
    if (input.missionId) score += 0.1;

    // Agent-linked memories are more important
    if (input.agentId) score += 0.05;

    // Tags indicating importance
    const importantTags = ['critical', 'blocker', 'decision', 'breakthrough', 'lesson'];
    for (const tag of input.tags) {
      if (importantTags.some((it) => tag.toLowerCase().includes(it))) {
        score += 0.1;
      }
    }

    return Math.min(1.0, score);
  }

  /**
   * Update importance of existing memory
   */
  updateImportance(id: string, importance: number): EpisodicMemory {
    const memory = this.memories.find((m) => m.id === id);
    if (!memory) throw new Error('Memory not found');

    memory.importance = importance;
    this.persist();
    return memory;
  }

  /**
   * Mark memory as superseded
   */
  supersede(oldId: string, newId: string): void {
    const oldMemory = this.memories.find((m) => m.id === oldId);
    if (!oldMemory) return;

    oldMemory.supersededBy = newId;
    this.vectorIndex.removeDocument(oldId);
    this.persist();
  }

  // ============================================
  // Read Path (ℛ - Retrieve)
  // ============================================

  /**
   * Retrieve memories with multi-factor scoring
   */
  read(options: EpisodicMemorySearchOptions = {}): EpisodicMemory[] {
    const {
      query,
      agentId,
      missionId,
      type,
      tags,
      minImportance,
      limit = 20,
      includeSuperseded = false,
    } = options;

    // Step 1: Filter by metadata
    let results = this.memories.filter((m) => {
      if (!includeSuperseded && m.supersededBy) return false;
      if (agentId && m.agentId !== agentId) return false;
      if (missionId && m.missionId !== missionId) return false;
      if (type && m.type !== type) return false;
      if (minImportance && m.importance < minImportance) return false;
      if (tags && tags.length > 0) {
        const hasTag = tags.some((t) => m.tags.includes(t));
        if (!hasTag) return false;
      }
      return true;
    });

    // Step 2: Semantic search if query provided
    let searchBoost: Map<string, number> | null = null;
    if (query && query.trim()) {
      const searchResults = this.vectorIndex.search(query, limit * 2);
      searchBoost = new Map(searchResults.map((r) => [r.id, r.score]));
    }

    // Step 3: Multi-factor scoring (does NOT overwrite importance)
    // Formula: score = recency * 0.3 + importance * 0.4 + accessCountFactor * 0.3 + semanticBoost
    const now = Date.now();
    const scored = results.map((m) => {
      const age = (now - new Date(m.timestamp).getTime()) / (1000 * 60 * 60 * 24); // Days
      const recency = Math.exp(-age / 7); // Exponential decay, half-life = 7 days
      const accessFactor = Math.log(m.accessCount + 1) / 5; // Logarithmic scaling
      const semanticBoost = searchBoost?.get(m.id) ? 0.3 : 0;

      const score = recency * 0.3 + m.importance * 0.4 + accessFactor * 0.3 + semanticBoost;

      return { memory: m, score };
    });

    // Step 4: Sort by score and limit
    scored.sort((a, b) => b.score - a.score);

    // Step 5: Update access count on original memories (not spread copies)
    const topResults = scored.slice(0, limit);
    const topIds = new Set(topResults.map((r) => r.memory.id));
    for (const m of this.memories) {
      if (topIds.has(m.id)) {
        m.accessCount++;
        m.lastAccessedAt = new Date().toISOString();
      }
    }

    this.schedulePersist(); // Defer write for access count updates
    return topResults.map((r) => r.memory);
  }

  /**
   * Get single memory by ID
   */
  getById(id: string): EpisodicMemory | undefined {
    const memory = this.memories.find((m) => m.id === id);
    if (memory) {
      memory.accessCount++;
      memory.lastAccessedAt = new Date().toISOString();
      this.schedulePersist(); // Defer write for access count updates
    }
    return memory;
  }

  /**
   * Get memory statistics
   */
  getStats(projectId?: string): MemoryStats {
    const filtered = projectId
      ? this.memories.filter((m) => m.projectId === projectId)
      : this.memories;

    const byType: Record<EpisodicMemory['type'], number> = {
      decision: 0,
      action: 0,
      observation: 0,
      reflection: 0,
      context: 0,
    };

    for (const m of filtered) {
      byType[m.type]++;
    }

    // ISO string comparison — no Date parsing needed
    const sorted = [...filtered].sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
    );

    return {
      totalMemories: filtered.length,
      byType,
      avgImportance: filtered.reduce((sum, m) => sum + m.importance, 0) / filtered.length || 0,
      avgAccessCount: filtered.reduce((sum, m) => sum + m.accessCount, 0) / filtered.length || 0,
      oldestMemory: sorted[0]?.timestamp,
      newestMemory: sorted[sorted.length - 1]?.timestamp,
    };
  }

  // ============================================
  // Manage Path
  // ============================================

  /**
   * Summarize old memories (compression)
   */
  summarizeOldMemories(projectId: string, daysOld: number = 30): EpisodicMemory | null {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    const oldMemories = this.memories.filter(
      (m) => m.projectId === projectId && new Date(m.timestamp) < cutoff && !m.supersededBy,
    );

    if (oldMemories.length === 0) return null;

    // Create summary (simple concatenation, could use LLM)
    const summary: EpisodicMemory = {
      id: uuidv4(),
      projectId,
      timestamp: new Date().toISOString(),
      title: `Summary: ${oldMemories.length} memories from ${cutoff.toISOString().split('T')[0]}`,
      content: oldMemories
        .map((m) => `[${m.type}] ${m.title}: ${m.content.substring(0, 100)}`)
        .join('\n'),
      type: 'context',
      importance: 0.7,
      accessCount: 0,
      tags: ['summary', 'compressed'],
    };

    // Mark old memories as superseded
    for (const m of oldMemories) {
      m.supersededBy = summary.id;
    }

    this.memories.unshift(summary);
    this.persist();

    return summary;
  }

  /**
   * Delete memory
   */
  delete(id: string): boolean {
    const index = this.memories.findIndex((m) => m.id === id);
    if (index === -1) return false;

    this.memories.splice(index, 1);
    this.vectorIndex.removeDocument(id);
    this.persist();

    return true;
  }

  /**
   * Clear all memories for a project
   */
  clearProject(projectId: string): number {
    const count = this.memories.filter((m) => m.projectId === projectId).length;
    this.memories = this.memories.filter((m) => m.projectId !== projectId);
    this.persist();
    return count;
  }

  // ============================================
  // Persistence
  // ============================================

  private load(): void {
    // Load memories
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.memories = JSON.parse(raw);
      } catch (e) {
        process.stderr.write(
          `[EpisodicMemoryStore] Error: ${(e as Error)?.message ?? String(e)}\n`,
        );
        this.memories = [];
      }
    }

    // Load vector index
    this.vectorIndex.load(this.vectorPath);

    // Rebuild index if needed
    if (this.vectorIndex['totalDocuments'] === 0 && this.memories.length > 0) {
      process.stdout.write('[EpisodicMemoryStore] Rebuilding vector index...\n');
      for (const m of this.memories) {
        if (!m.supersededBy) {
          const indexText = `${m.title} ${m.content} ${m.tags.join(' ')}`;
          this.vectorIndex.addDocument(m.id, indexText);
        }
      }
      this.vectorIndex.save(this.vectorPath);
    }
  }

  private persist(): void {
    this.dirty = true;
    // For writes (memory creation), persist immediately
    this.doPersist();
  }

  /**
   * Schedule a deferred persist for read operations (access count updates).
   * Batches multiple reads into a single write to reduce I/O.
   */
  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.dirty) this.doPersist();
    }, 2000);
    this.persistTimer.unref();
  }

  private doPersist(): void {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.memories, null, 2));
    this.vectorIndex.save(this.vectorPath);
    this.dirty = false;
  }
}
