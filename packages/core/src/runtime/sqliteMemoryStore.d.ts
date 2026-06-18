import type { MemoryStore, MemoryWriteOptions, EpisodicMemoryItem, MemorySearchQuery, MemorySearchResult, MemoryManageOptions, MemoryStats } from '../memory';
/**
 * SQLite-backed Memory Store
 *
 * Production-grade persistence using better-sqlite3.
 * Provides the same MemoryStore interface as InMemoryMemoryStore/JsonMemoryStore
 * but with proper SQL indexing, transactions, and disk persistence.
 *
 * Schema:
 *   memories(id TEXT PK, project_id TEXT, mission_id TEXT, agent_id TEXT,
 *            kind TEXT, duration TEXT, title TEXT, content TEXT, tags TEXT JSON,
 *            priority REAL, confidence REAL, created_at TEXT, last_accessed_at TEXT,
 *            expires_at TEXT, evidence_refs TEXT JSON)
 *
 * Indexes: project_id + kind, project_id + created_at, project_id + priority,
 *          project_id + tags (GIN-style via JSON LIKE), expires_at
 */
export declare class SqliteMemoryStore implements MemoryStore {
    private db;
    private filePath;
    private initialized;
    private stmtWrite;
    private stmtRead;
    private stmtDelete;
    private stmtSearch;
    private stmtCountByKind;
    private stmtCountByDuration;
    private stmtStats;
    private stmtDeleteExpired;
    private stmtDeleteByMission;
    private stmtFtsSearch;
    private stmtFtsCount;
    constructor(filePath?: string);
    init(): Promise<void>;
    private createSchema;
    private prepareStatements;
    private nextId;
    private generateId;
    private rowToItem;
    private calculatePriority;
    write(options: MemoryWriteOptions): Promise<EpisodicMemoryItem>;
    batchWrite(items: MemoryWriteOptions[]): Promise<EpisodicMemoryItem[]>;
    update(options: MemoryManageOptions): Promise<EpisodicMemoryItem | null>;
    delete(id: string, projectId: string): Promise<boolean>;
    deleteByMission(missionId: string, projectId: string): Promise<number>;
    deleteExpired(projectId: string): Promise<number>;
    read(id: string, projectId: string): Promise<EpisodicMemoryItem | null>;
    search(query: MemorySearchQuery): Promise<MemorySearchResult>;
    searchSemantic(_query: string, _projectId: string, _limit?: number): Promise<EpisodicMemoryItem[]>;
    /**
     * Build an FTS5-compatible query string from user input.
     * Handles special characters, quotes multi-word phrases, and adds prefix matching.
     */
    private buildFtsQuery;
    /**
     * Search conversation history (FTS5-powered cross-session recall).
     * Searches across all persisted conversations for matching content.
     */
    searchConversations(query: string, projectId: string, limit?: number): Promise<EpisodicMemoryItem[]>;
    getStats(projectId: string): Promise<MemoryStats>;
    close(): Promise<void>;
}
//# sourceMappingURL=sqliteMemoryStore.d.ts.map