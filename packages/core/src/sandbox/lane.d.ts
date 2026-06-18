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
export interface ExecutionLaneConfig {
    /** Unique lane name */
    name: string;
    /** Human-readable description */
    description?: string;
    /** Max concurrent executions in this lane (default: 5) */
    maxConcurrency: number;
    /** Scheduling priority: 0 (highest) - 10 (lowest, default: 5) */
    priority: number;
    /** Restrict lane to specific tenants (empty = any tenant) */
    tenantIds?: string[];
    /** Pin all executions in this lane to a registered backend name */
    backendName?: string;
    /** Arbitrary tags for custom routing rules */
    tags?: Record<string, string>;
}
/** Runtime state of a lane */
export interface ExecutionLane {
    readonly config: ExecutionLaneConfig;
    runningCount: number;
    waitingQueue: Array<() => void>;
    totalEnqueued: number;
    totalCompleted: number;
    totalRejected: number;
}
/** Context passed to lane routing */
export interface LaneContext {
    tenantId?: string;
    agentId: string;
    runId?: string;
    toolName?: string;
    /** Tool call arguments (may include explicit `lane` override) */
    args?: Record<string, unknown>;
    /** Arbitrary tags from the execution context */
    tags?: Record<string, string>;
}
/** Lane statistics for monitoring */
export interface LaneStats {
    name: string;
    maxConcurrency: number;
    running: number;
    waiting: number;
    totalEnqueued: number;
    totalCompleted: number;
    totalRejected: number;
    priority: number;
    backendName?: string;
    tenantIds?: string[];
}
/**
 * Custom lane selector function.
 * Return a lane name to route to, or null to fall through to the next selector.
 */
export type LaneSelector = (ctx: LaneContext, lanes: ExecutionLane[]) => string | null;
export declare class LaneManager {
    private lanes;
    private customSelectors;
    private defaultMaxConcurrency;
    /**
     * @param defaultMaxConcurrency Max concurrent executions in the default lane.
     *   Set high (100+) when lane isolation is only for explicitly registered lanes;
     *   set low (5-10) when the default lane itself should cap global concurrency.
     *   Default: 100 (effectively unlimited for most use cases).
     */
    constructor(defaultMaxConcurrency?: number);
    /**
     * Register or update a lane.
     * If a lane with the same name exists, its config is updated (running state preserved).
     */
    registerLane(config: ExecutionLaneConfig): void;
    /** Remove a lane (cannot remove 'default'). */
    unregisterLane(name: string): boolean;
    /** Get a lane by name. */
    getLane(name: string): ExecutionLane | undefined;
    /** Get all lane names. */
    getLaneNames(): string[];
    /** Get all lanes sorted by priority (highest first). */
    getAllLanes(): ExecutionLane[];
    /**
     * Register a custom lane selector.
     * Custom selectors run before built-in selectors.
     */
    addSelector(selector: LaneSelector): void;
    /**
     * Select a lane for the given context.
     * Resolution order: custom selectors → explicit lane arg → tenant match → default
     */
    selectLane(ctx: LaneContext): ExecutionLane;
    /**
     * Acquire a slot in a lane. Waits if the lane is at max concurrency.
     * Returns the lane name.
     */
    acquireSlot(ctx: LaneContext, timeoutMs?: number): Promise<string>;
    /**
     * Acquire a slot on a specific named lane (bypasses routing).
     */
    acquireNamedSlot(laneName: string, timeoutMs?: number): Promise<boolean>;
    /**
     * Release a slot in a lane.
     */
    releaseSlot(laneName: string): void;
    /**
     * Get statistics for all lanes.
     */
    getStats(): LaneStats[];
    /** Get the backend name pinned to the selected lane, if any. */
    getLaneBackend(ctx: LaneContext): string | undefined;
    /** Reset all lane state (for testing). */
    reset(): void;
}
export declare function getLaneManager(): LaneManager;
export declare function resetLaneManager(): void;
//# sourceMappingURL=lane.d.ts.map