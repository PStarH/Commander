"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckpointError = exports.CheckpointManager = void 0;
exports.snapshotFor = snapshotFor;
class CheckpointManager {
    constructor(store) {
        this.store = store;
    }
    async saveSnapshot(snapshot) {
        await this.store.writeSnapshot(snapshot);
    }
    async loadSnapshot(runId) {
        return this.store.readSnapshot(runId);
    }
    async appendEvent(event) {
        await this.store.appendEvent(event);
    }
    async loadEvents(runId) {
        return this.store.readEvents(runId);
    }
    async recover(runId) {
        const [snapshot, allEvents] = await Promise.all([
            this.store.readSnapshot(runId),
            this.store.readEvents(runId),
        ]);
        if (!snapshot && allEvents.length === 0) {
            return undefined;
        }
        if (!snapshot) {
            throw new CheckpointError(`Run ${runId} has events but no snapshot — cannot recover`);
        }
        const snapshotTime = new Date(snapshot.updatedAt).getTime();
        const eventsAfterSnapshot = allEvents.filter((e) => new Date(e.timestamp).getTime() > snapshotTime);
        return { snapshot, eventsAfterSnapshot, allEvents };
    }
    async deleteRun(runId) {
        await this.store.deleteRun(runId);
    }
    createSnapshot(params) {
        const now = new Date().toISOString();
        const { previous, childRunIds = [], ...rest } = params;
        if (!previous) {
            return {
                ...rest,
                childRunIds,
                createdAt: now,
                updatedAt: now,
                checkpointVersion: 1,
            };
        }
        return {
            ...previous,
            ...rest,
            childRunIds,
            createdAt: previous.createdAt,
            updatedAt: now,
            checkpointVersion: previous.checkpointVersion + 1,
        };
    }
}
exports.CheckpointManager = CheckpointManager;
class CheckpointError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CheckpointError';
    }
}
exports.CheckpointError = CheckpointError;
function snapshotFor(runId, state, nodeStates) {
    const now = new Date().toISOString();
    return {
        runId,
        state,
        intentHash: '',
        fencingEpoch: 0,
        nodeStates,
        childRunIds: [],
        createdAt: now,
        updatedAt: now,
        checkpointVersion: 1,
    };
}
