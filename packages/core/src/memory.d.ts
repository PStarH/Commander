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
    kind: MemoryKind;
    duration: MemoryDuration;
    title: string;
    content: string;
    tags: string[];
    priority: MemoryPriority;
    createdAt: string;
    lastAccessedAt: string;
    expiresAt?: string;
    evidenceRefs?: string[];
    confidence: number;
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
    topTags: Array<{
        tag: string;
        count: number;
    }>;
    oldestItem?: string;
    newestItem?: string;
}
/**
 * Memory Store Interface
 *
 * Implements the Write-Manage-Read loop from research:
 * - Write (𝒰): Store, summarize, deduplicate, score, delete
 * - Manage: Organize and index
 * - Read (ℛ): Retrieve relevant memories
 */
export interface MemoryStore {
    write(options: MemoryWriteOptions): Promise<EpisodicMemoryItem>;
    batchWrite(items: MemoryWriteOptions[]): Promise<EpisodicMemoryItem[]>;
    update(options: MemoryManageOptions): Promise<EpisodicMemoryItem | null>;
    delete(id: string, projectId: string): Promise<boolean>;
    deleteByMission(missionId: string, projectId: string): Promise<number>;
    deleteExpired(projectId: string): Promise<number>;
    read(id: string, projectId: string): Promise<EpisodicMemoryItem | null>;
    search(query: MemorySearchQuery): Promise<MemorySearchResult>;
    searchSemantic(query: string, projectId: string, limit?: number): Promise<EpisodicMemoryItem[]>;
    getStats(projectId: string): Promise<MemoryStats>;
    close(): Promise<void>;
}
/**
 * In-Memory Memory Store
 *
 * Simple implementation for testing and development.
 * Does NOT persist to disk - use JsonMemoryStore for production.
 */
export declare class InMemoryMemoryStore implements MemoryStore {
    private items;
    private nextId;
    private maxEntries;
    private accessOrder;
    private accessOrderMap;
    constructor(maxEntries?: number);
    write(options: MemoryWriteOptions): Promise<EpisodicMemoryItem>;
    batchWrite(items: MemoryWriteOptions[]): Promise<EpisodicMemoryItem[]>;
    update(options: MemoryManageOptions): Promise<EpisodicMemoryItem | null>;
    delete(id: string, projectId: string): Promise<boolean>;
    deleteByMission(missionId: string, projectId: string): Promise<number>;
    deleteExpired(projectId: string): Promise<number>;
    read(id: string, projectId: string): Promise<EpisodicMemoryItem | null>;
    search(query: MemorySearchQuery): Promise<MemorySearchResult>;
    searchSemantic(query: string, projectId: string, limit?: number): Promise<EpisodicMemoryItem[]>;
    getStats(projectId: string): Promise<MemoryStats>;
    close(): Promise<void>;
    private evictLRU;
    private calculateDefaultPriority;
}
export { JsonMemoryStore } from './memory/jsonStore';
export { createMemoryStore, fromProjectMemoryItem, toProjectMemoryItem } from './memory/utils';
