"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryWorkQueueStore = void 0;
class InMemoryWorkQueueStore {
    constructor() {
        this.items = new Map();
    }
    loadAll() {
        return Array.from(this.items.values()).map((i) => ({ ...i }));
    }
    enqueue(item) {
        this.items.set(item.id, { ...item });
    }
    update(item) {
        this.items.set(item.id, { ...item });
    }
    updateMany(items) {
        for (const i of items)
            this.items.set(i.id, { ...i });
    }
    remove(predicate) {
        let removed = 0;
        for (const [id, item] of this.items) {
            if (predicate(item)) {
                this.items.delete(id);
                removed++;
            }
        }
        return removed;
    }
    tryClaim(agentId, workId, leaseToken, nowIso) {
        var _a;
        const item = this.items.get(workId);
        if (!item || item.status !== 'PENDING')
            return false;
        item.status = 'CLAIMED';
        item.claimedBy = agentId;
        item.claimedAt = nowIso;
        item.leaseToken = leaseToken;
        item.fencingEpoch = ((_a = item.fencingEpoch) !== null && _a !== void 0 ? _a : 0) + 1;
        return true;
    }
    releaseClaim(leaseToken) {
        for (const item of this.items.values()) {
            if (item.leaseToken === leaseToken) {
                item.leaseToken = undefined;
            }
        }
    }
    close() {
        this.items.clear();
    }
}
exports.InMemoryWorkQueueStore = InMemoryWorkQueueStore;
