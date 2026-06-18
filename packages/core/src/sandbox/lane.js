"use strict";
/**
 * Execution Lanes — concurrent execution isolation for multi-tenant safety.
 *
 * A lane is an isolated execution context with its own concurrency budget.
 * Lanes prevent one tenant, task type, or priority class from starving others.
 *
 * ┌─────────────────────────────────────────────────────┐
 * │  LaneManager                                         │
 * │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
 * │  │ default  │  │ tenant-1 │  │ high-priority    │  │
 * │  │ max: 5   │  │ max: 2   │  │ max: 3, pinned   │  │
 * │  │ running:2│  │ running:0│  │ → backend:"prod" │  │
 * │  └──────────┘  └──────────┘  └──────────────────┘  │
 * └─────────────────────────────────────────────────────┘
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LaneManager = void 0;
exports.getLaneManager = getLaneManager;
exports.resetLaneManager = resetLaneManager;
const logging_1 = require("../logging");
// ============================================================================
// Default selectors (applied in order)
// ============================================================================
/** Route by explicit `lane` arg in tool call */
function explicitLaneSelector(ctx, _lanes) {
    var _a;
    if (((_a = ctx.args) === null || _a === void 0 ? void 0 : _a.lane) && typeof ctx.args.lane === 'string') {
        return ctx.args.lane;
    }
    return null;
}
/** Route by tenantId (first lane that lists this tenant) */
function tenantLaneSelector(ctx, lanes) {
    var _a;
    if (!ctx.tenantId)
        return null;
    for (const lane of lanes) {
        if ((_a = lane.config.tenantIds) === null || _a === void 0 ? void 0 : _a.includes(ctx.tenantId)) {
            return lane.config.name;
        }
    }
    return null;
}
/** Route to default lane as final fallback */
function defaultLaneSelector(ctx, lanes) {
    const defaultLane = lanes.find((l) => l.config.name === 'default');
    return defaultLane ? 'default' : null;
}
// ============================================================================
// Built-in selectors (always present, in this order)
// ============================================================================
const BUILTIN_SELECTORS = [
    explicitLaneSelector,
    tenantLaneSelector,
    defaultLaneSelector,
];
// ============================================================================
// LaneManager
// ============================================================================
class LaneManager {
    /**
     * @param defaultMaxConcurrency Max concurrent executions in the default lane.
     *   Set high (100+) when lane isolation is only for explicitly registered lanes;
     *   set low (5-10) when the default lane itself should cap global concurrency.
     *   Default: 100 (effectively unlimited for most use cases).
     */
    constructor(defaultMaxConcurrency = 100) {
        this.lanes = new Map();
        this.customSelectors = [];
        this.defaultMaxConcurrency = defaultMaxConcurrency;
        this.registerLane({
            name: 'default',
            description: 'Default lane for all executions not matched by other lanes',
            maxConcurrency: this.defaultMaxConcurrency,
            priority: 5,
        });
    }
    /**
     * Register or update a lane.
     * If a lane with the same name exists, its config is updated (running state preserved).
     */
    registerLane(config) {
        var _a, _b;
        const existing = this.lanes.get(config.name);
        if (existing) {
            // Update config, preserve running state
            existing.config.maxConcurrency = config.maxConcurrency;
            existing.config.priority = config.priority;
            existing.config.tenantIds = config.tenantIds;
            existing.config.backendName = config.backendName;
            existing.config.tags = config.tags;
            existing.config.description = config.description;
            (0, logging_1.getGlobalLogger)().info('LaneManager', `Updated lane "${config.name}" (max=${config.maxConcurrency}, priority=${config.priority})`);
        }
        else {
            this.lanes.set(config.name, {
                config: {
                    ...config,
                    maxConcurrency: (_a = config.maxConcurrency) !== null && _a !== void 0 ? _a : 5,
                    priority: (_b = config.priority) !== null && _b !== void 0 ? _b : 5,
                },
                runningCount: 0,
                waitingQueue: [],
                totalEnqueued: 0,
                totalCompleted: 0,
                totalRejected: 0,
            });
            (0, logging_1.getGlobalLogger)().info('LaneManager', `Registered lane "${config.name}" (max=${config.maxConcurrency}, priority=${config.priority})`);
        }
    }
    /** Remove a lane (cannot remove 'default'). */
    unregisterLane(name) {
        if (name === 'default')
            return false;
        const lane = this.lanes.get(name);
        if (!lane)
            return false;
        if (lane.runningCount > 0 || lane.waitingQueue.length > 0) {
            (0, logging_1.getGlobalLogger)().warn('LaneManager', `Cannot remove lane "${name}": has ${lane.runningCount} running, ${lane.waitingQueue.length} waiting`);
            return false;
        }
        this.lanes.delete(name);
        (0, logging_1.getGlobalLogger)().info('LaneManager', `Unregistered lane "${name}"`);
        return true;
    }
    /** Get a lane by name. */
    getLane(name) {
        return this.lanes.get(name);
    }
    /** Get all lane names. */
    getLaneNames() {
        return Array.from(this.lanes.keys());
    }
    /** Get all lanes sorted by priority (highest first). */
    getAllLanes() {
        return Array.from(this.lanes.values()).sort((a, b) => a.config.priority - b.config.priority);
    }
    /**
     * Register a custom lane selector.
     * Custom selectors run before built-in selectors.
     */
    addSelector(selector) {
        this.customSelectors.push(selector);
    }
    /**
     * Select a lane for the given context.
     * Resolution order: custom selectors → explicit lane arg → tenant match → default
     */
    selectLane(ctx) {
        const allLanes = this.getAllLanes();
        // 1. Custom selectors
        for (const selector of this.customSelectors) {
            try {
                const name = selector(ctx, allLanes);
                if (name && this.lanes.has(name)) {
                    return this.lanes.get(name);
                }
            }
            catch (err) {
                (0, logging_1.getGlobalLogger)().warn('LaneManager', `Custom lane selector failed`, {
                    error: err === null || err === void 0 ? void 0 : err.message,
                });
            }
        }
        // 2. Built-in selectors
        for (const selector of BUILTIN_SELECTORS) {
            const name = selector(ctx, allLanes);
            if (name && this.lanes.has(name)) {
                return this.lanes.get(name);
            }
        }
        // 3. Fallback: default (should always exist)
        return this.lanes.get('default');
    }
    /**
     * Acquire a slot in a lane. Waits if the lane is at max concurrency.
     * Returns the lane name.
     */
    async acquireSlot(ctx, timeoutMs) {
        const lane = this.selectLane(ctx);
        lane.totalEnqueued++;
        if (lane.runningCount < lane.config.maxConcurrency) {
            lane.runningCount++;
            return lane.config.name;
        }
        // Lane is at capacity — wait for a slot to be transferred
        return new Promise((resolve, reject) => {
            let timer = null;
            const enqueue = () => {
                if (timer)
                    clearTimeout(timer);
                resolve(lane.config.name);
            };
            if (timeoutMs) {
                timer = setTimeout(() => {
                    lane.totalRejected++;
                    lane.waitingQueue = lane.waitingQueue.filter((w) => w !== enqueue);
                    reject(new Error(`Lane "${lane.config.name}" slot timeout after ${timeoutMs}ms`));
                }, timeoutMs);
                timer.unref();
            }
            lane.waitingQueue.push(enqueue);
        });
    }
    /**
     * Acquire a slot on a specific named lane (bypasses routing).
     */
    async acquireNamedSlot(laneName, timeoutMs) {
        const lane = this.lanes.get(laneName);
        if (!lane)
            return false;
        lane.totalEnqueued++;
        if (lane.runningCount < lane.config.maxConcurrency) {
            lane.runningCount++;
            return true;
        }
        return new Promise((resolve, reject) => {
            let timer = null;
            const enqueue = () => {
                if (timer)
                    clearTimeout(timer);
                resolve(true);
            };
            if (timeoutMs) {
                timer = setTimeout(() => {
                    lane.totalRejected++;
                    lane.waitingQueue = lane.waitingQueue.filter((w) => w !== enqueue);
                    reject(new Error(`Lane "${laneName}" slot timeout after ${timeoutMs}ms`));
                }, timeoutMs);
                timer.unref();
            }
            lane.waitingQueue.push(enqueue);
        });
    }
    /**
     * Release a slot in a lane.
     */
    releaseSlot(laneName) {
        const lane = this.lanes.get(laneName);
        if (!lane) {
            (0, logging_1.getGlobalLogger)().warn('LaneManager', `releaseSlot: unknown lane "${laneName}"`);
            return;
        }
        lane.totalCompleted++;
        const next = lane.waitingQueue.shift();
        if (next) {
            // Keep runningCount — transfer the slot directly to the waiter.
            // Schedule waiter resolve on next tick to avoid deep stacks.
            setImmediate(next);
        }
        else {
            lane.runningCount--;
        }
    }
    /**
     * Get statistics for all lanes.
     */
    getStats() {
        return this.getAllLanes().map((lane) => ({
            name: lane.config.name,
            maxConcurrency: lane.config.maxConcurrency,
            running: lane.runningCount,
            waiting: lane.waitingQueue.length,
            totalEnqueued: lane.totalEnqueued,
            totalCompleted: lane.totalCompleted,
            totalRejected: lane.totalRejected,
            priority: lane.config.priority,
            backendName: lane.config.backendName,
            tenantIds: lane.config.tenantIds,
        }));
    }
    /** Get the backend name pinned to the selected lane, if any. */
    getLaneBackend(ctx) {
        const lane = this.selectLane(ctx);
        return lane.config.backendName;
    }
    /** Reset all lane state (for testing). */
    reset() {
        this.lanes.clear();
        this.customSelectors = [];
        this.registerLane({
            name: 'default',
            description: 'Default lane',
            maxConcurrency: this.defaultMaxConcurrency,
            priority: 5,
        });
    }
}
exports.LaneManager = LaneManager;
// ============================================================================
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const laneManagerSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new LaneManager());
function getLaneManager() {
    return laneManagerSingleton.get();
}
function resetLaneManager() {
    laneManagerSingleton.reset();
}
