/**
 * Commander Episodic Memory System
 * 
 * Based on research findings from:
 * - "Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers" (arXiv 2603.07670v1)
 * - Claude Code three-layer memory architecture
 * 
 * Implementation:
 * - Layer 1: In-Context Memory (session-scoped, ephemeral)
 * - Layer 2: Episodic Memory Store (SQLite + vector index for semantic search)
 * - Layer 3: Semantic Memory (abstracted knowledge, future work)
 */

// ============================================================================
// Type Definitions
// ============================================================================

// Use types from index.ts (ProjectMemoryKind, MemoryDuration)
// Note: We can't import from index.ts as it would cause circular dependency
// So we define local aliases that match the canonical types
type MemoryKind = 'DECISION' | 'ISSUE' | 'LESSON' | 'SUMMARY';
type MemoryDuration = 'EPISODIC' | 'LONG_TERM';

/**
 * Priority score for memory items (0-100)
 */
export type MemoryPriority = number;

/**
 * Episodic memory item - concrete experience record with timestamp
 */
export interface EpisodicMemoryItem {
  id: string;
  projectId: string;
  missionId?: string;
  agentId?: string;
  
  // Memory classification
  kind: MemoryKind;
  duration: MemoryDuration;
  
  // Content
  title: string;
  content: string;
  tags: string[];
  
  // Importance scoring (research: recency + relevance + importance)
  priority: MemoryPriority;
  
  // Timestamps
  createdAt: string;
  lastAccessedAt: string;
  expiresAt?: string;
  
  // Evidence citation (research: avoid baseless generalization)
  evidenceRefs?: string[];
  
  // Confidence score (research: quality gate)
  confidence: number; // 0.0 - 1.0
}

/**
 * Memory search query
 */
export interface MemorySearchQuery {
  projectId: string;
  query?: string;
  kind?: MemoryKind;
  missionId?: string;
  agentId?: string;
  tags?: string[];
  limit?: number;
  minPriority?: number;
  minConfidence?: number;
}

/**
 * Memory search result
 */
export interface MemorySearchResult {
  items: EpisodicMemoryItem[];
  total: number;
  query: MemorySearchQuery;
}

/**
 * Memory write options
 */
export interface MemoryWriteOptions {
  projectId: string;
  missionId?: string;
  agentId?: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags?: string[];
  priority?: number;
  evidenceRefs?: string[];
  confidence?: number;
  duration?: MemoryDuration;
}

/**
 * Memory manage options (for update/delete operations)
 */
export interface MemoryManageOptions {
  id: string;
  projectId: string;
  updates?: Partial<Pick<EpisodicMemoryItem, 'priority' | 'tags' | 'confidence' | 'expiresAt'>>;
  delete?: boolean;
}

/**
 * Memory statistics
 */
export interface MemoryStats {
  totalItems: number;
  byKind: Record<MemoryKind, number>;
  byDuration: Record<MemoryDuration, number>;
  avgPriority: number;
  avgConfidence: number;
  topTags: Array<{ tag: string; count: number }>;
  oldestItem?: string;
  newestItem?: string;
}

// ============================================================================
// Memory Store Interface (Write-Manage-Read Loop)
// ============================================================================

/**
 * Memory Store Interface
 * 
 * Implements the Write-Manage-Read loop from research:
 * - Write (𝒰): Store, summarize, deduplicate, score, delete
 * - Manage: Organize and index
 * - Read (ℛ): Retrieve relevant memories
 */
export interface MemoryStore {
  // Write operations
  write(options: MemoryWriteOptions): Promise<EpisodicMemoryItem>;
  batchWrite(items: MemoryWriteOptions[]): Promise<EpisodicMemoryItem[]>;
  
  // Manage operations
  update(options: MemoryManageOptions): Promise<EpisodicMemoryItem | null>;
  delete(id: string, projectId: string): Promise<boolean>;
  deleteByMission(missionId: string, projectId: string): Promise<number>;
  deleteExpired(projectId: string): Promise<number>;
  
  // Read operations
  read(id: string, projectId: string): Promise<EpisodicMemoryItem | null>;
  search(query: MemorySearchQuery): Promise<MemorySearchResult>;
  searchSemantic(query: string, projectId: string, limit?: number): Promise<EpisodicMemoryItem[]>;
  
  // Statistics
  getStats(projectId: string): Promise<MemoryStats>;
  
  // Lifecycle
  close(): Promise<void>;
}

// ============================================================================
// In-Memory Implementation (for testing/development)
// ============================================================================

