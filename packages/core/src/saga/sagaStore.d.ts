import type { SagaStateSnapshot, SagaEvent } from './types';
export interface SagaStore {
    appendEvent(event: SagaEvent): Promise<void>;
    readEvents(runId: string): Promise<SagaEvent[]>;
    writeSnapshot(snapshot: SagaStateSnapshot): Promise<void>;
    readSnapshot(runId: string): Promise<SagaStateSnapshot | undefined>;
    listRunIds(): Promise<string[]>;
    deleteRun(runId: string): Promise<void>;
}
export interface FileSagaStoreOptions {
    baseDir: string;
    prettyPrint?: boolean;
}
export declare class FileSagaStore implements SagaStore {
    private readonly options;
    constructor(options: FileSagaStoreOptions);
    private eventsPath;
    private snapshotPath;
    private ensureDir;
    appendEvent(event: SagaEvent): Promise<void>;
    readEvents(runId: string): Promise<SagaEvent[]>;
    writeSnapshot(snapshot: SagaStateSnapshot): Promise<void>;
    readSnapshot(runId: string): Promise<SagaStateSnapshot | undefined>;
    listRunIds(): Promise<string[]>;
    deleteRun(runId: string): Promise<void>;
}
export declare class InMemorySagaStore implements SagaStore {
    private readonly events;
    private readonly snapshots;
    appendEvent(event: SagaEvent): Promise<void>;
    readEvents(runId: string): Promise<SagaEvent[]>;
    writeSnapshot(snapshot: SagaStateSnapshot): Promise<void>;
    readSnapshot(runId: string): Promise<SagaStateSnapshot | undefined>;
    listRunIds(): Promise<string[]>;
    deleteRun(runId: string): Promise<void>;
}
//# sourceMappingURL=sagaStore.d.ts.map