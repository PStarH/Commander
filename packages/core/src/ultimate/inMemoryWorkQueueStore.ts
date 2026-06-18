import type { WorkQueueStore } from './workQueueStore';
import type { WorkItem } from './workCoordinator';

export class InMemoryWorkQueueStore implements WorkQueueStore {
  private items = new Map<string, WorkItem>();

  loadAll(): WorkItem[] {
    return Array.from(this.items.values()).map((i) => ({ ...i }));
  }

  enqueue(item: WorkItem): void {
    this.items.set(item.id, { ...item });
  }

  update(item: WorkItem): void {
    this.items.set(item.id, { ...item });
  }

  updateMany(items: WorkItem[]): void {
    for (const i of items) this.items.set(i.id, { ...i });
  }

  remove(predicate: (item: WorkItem) => boolean): number {
    let removed = 0;
    for (const [id, item] of this.items) {
      if (predicate(item)) {
        this.items.delete(id);
        removed++;
      }
    }
    return removed;
  }

  tryClaim(agentId: string, workId: string, leaseToken: string, nowIso: string): boolean {
    const item = this.items.get(workId);
    if (!item || item.status !== 'PENDING') return false;
    item.status = 'CLAIMED';
    item.claimedBy = agentId;
    item.claimedAt = nowIso;
    item.leaseToken = leaseToken;
    item.fencingEpoch = (item.fencingEpoch ?? 0) + 1;
    return true;
  }

  releaseClaim(leaseToken: string): void {
    for (const item of this.items.values()) {
      if (item.leaseToken === leaseToken) {
        item.leaseToken = undefined;
      }
    }
  }

  close(): void {
    this.items.clear();
  }
}