/**
 * In-Memory Memory Store
 * 
 * Simple implementation for testing and development.
 * Does NOT persist to disk - use SqliteMemoryStore for production.
 */
export class InMemoryMemoryStore implements MemoryStore {
  private items: Map<string, EpisodicMemoryItem> = new Map();
  private nextId = 1;

  async write(options: MemoryWriteOptions): Promise<EpisodicMemoryItem> {
    const now = new Date().toISOString();
    const id = `memory-${this.nextId++}`;
    
    const item: EpisodicMemoryItem = {
      id,
      projectId: options.projectId,
      missionId: options.missionId,
      agentId: options.agentId,
      kind: options.kind,
      duration: options.duration ?? 'EPISODIC',
      title: options.title,
      content: options.content,
      tags: options.tags ?? [],
      priority: options.priority ?? this.calculateDefaultPriority(options),
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: options.duration === 'EPISODIC' 
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days for episodic
        : undefined,
      evidenceRefs: options.evidenceRefs,
      confidence: options.confidence ?? 0.8,
    };
    
    this.items.set(id, item);
    return item;
  }

  async batchWrite(items: MemoryWriteOptions[]): Promise<EpisodicMemoryItem[]> {
    const results: EpisodicMemoryItem[] = [];
    for (const item of items) {
      results.push(await this.write(item));
    }
    return results;
  }

  async update(options: MemoryManageOptions): Promise<EpisodicMemoryItem | null> {
    const item = this.items.get(options.id);
    if (!item || item.projectId !== options.projectId) {
      return null;
    }
    
    if (options.delete) {
      this.items.delete(options.id);
      return null;
    }
    
    if (options.updates) {
      Object.assign(item, options.updates);
      item.lastAccessedAt = new Date().toISOString();
    }
    
    return item;
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const item = this.items.get(id);
    if (!item || item.projectId !== projectId) {
      return false;
    }
    this.items.delete(id);
    return true;
  }

  async deleteByMission(missionId: string, projectId: string): Promise<number> {
    let count = 0;
    for (const [id, item] of this.items) {
      if (item.projectId === projectId && item.missionId === missionId) {
        this.items.delete(id);
        count++;
      }
    }
    return count;
  }

