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
export type MemoryKind = 'DECISION' | 'ISSUE' | 'LESSON' | 'SUMMARY';
export type MemoryDuration = 'EPISODIC' | 'LONG_TERM';

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

  /**
   * Structured metadata for procedural memory fields and other typed extensions.
   *
   * Phase D (audit MED item 1): restores the proceduralType/successRate/
   * usageCount/conditions fields that Phase A dropped. Stored as a JSON
   * column in the canonical memory service so the schema is forward-compatible.
   */
  meta?: MemoryMeta;
}

/**
 * Structured metadata attached to memory items.
 * Used primarily for procedural memory fields.
 */
export interface MemoryMeta {
  /** Procedural type classification */
  proceduralType?: 'sop' | 'tool' | 'workflow' | 'heuristic';
  /** Success rate (0-1) for procedural memories */
  successRate?: number;
  /** Invocation count for procedural memories */
  usageCount?: number;
  /** Applicability conditions for procedural memories */
  conditions?: string[];
  /** Additional custom metadata */
  [key: string]: unknown;
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
  /** Security (G10): The agent requesting the read. Used for agent-level isolation —
   * only items written by this agent OR explicitly shared items are returned. */
  readerAgentId?: string;
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
  id?: string;
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
  /** Structured metadata (procedural fields, etc.) */
  meta?: MemoryMeta;
}

/**
 * Memory manage options (for update/delete operations)
 */
export interface MemoryManageOptions {
  id: string;
  projectId: string;
  updates?: Partial<
    Pick<EpisodicMemoryItem, 'priority' | 'tags' | 'confidence' | 'expiresAt' | 'lastAccessedAt'>
  >;
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

  /**
   * WS6 — optional audit query. Backends that cannot serve audit set
   * `unavailable: true`. Namespace filter uses `namespace:<name>` tags.
   */
  queryAudit?(options: {
    projectId: string;
    namespace?: string;
    limit?: number;
  }): Promise<{
    entries: Array<{
      id: string;
      tenantId: string;
      projectId: string;
      memoryId?: string;
      action: string;
      actorId?: string;
      success: boolean;
      createdAt: string;
      tags?: string[];
    }>;
    count: number;
    unavailable: boolean;
  }>;

  // Lifecycle
  close(): Promise<void>;
}

export {
  createMemoryStore,
  resolveMemoryStoreType,
  bootstrapMemoryPersistence,
  fromProjectMemoryItem,
  toProjectMemoryItem,
} from './memory/utils';
// Single curator stack lives in memory/curator.ts (TTL + autonomous merged).
export {
  MemoryCurator,
  getMemoryCurator,
  DEFAULT_CURATOR_CONFIG,
  TtlMemoryCurator, // @deprecated alias of MemoryCurator
  DEFAULT_TTL_CURATOR_CONFIG, // @deprecated alias of DEFAULT_CURATOR_CONFIG
} from './memory/curator';
