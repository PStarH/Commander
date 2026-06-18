"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkCoordinator = void 0;
exports.getWorkCoordinator = getWorkCoordinator;
exports.resetWorkCoordinator = resetWorkCoordinator;
const crypto_1 = require("crypto");
const messageBus_1 = require("../runtime/messageBus");
const logging_1 = require("../logging");
const inMemoryWorkQueueStore_1 = require("./inMemoryWorkQueueStore");
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_TOKEN_BUDGET = 50000;
const DEFAULT_PRIORITY = 50;
const MAX_ITEMS_RETENTION = 10000;
const MAX_HANDLERS = 200;
class WorkCoordinator {
    constructor(config = {}) {
        var _a;
        this.items = new Map();
        this.handlers = new Set();
        this.counter = 0;
        this.store = (_a = config.store) !== null && _a !== void 0 ? _a : new inMemoryWorkQueueStore_1.InMemoryWorkQueueStore();
        this.recover();
    }
    recover() {
        try {
            const persisted = this.store.loadAll();
            let reclaimedCount = 0;
            for (const item of persisted) {
                if (item.status === 'RUNNING' || item.status === 'CLAIMED') {
                    item.status = 'PENDING';
                    item.claimedBy = undefined;
                    item.claimedAt = undefined;
                    this.store.update(item);
                    reclaimedCount++;
                }
                this.items.set(item.id, item);
            }
            if (reclaimedCount > 0) {
                (0, logging_1.getGlobalLogger)().info('WorkCoordinator', 'Reclaimed in-flight items from prior process', {
                    reclaimedCount,
                    totalRecovered: persisted.length,
                });
            }
            else if (persisted.length > 0) {
                (0, logging_1.getGlobalLogger)().info('WorkCoordinator', 'Recovered work items from store', {
                    count: persisted.length,
                });
            }
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().error('WorkCoordinator', 'Failed to recover from store', err);
        }
    }
    enqueue(input) {
        var _a, _b, _c, _d;
        const inputs = Array.isArray(input) ? input : [input];
        const out = [];
        const now = new Date().toISOString();
        for (const i of inputs) {
            const id = this.generateId();
            const item = {
                id,
                runId: i.runId,
                parentNodeId: i.parentNodeId,
                goal: i.goal,
                tools: i.tools,
                dependsOn: (_a = i.dependsOn) !== null && _a !== void 0 ? _a : [],
                status: 'PENDING',
                attempts: 0,
                maxAttempts: (_b = i.maxAttempts) !== null && _b !== void 0 ? _b : DEFAULT_MAX_ATTEMPTS,
                tokenBudget: (_c = i.tokenBudget) !== null && _c !== void 0 ? _c : DEFAULT_TOKEN_BUDGET,
                priority: (_d = i.priority) !== null && _d !== void 0 ? _d : DEFAULT_PRIORITY,
                createdAt: now,
            };
            this.items.set(id, item);
            this.store.enqueue(item);
            out.push(item);
            this.emit({ type: 'enqueued', item });
        }
        this.publishBus('team.work.enqueued', {
            items: out.map((i) => ({ id: i.id, runId: i.runId, goal: i.goal.slice(0, 80) })),
        });
        this.enforceRetention();
        return out;
    }
    claim(agentId, filter) {
        var _a;
        if (this.hasCycle(filter === null || filter === void 0 ? void 0 : filter.runId)) {
            (0, logging_1.getGlobalLogger)().warn('WorkCoordinator', 'Dependency cycle detected, refusing claim', {
                agentId,
            });
            return null;
        }
        const candidates = [];
        for (const item of this.items.values()) {
            if (item.status !== 'PENDING')
                continue;
            if ((filter === null || filter === void 0 ? void 0 : filter.runId) && item.runId !== filter.runId)
                continue;
            if ((filter === null || filter === void 0 ? void 0 : filter.tools) && !filter.tools.some((t) => item.tools.includes(t)))
                continue;
            if ((filter === null || filter === void 0 ? void 0 : filter.parentNodeId) && item.parentNodeId !== filter.parentNodeId)
                continue;
            if (!this.dependenciesMet(item))
                continue;
            candidates.push(item);
        }
        if (candidates.length === 0)
            return null;
        candidates.sort((a, b) => {
            if (a.priority !== b.priority)
                return b.priority - a.priority;
            return a.createdAt.localeCompare(b.createdAt);
        });
        for (const item of candidates) {
            const leaseToken = (0, crypto_1.randomUUID)();
            const claimedAt = new Date().toISOString();
            if (!this.store.tryClaim(agentId, item.id, leaseToken, claimedAt)) {
                continue;
            }
            item.status = 'CLAIMED';
            item.claimedBy = agentId;
            item.claimedAt = claimedAt;
            item.attempts++;
            item.leaseToken = leaseToken;
            item.fencingEpoch = ((_a = item.fencingEpoch) !== null && _a !== void 0 ? _a : 0) + 1;
            this.store.update(item);
            this.emit({ type: 'claimed', item, agentId });
            this.publishBus('team.work.claimed', {
                workId: item.id,
                agentId,
                runId: item.runId,
                goal: item.goal.slice(0, 80),
            });
            return item;
        }
        return null;
    }
    start(workId, agentId) {
        const item = this.items.get(workId);
        if (!item || item.status !== 'CLAIMED' || item.claimedBy !== agentId) {
            return false;
        }
        item.status = 'RUNNING';
        this.store.update(item);
        this.emit({ type: 'started', item, agentId });
        this.publishBus('team.work.started', { workId, agentId, runId: item.runId });
        return true;
    }
    complete(workId, agentId, result) {
        const item = this.items.get(workId);
        if (!item ||
            (item.status !== 'CLAIMED' && item.status !== 'RUNNING') ||
            item.claimedBy !== agentId) {
            return false;
        }
        item.status = 'COMPLETED';
        item.completedAt = new Date().toISOString();
        if (item.leaseToken)
            this.store.releaseClaim(item.leaseToken);
        item.leaseToken = undefined;
        this.store.update(item);
        this.emit({ type: 'completed', item, agentId });
        this.publishBus('team.work.completed', {
            workId,
            agentId,
            runId: item.runId,
            attempts: item.attempts,
            hasResult: result !== undefined,
        });
        return true;
    }
    fail(workId, agentId, error) {
        const item = this.items.get(workId);
        if (!item ||
            (item.status !== 'CLAIMED' && item.status !== 'RUNNING') ||
            item.claimedBy !== agentId) {
            return null;
        }
        item.lastError = error;
        item.failedAt = new Date().toISOString();
        if (item.leaseToken)
            this.store.releaseClaim(item.leaseToken);
        item.leaseToken = undefined;
        this.store.update(item);
        this.emit({ type: 'failed', item, agentId, error });
        this.publishBus('team.work.failed', {
            workId,
            agentId,
            runId: item.runId,
            error: error.slice(0, 200),
            attempts: item.attempts,
        });
        if (item.attempts < item.maxAttempts) {
            return this.reassignInternal(item, agentId, `attempt ${item.attempts} failed: ${error.slice(0, 100)}`);
        }
        item.status = 'FAILED';
        this.store.update(item);
        this.emit({ type: 'terminal', item, agentId, error });
        this.publishBus('team.work.terminal', {
            workId: item.id,
            agentId,
            runId: item.runId,
            error: error.slice(0, 200),
            attempts: item.attempts,
        });
        return null;
    }
    reassign(workId, reason) {
        var _a;
        const item = this.items.get(workId);
        if (!item)
            return null;
        if (item.status !== 'CLAIMED' && item.status !== 'RUNNING' && item.status !== 'REASSIGNED') {
            return null;
        }
        const fromAgent = (_a = item.claimedBy) !== null && _a !== void 0 ? _a : 'unknown';
        return this.reassignInternal(item, fromAgent, reason);
    }
    list(filter) {
        const result = [];
        for (const item of this.items.values()) {
            if ((filter === null || filter === void 0 ? void 0 : filter.runId) && item.runId !== filter.runId)
                continue;
            if ((filter === null || filter === void 0 ? void 0 : filter.status) && item.status !== filter.status)
                continue;
            if ((filter === null || filter === void 0 ? void 0 : filter.agentId) && item.claimedBy !== filter.agentId)
                continue;
            result.push(item);
        }
        return result;
    }
    getTeamStatus(runId) {
        var _a, _b;
        const items = this.list({ runId });
        const byAgent = {};
        const pendingByAgent = {};
        let pending = 0, claimed = 0, running = 0, completed = 0, failed = 0, reassigned = 0;
        for (const item of items) {
            const agent = (_a = item.claimedBy) !== null && _a !== void 0 ? _a : 'unassigned';
            if (!byAgent[agent])
                byAgent[agent] = { claimed: 0, running: 0, completed: 0, failed: 0 };
            switch (item.status) {
                case 'PENDING':
                    pending++;
                    pendingByAgent[agent] = ((_b = pendingByAgent[agent]) !== null && _b !== void 0 ? _b : 0) + 1;
                    break;
                case 'CLAIMED':
                    claimed++;
                    byAgent[agent].claimed++;
                    break;
                case 'RUNNING':
                    running++;
                    byAgent[agent].running++;
                    break;
                case 'COMPLETED':
                    completed++;
                    byAgent[agent].completed++;
                    break;
                case 'FAILED':
                    failed++;
                    byAgent[agent].failed++;
                    break;
                case 'REASSIGNED':
                    reassigned++;
                    break;
                default:
                    break;
            }
        }
        return {
            runId,
            total: items.length,
            pending,
            claimed,
            running,
            completed,
            failed,
            reassigned,
            byAgent,
            pendingByAgent,
        };
    }
    subscribe(handler) {
        if (this.handlers.size >= MAX_HANDLERS) {
            (0, logging_1.getGlobalLogger)().warn('WorkCoordinator', 'Handler cap reached, dropping subscription');
            return () => { };
        }
        this.handlers.add(handler);
        return () => {
            this.handlers.delete(handler);
        };
    }
    clear(runId) {
        let removed = 0;
        for (const [id, item] of this.items) {
            if (runId && item.runId !== runId)
                continue;
            this.items.delete(id);
            removed++;
        }
        this.store.remove((item) => (runId ? item.runId === runId : true));
        return removed;
    }
    dependenciesMet(item) {
        if (item.dependsOn.length === 0)
            return true;
        for (const depId of item.dependsOn) {
            const dep = this.items.get(depId);
            if (!dep || dep.status !== 'COMPLETED')
                return false;
        }
        return true;
    }
    hasCycle(runId) {
        const items = runId
            ? Array.from(this.items.values()).filter((i) => i.runId === runId)
            : Array.from(this.items.values());
        const visiting = new Set();
        const visited = new Set();
        const adj = new Map();
        for (const item of items)
            adj.set(item.id, item.dependsOn);
        const dfs = (id) => {
            var _a;
            if (visiting.has(id))
                return true;
            if (visited.has(id))
                return false;
            visiting.add(id);
            for (const dep of (_a = adj.get(id)) !== null && _a !== void 0 ? _a : []) {
                if (dfs(dep))
                    return true;
            }
            visiting.delete(id);
            visited.add(id);
            return false;
        };
        for (const item of items) {
            if (dfs(item.id))
                return true;
        }
        return false;
    }
    reassignInternal(item, fromAgent, reason) {
        item.status = 'PENDING';
        item.claimedBy = undefined;
        item.claimedAt = undefined;
        this.store.update(item);
        this.emit({ type: 'reassigned', item, fromAgent, reason });
        this.publishBus('team.work.reassigned', {
            workId: item.id,
            fromAgent,
            reason: reason.slice(0, 200),
            runId: item.runId,
            attempts: item.attempts,
        });
        return item;
    }
    emit(event) {
        for (const handler of this.handlers) {
            try {
                handler(event);
            }
            catch (err) {
                (0, logging_1.getGlobalLogger)().error('WorkCoordinator', 'Handler error', err);
            }
        }
    }
    publishBus(topic, payload) {
        try {
            const bus = (0, messageBus_1.getMessageBus)();
            bus.publish(topic, 'work-coordinator', payload);
        }
        catch {
            // Bus may be uninitialized in tests
        }
    }
    enforceRetention() {
        if (this.items.size <= MAX_ITEMS_RETENTION)
            return;
        const toRemove = [];
        for (const [id, item] of this.items) {
            if (item.status === 'COMPLETED' || item.status === 'FAILED') {
                toRemove.push(id);
                if (this.items.size - toRemove.length <= MAX_ITEMS_RETENTION)
                    break;
            }
        }
        for (const id of toRemove)
            this.items.delete(id);
    }
    generateId() {
        this.counter++;
        return `wko_${Date.now()}_${this.counter}`;
    }
}
exports.WorkCoordinator = WorkCoordinator;
let singleton = null;
let singletonConfig = null;
function getWorkCoordinator(config) {
    if (config) {
        if (singleton)
            singleton.clear();
        singleton = new WorkCoordinator(config);
        singletonConfig = config;
        return singleton;
    }
    if (!singleton) {
        singleton = new WorkCoordinator(singletonConfig !== null && singletonConfig !== void 0 ? singletonConfig : undefined);
    }
    return singleton;
}
function resetWorkCoordinator() {
    var _a, _b;
    if (singleton) {
        singleton.clear();
        (_b = (_a = singleton.store).close) === null || _b === void 0 ? void 0 : _b.call(_a);
    }
    singleton = null;
    singletonConfig = null;
}