  async deleteExpired(projectId: string): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const [id, item] of this.items) {
      if (item.projectId === projectId && item.expiresAt) {
        if (new Date(item.expiresAt) < now) {
          this.items.delete(id);
          count++;
        }
      }
    }
    return count;
  }

  async read(id: string, projectId: string): Promise<EpisodicMemoryItem | null> {
    const item = this.items.get(id);
    if (!item || item.projectId !== projectId) {
      return null;
    }
    
    // Update last accessed time
    item.lastAccessedAt = new Date().toISOString();
    return item;
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
    let results = Array.from(this.items.values())
      .filter(item => item.projectId === query.projectId);
    
    // Filter by kind
    if (query.kind) {
      results = results.filter(item => item.kind === query.kind);
    }
    
    // Filter by mission
    if (query.missionId) {
      results = results.filter(item => item.missionId === query.missionId);
    }
    
    // Filter by agent
    if (query.agentId) {
      results = results.filter(item => item.agentId === query.agentId);
    }
    
    // Filter by tags
    if (query.tags && query.tags.length > 0) {
      results = results.filter(item => 
        query.tags!.some(tag => item.tags.includes(tag))
      );
    }
    
    // Filter by priority
    if (query.minPriority !== undefined) {
      results = results.filter(item => item.priority >= query.minPriority!);
    }
    
    // Filter by confidence
    if (query.minConfidence !== undefined) {
      results = results.filter(item => item.confidence >= query.minConfidence!);
    }
    
    // Text search (simple contains check)
    if (query.query) {
      const lowerQuery = query.query.toLowerCase();
      results = results.filter(item => 
        item.title.toLowerCase().includes(lowerQuery) ||
        item.content.toLowerCase().includes(lowerQuery)
      );
    }
    
    // Sort by priority (descending) then by createdAt (descending)
    results.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    
    const total = results.length;
    const limit = query.limit ?? 50;
    const items = results.slice(0, limit);
    
    return { items, total, query };
  }

  async searchSemantic(query: string, projectId: string, limit = 10): Promise<EpisodicMemoryItem[]> {
    // TF-IDF based semantic search
    // Scores items by term frequency × inverse document frequency
    const projectItems = Array.from(this.items.values())
      .filter(item => item.projectId === projectId);

    if (projectItems.length === 0) return [];

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    // Build IDF: log(N / df) where df = number of docs containing term
    const N = projectItems.length;
    const idf = new Map<string, number>();
    for (const term of queryTerms) {
      const df = projectItems.filter(item =>
        tokenize(item.title + ' ' + item.content).includes(term)
      ).length;
      idf.set(term, Math.log(N / (df + 1)) + 1);
    }

    // Score each item: sum of (term_freq × idf) normalized by doc length
    const scored = projectItems.map(item => {
      const docTerms = tokenize(item.title + ' ' + item.content);
      const docLen = docTerms.length || 1;
      let score = 0;

      for (const term of queryTerms) {
        const tf = docTerms.filter(t => t === term).length / docLen;
        const termIdf = idf.get(term) ?? 1;
        score += tf * termIdf;
      }

      // Boost by priority and confidence
      score *= (1 + item.priority / 100) * (0.5 + item.confidence);

      return { item, score };
    });

    // Sort by score descending, then recency
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.item.createdAt).getTime() - new Date(a.item.createdAt).getTime();
    });

    return scored.slice(0, limit).map(s => {
      s.item.lastAccessedAt = new Date().toISOString();
      return s.item;
    });
  }

  async getStats(projectId: string): Promise<MemoryStats> {
    const projectItems = Array.from(this.items.values())
      .filter(item => item.projectId === projectId);
    
    const byKind: Record<MemoryKind, number> = {
      DECISION: 0,
      ISSUE: 0,
      LESSON: 0,
      SUMMARY: 0,
    };
    
    const byDuration: Record<MemoryDuration, number> = {
      EPISODIC: 0,
      LONG_TERM: 0,
    };
    
    const tagCounts: Map<string, number> = new Map();
    let totalPriority = 0;
    let totalConfidence = 0;
    let oldestItem: string | undefined;
    let newestItem: string | undefined;
    
    for (const item of projectItems) {
      byKind[item.kind]++;
      byDuration[item.duration]++;
      totalPriority += item.priority;
      totalConfidence += item.confidence;
      
      for (const tag of item.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
      
      if (!oldestItem || item.createdAt < oldestItem) {
        oldestItem = item.createdAt;
      }
      if (!newestItem || item.createdAt > newestItem) {
        newestItem = item.createdAt;
      }
    }
    
    const topTags = Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    return {
      totalItems: projectItems.length,
      byKind,
      byDuration,
      avgPriority: projectItems.length > 0 ? totalPriority / projectItems.length : 0,
      avgConfidence: projectItems.length > 0 ? totalConfidence / projectItems.length : 0,
      topTags,
      oldestItem,
      newestItem,
    };
  }

  async close(): Promise<void> {
    // No-op for in-memory store
  }

  private calculateDefaultPriority(options: MemoryWriteOptions): number {
    // Base priority based on kind
    const kindPriority: Record<MemoryKind, number> = {
      DECISION: 80,
      ISSUE: 70,
      LESSON: 90,
      SUMMARY: 50,
    };
    
    let priority = kindPriority[options.kind] ?? 50;
    
    // Boost if has mission/agent context
    if (options.missionId) priority += 5;
    if (options.agentId) priority += 5;
    
    // Boost if has evidence
    if (options.evidenceRefs && options.evidenceRefs.length > 0) {
      priority += Math.min(options.evidenceRefs.length * 5, 15);
    }
    
    return Math.min(priority, 100);
  }
}

// ============================================================================
// SQLite + Vector Index Implementation (Production)
// ============================================================================

/**
 * SQLite-based Memory Store with vector similarity search
 * 
 * Note: This is a placeholder interface for the production implementation.
 * Full implementation requires:
 * 1. better-sqlite3 or sqlite3 package
 * 2. Vector extension or separate vector DB (e.g., sqlite-vec, LanceDB)
 * 3. Embedding model integration
 * 
 * For now, use InMemoryMemoryStore for development.
 */
