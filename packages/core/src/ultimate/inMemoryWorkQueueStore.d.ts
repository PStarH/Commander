import type { WorkQueueStore } from './workQueueStore';
import type { WorkItem } from './workCoordinator';
export declare class InMemoryWorkQueueStore implements WorkQueueStore {
    private items;
    loadAll(): WorkItem[];
    enqueue(item: WorkItem): void;
    update(item: WorkItem): void;
    updateMany(items: WorkItem[]): void;
    remove(predicate: (item: WorkItem) => boolean): number;
    tryClaim(agentId: string, workId: string, leaseToken: string, nowIso: string): boolean;
    releaseClaim(leaseToken: string): void;
    close(): void;
}
//# sourceMappingURL=inMemoryWorkQueueStore.d.ts.map