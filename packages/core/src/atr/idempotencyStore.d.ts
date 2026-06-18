import type { IdempotencyOptions, IdempotencyRecord } from './types';
export interface IdempotencyStoreConfig {
    filePath: string;
    maxRecords: number;
    defaultTtlSeconds: number;
    evictEveryOps: number;
}
export declare class IdempotencyStore {
    private db;
    private config;
    private opCount;
    private stmtGet;
    private stmtGetRaw;
    private stmtInsertIgnore;
    private stmtReclaim;
    private stmtComplete;
    private stmtFail;
    private stmtEvictExpired;
    private stmtCount;
    private stmtTrimOldest;
    constructor(config?: Partial<IdempotencyStoreConfig>);
    private openDb;
    private prepareStatements;
    begin(key: string, options?: Partial<IdempotencyOptions>): {
        acquired: boolean;
        record: IdempotencyRecord;
    };
    complete(key: string, result: string, opts?: {
        tenantId?: string;
        ttlSeconds?: number;
    }): void;
    fail(key: string, error: string, opts?: {
        tenantId?: string;
        ttlSeconds?: number;
    }): void;
    get(key: string, opts?: {
        tenantId?: string;
    }): IdempotencyRecord | null;
    evict(): number;
    size(): number;
    close(): void;
    private namespaceKey;
    private enforceSizeCap;
    private maybeEvict;
    private rowToRecord;
}
export declare function getIdempotencyStore(): IdempotencyStore;
export declare function resetIdempotencyStore(): void;
export declare function newLeaseToken(): string;
//# sourceMappingURL=idempotencyStore.d.ts.map