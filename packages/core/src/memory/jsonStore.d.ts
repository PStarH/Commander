import type { EpisodicMemoryItem, MemoryWriteOptions, MemorySearchQuery, MemorySearchResult, MemoryManageOptions, MemoryStats, MemoryStore } from '../memory';
/**
 * JSON-file backed MemoryStore for simple persistence.
 * Falls back gracefully when SQLite is unavailable.
 *
 * Uses BM25 scoring (Okapi BM25) for high-quality full-text search,
 * matching the search quality of SQLite FTS5.
 */
export declare class JsonMemoryStore implements MemoryStore {
    private items;
    private filePath;
    private nextId;
    private dirty;
    private persistTimer;
    private bm25;
    private tokenCache;
    private indexDirty;
    constructor(filePath: string);
    init(): Promise<void>;
    private persist;
    write(options: MemoryWriteOptions): Promise<EpisodicMemoryItem>;
    batchWrite(items: MemoryWriteOptions[]): Promise<EpisodicMemoryItem[]>;
    update(options: MemoryManageOptions): Promise<EpisodicMemoryItem | null>;
    delete(id: string, projectId: string): Promise<boolean>;
    deleteByMission(missionId: string, projectId: string): Promise<number>;
    deleteExpired(projectId: string): Promise<number>;
    read(id: string, projectId: string): Promise<EpisodicMemoryItem | null>;
    private schedulePersist;
    search(query: MemorySearchQuery): Promise<MemorySearchResult>;
    /** Rebuild BM25 index from all items. Called lazily on first search. */
    private rebuildIndex;
    /** Add a single item to the BM25 index. */
    private indexItem;
    /** Remove a single item from the BM25 index. */
    private deindexItem;
    searchSemantic(query: string, projectId: string, limit?: number): Promise<EpisodicMemoryItem[]>;
    getStats(projectId: string): Promise<MemoryStats>;
    close(): Promise<void>;
}