export class SqliteMemoryStore implements MemoryStore {
  private items: Map<string, EpisodicMemoryItem> = new Map();
  private filePath: string;
  private nextId = 1;
  private dirty = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Load persisted data from disk */
  async init(): Promise<void> {
    try {
      const { readFile } = require('fs/promises') as typeof import('fs/promises');
      const data = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          this.items.set(item.id, item);
          const num = parseInt(item.id.replace('memory-', ''), 10);
          if (!isNaN(num) && num >= this.nextId) this.nextId = num + 1;
        }
      }
    } catch {
      // File doesn't exist yet — start empty
    }
  }

  /** Flush to disk if dirty */
  private async persist(): Promise<void> {
    if (!this.dirty) return;
    const { writeFile, mkdir } = require('fs/promises') as typeof import('fs/promises');
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
    if (dir) await mkdir(dir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(Array.from(this.items.values()), null, 2));
    this.dirty = false;
  }

  async write(options: MemoryWriteOptions): Promise<EpisodicMemoryItem> {
    const now = new Date().toISOString();
    const id = `memory-${this.nextId++}`;
    
    const kindPriority: Record<MemoryKind, number> = {
      DECISION: 80, ISSUE: 70, LESSON: 90, SUMMARY: 50,
    };
    let priority = options.priority ?? (kindPriority[options.kind] ?? 50);
    if (options.missionId) priority += 5;
    if (options.agentId) priority += 5;
    if (options.evidenceRefs?.length) priority += Math.min(options.evidenceRefs.length * 5, 15);
    priority = Math.min(priority, 100);

    const item: EpisodicMemoryItem = {
      id,
      projectId: options.projectId,
      missionId: options.missionId,
      agentId: options.agentId,
      kind: options.kind,
      duration: options.duration ?? 'EPISODIC',
      title: options.title,
      content: options.content,
      tags: options.tags ?? [],
      priority,
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: options.duration === 'EPISODIC'
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        : undefined,
      evidenceRefs: options.evidenceRefs,
      confidence: options.confidence ?? 0.8,
    };

    this.items.set(id, item);
    this.dirty = true;
    await this.persist();
    return item;
  }

  async batchWrite(items: MemoryWriteOptions[]): Promise<EpisodicMemoryItem[]> {
    const results: EpisodicMemoryItem[] = [];
    for (const item of items) {
      results.push(await this.write(item));
    }
    return results;
  }

  async update(options: MemoryManageOptions): Promise<EpisodicMemoryItem | null> {
    const item = this.items.get(options.id);
    if (!item || item.projectId !== options.projectId) return null;
    
    if (options.delete) {
      this.items.delete(options.id);
      this.dirty = true;
      await this.persist();
      return null;
    }
    
    if (options.updates) {
      Object.assign(item, options.updates);
      item.lastAccessedAt = new Date().toISOString();
      this.dirty = true;
      await this.persist();
    }
    
    return item;
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const item = this.items.get(id);
    if (!item || item.projectId !== projectId) return false;
    this.items.delete(id);
    this.dirty = true;
    await this.persist();
    return true;
  }

  async deleteByMission(missionId: string, projectId: string): Promise<number> {
    let count = 0;
    for (const [id, item] of this.items) {
      if (item.projectId === projectId && item.missionId === missionId) {
        this.items.delete(id);
        count++;
      }
    }
    if (count > 0) { this.dirty = true; await this.persist(); }
    return count;
  }

  async deleteExpired(projectId: string): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const [id, item] of this.items) {
      if (item.projectId === projectId && item.expiresAt && new Date(item.expiresAt) < now) {
        this.items.delete(id);
        count++;
      }
    }
    if (count > 0) { this.dirty = true; await this.persist(); }
    return count;
  }

  async read(id: string, projectId: string): Promise<EpisodicMemoryItem | null> {
    const item = this.items.get(id);
    if (!item || item.projectId !== projectId) return null;
    item.lastAccessedAt = new Date().toISOString();
    return item;
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
    let results = Array.from(this.items.values())
      .filter(item => item.projectId === query.projectId);
    
    if (query.kind) results = results.filter(item => item.kind === query.kind);
    if (query.missionId) results = results.filter(item => item.missionId === query.missionId);
    if (query.agentId) results = results.filter(item => item.agentId === query.agentId);
    if (query.tags?.length) results = results.filter(item => query.tags!.some(tag => item.tags.includes(tag)));
    if (query.minPriority !== undefined) results = results.filter(item => item.priority >= query.minPriority!);
    if (query.minConfidence !== undefined) results = results.filter(item => item.confidence >= query.minConfidence!);
    if (query.query) {
      const lower = query.query.toLowerCase();
      results = results.filter(item => item.title.toLowerCase().includes(lower) || item.content.toLowerCase().includes(lower));
    }
    
    results.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    
    const total = results.length;
    const limit = query.limit ?? 50;
    return { items: results.slice(0, limit), total, query };
  }

  async searchSemantic(query: string, projectId: string, limit = 10): Promise<EpisodicMemoryItem[]> {
    const projectItems = Array.from(this.items.values())
      .filter(item => item.projectId === projectId);
    if (projectItems.length === 0) return [];

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    const N = projectItems.length;
    const idf = new Map<string, number>();
    for (const term of queryTerms) {
      const df = projectItems.filter(item =>
        tokenize(item.title + ' ' + item.content).includes(term)
      ).length;
      idf.set(term, Math.log(N / (df + 1)) + 1);
    }

    const scored = projectItems.map(item => {
      const docTerms = tokenize(item.title + ' ' + item.content);
      const docLen = docTerms.length || 1;
      let score = 0;
      for (const term of queryTerms) {
        const tf = docTerms.filter(t => t === term).length / docLen;
        score += tf * (idf.get(term) ?? 1);
      }
      score *= (1 + item.priority / 100) * (0.5 + item.confidence);
      return { item, score };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.item.createdAt).getTime() - new Date(a.item.createdAt).getTime();
    });

    return scored.slice(0, limit).map(s => {
      s.item.lastAccessedAt = new Date().toISOString();
      return s.item;
    });
  }

  async getStats(projectId: string): Promise<MemoryStats> {
    const projectItems = Array.from(this.items.values())
      .filter(item => item.projectId === projectId);
    
    const byKind: Record<MemoryKind, number> = { DECISION: 0, ISSUE: 0, LESSON: 0, SUMMARY: 0 };
    const byDuration: Record<MemoryDuration, number> = { EPISODIC: 0, LONG_TERM: 0 };
    const tagCounts = new Map<string, number>();
    let totalPriority = 0, totalConfidence = 0;
    let oldestItem: string | undefined, newestItem: string | undefined;
    
    for (const item of projectItems) {
      byKind[item.kind]++;
      byDuration[item.duration]++;
      totalPriority += item.priority;
      totalConfidence += item.confidence;
      for (const tag of item.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      if (!oldestItem || item.createdAt < oldestItem) oldestItem = item.createdAt;
      if (!newestItem || item.createdAt > newestItem) newestItem = item.createdAt;
    }
    
    return {
      totalItems: projectItems.length,
      byKind,
      byDuration,
      avgPriority: projectItems.length > 0 ? totalPriority / projectItems.length : 0,
      avgConfidence: projectItems.length > 0 ? totalConfidence / projectItems.length : 0,
      topTags: Array.from(tagCounts.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      oldestItem,
      newestItem,
    };
  }

  async close(): Promise<void> {
    await this.persist();
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Tokenize text into lowercase terms, removing stopwords and short tokens
 * Used by TF-IDF semantic search
 */
function tokenize(text: string): string[] {
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'must',
    'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
    'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
    'i', 'me', 'my', 'not', 'no', 'nor', 'and', 'but', 'or', 'if', 'then',
    'for', 'of', 'in', 'on', 'at', 'to', 'by', 'with', 'from', 'as',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'out', 'off', 'over', 'under', 'again', 'further',
    'about', 'up', 'down', 'here', 'there', 'when', 'where', 'why', 'how',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
    'such', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ') // keep alphanumeric + CJK
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

/**
 * Create a default memory store instance
 */
export function createMemoryStore(type: 'in-memory' | 'sqlite' = 'in-memory'): MemoryStore {
  switch (type) {
    case 'in-memory':
      return new InMemoryMemoryStore();
    case 'sqlite':
      return new SqliteMemoryStore('.commander/memory.json');
    default:
      throw new Error(`Unknown memory store type: ${type}`);
  }
}

/**
 * Convert ProjectMemoryItem to EpisodicMemoryItem
 * (for backward compatibility with existing code)
 */
export function fromProjectMemoryItem(item: {
  id: string;
  projectId: string;
  missionId?: string;
  agentId?: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  duration?: MemoryDuration;
}): EpisodicMemoryItem {
  return {
    id: item.id,
    projectId: item.projectId,
    missionId: item.missionId,
    agentId: item.agentId,
    kind: item.kind,
    duration: item.duration ?? 'EPISODIC',
    title: item.title,
    content: item.content,
    tags: item.tags,
    priority: 50,
    createdAt: item.createdAt,
    lastAccessedAt: item.createdAt,
    confidence: 0.8,
  };
}

/**
 * Convert EpisodicMemoryItem to ProjectMemoryItem
 * (for backward compatibility with existing code)
 */
export function toProjectMemoryItem(item: EpisodicMemoryItem): {
  id: string;
  projectId: string;
  missionId?: string;
  agentId?: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  duration?: MemoryDuration;
} {
  return {
    id: item.id,
    projectId: item.projectId,
    missionId: item.missionId,
    agentId: item.agentId,
    kind: item.kind,
    title: item.title,
    content: item.content,
    tags: item.tags,
    createdAt: item.createdAt,
    duration: item.duration,
  };
}
