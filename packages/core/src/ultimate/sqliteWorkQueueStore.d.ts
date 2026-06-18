import type { WorkQueueStore } from './workQueueStore';
import type { WorkItem } from './workCoordinator';
export interface SqliteWorkQueueStoreConfig {
    filePath: string;
}
export declare class SqliteWorkQueueStore implements WorkQueueStore {
    private db;
    private config;
    private stmtLoadAll;
    private stmtEnqueue;
    private stmtUpdate;
    private stmtRemove;
    private stmtTryClaim;
    private stmtReleaseClaim;
    private stmtColumnExists;
    constructor(config: SqliteWorkQueueStoreConfig);
    private openDb;
    private migrate;
    private prepareStatements;
    loadAll(): WorkItem[];
    enqueue(item: WorkItem): void;
    update(item: WorkItem): void;
    updateMany(items: WorkItem[]): void;
    remove(predicate: (item: WorkItem) => boolean): number;
    tryClaim(agentId: string, workId: string, leaseToken: string, nowIso: string): boolean;
    releaseClaim(leaseToken: string): void;
    close(): void;
}
//# sourceMappingURL=sqliteWorkQueueStore.d.ts.map