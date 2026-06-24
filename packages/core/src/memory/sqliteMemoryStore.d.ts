/**
 * SQLite-backed MemoryStore
 *
 * Production-grade persistent memory storage using better-sqlite3.
 * Replaces file-based JSON storage with ACID transactions,
 * indexed queries, and FTS5 full-text search.
 *
 * Features:
 * - WAL mode for concurrent read/write
 * - FTS5 full-text search (matching Hermes)
 * - Automatic expiration via TTL
 * - Prepared statements for performance
 * - Transaction batching for bulk writes
 */
import type { EpisodicMemoryItem, MemoryWriteOptions, MemorySearchQuery, MemorySearchResult, MemoryManageOptions, MemoryStats, MemoryStore } from '../memory';
export declare class SqliteMemoryStore implements MemoryStore {
    private db;
    private filePath;
    private initialized;
    private initPromise;
    private stmtInsert;
    private stmtGet;
    private stmtDelete;
    private stmtDeleteByMission;
    private stmtDeleteExpired;
    private stmtUpdate;
    private stmtSearch;
    private stmtFtsSearch;
    private stmtGetStats;
    constructor(filePath: string);
    init(): Promise<void>;
    private createSchema;
    private prepareStatements;
    write(options: MemoryWriteOptions): Promise<EpisodicMemoryItem>;
    batchWrite(items: MemoryWriteOptions[]): Promise<EpisodicMemoryItem[]>;
    read(id: string, projectId: string): Promise<EpisodicMemoryItem | null>;
    update(options: MemoryManageOptions): Promise<EpisodicMemoryItem | null>;
    delete(id: string, projectId: string): Promise<boolean>;
    deleteByMission(missionId: string, projectId: string): Promise<number>;
    deleteExpired(projectId: string): Promise<number>;
    search(query: MemorySearchQuery): Promise<MemorySearchResult>;
    searchSemantic(query: string, projectId: string, limit?: number): Promise<EpisodicMemoryItem[]>;
    getStats(projectId: string): Promise<MemoryStats>;
    close(): Promise<void>;
    private ensureInitialized;
    private rowToItem;
    private buildFtsQuery;
}
