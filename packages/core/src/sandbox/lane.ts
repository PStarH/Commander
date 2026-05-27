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

import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// Default selectors (applied in order)
// ============================================================================

/** Route by explicit `lane` arg in tool call */
function explicitLaneSelector(ctx: LaneContext, _lanes: ExecutionLane[]): string | null {
  if (ctx.args?.lane && typeof ctx.args.lane === 'string') {
    return ctx.args.lane;
  }
  return null;
}

/** Route by tenantId (first lane that lists this tenant) */
function tenantLaneSelector(ctx: LaneContext, lanes: ExecutionLane[]): string | null {
  if (!ctx.tenantId) return null;
  for (const lane of lanes) {
    if (lane.config.tenantIds?.includes(ctx.tenantId)) {
      return lane.config.name;
    }
  }
  return null;
}

/** Route to default lane as final fallback */
function defaultLaneSelector(ctx: LaneContext, lanes: ExecutionLane[]): string | null {
  const defaultLane = lanes.find(l => l.config.name === 'default');
  return defaultLane ? 'default' : null;
}

// ============================================================================
// Built-in selectors (always present, in this order)
// ============================================================================
const BUILTIN_SELECTORS: LaneSelector[] = [
  explicitLaneSelector,
  tenantLaneSelector,
  defaultLaneSelector,
];

// ============================================================================
// LaneManager
// ============================================================================

export class LaneManager {
  private lanes: Map<string, ExecutionLane> = new Map();
  private customSelectors: LaneSelector[] = [];
  private defaultMaxConcurrency: number;

  /**
   * @param defaultMaxConcurrency Max concurrent executions in the default lane.
   *   Set high (100+) when lane isolation is only for explicitly registered lanes;
   *   set low (5-10) when the default lane itself should cap global concurrency.
   *   Default: 100 (effectively unlimited for most use cases).
   */
  constructor(defaultMaxConcurrency: number = 100) {
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
  registerLane(config: ExecutionLaneConfig): void {
    const existing = this.lanes.get(config.name);
    if (existing) {
      // Update config, preserve running state
      existing.config.maxConcurrency = config.maxConcurrency;
      existing.config.priority = config.priority;
      existing.config.tenantIds = config.tenantIds;
      existing.config.backendName = config.backendName;
      existing.config.tags = config.tags;
      existing.config.description = config.description;
      getGlobalLogger().info('LaneManager', `Updated lane "${config.name}" (max=${config.maxConcurrency}, priority=${config.priority})`);
    } else {
      this.lanes.set(config.name, {
        config: { ...config, maxConcurrency: config.maxConcurrency ?? 5, priority: config.priority ?? 5 },
        runningCount: 0,
        waitingQueue: [],
        totalEnqueued: 0,
        totalCompleted: 0,
        totalRejected: 0,
      });
      getGlobalLogger().info('LaneManager', `Registered lane "${config.name}" (max=${config.maxConcurrency}, priority=${config.priority})`);
    }
  }

  /** Remove a lane (cannot remove 'default'). */
  unregisterLane(name: string): boolean {
    if (name === 'default') return false;
    const lane = this.lanes.get(name);
    if (!lane) return false;
    if (lane.runningCount > 0 || lane.waitingQueue.length > 0) {
      getGlobalLogger().warn('LaneManager', `Cannot remove lane "${name}": has ${lane.runningCount} running, ${lane.waitingQueue.length} waiting`);
      return false;
    }
    this.lanes.delete(name);
    getGlobalLogger().info('LaneManager', `Unregistered lane "${name}"`);
    return true;
  }

  /** Get a lane by name. */
  getLane(name: string): ExecutionLane | undefined {
    return this.lanes.get(name);
  }

  /** Get all lane names. */
  getLaneNames(): string[] {
    return Array.from(this.lanes.keys());
  }

  /** Get all lanes sorted by priority (highest first). */
  getAllLanes(): ExecutionLane[] {
    return Array.from(this.lanes.values()).sort((a, b) => a.config.priority - b.config.priority);
  }

  /**
   * Register a custom lane selector.
   * Custom selectors run before built-in selectors.
   */
  addSelector(selector: LaneSelector): void {
    this.customSelectors.push(selector);
  }

  /**
   * Select a lane for the given context.
   * Resolution order: custom selectors → explicit lane arg → tenant match → default
   */
  selectLane(ctx: LaneContext): ExecutionLane {
    const allLanes = this.getAllLanes();

    // 1. Custom selectors
    for (const selector of this.customSelectors) {
      try {
        const name = selector(ctx, allLanes);
        if (name && this.lanes.has(name)) {
          return this.lanes.get(name)!;
        }
      } catch (err) {
        getGlobalLogger().warn('LaneManager', `Custom lane selector failed`, { error: (err as Error)?.message });
      }
    }

    // 2. Built-in selectors
    for (const selector of BUILTIN_SELECTORS) {
      const name = selector(ctx, allLanes);
      if (name && this.lanes.has(name)) {
        return this.lanes.get(name)!;
      }
    }

    // 3. Fallback: default (should always exist)
    return this.lanes.get('default')!;
  }

  /**
   * Acquire a slot in a lane. Waits if the lane is at max concurrency.
   * Returns the lane name.
   */
  async acquireSlot(ctx: LaneContext): Promise<string> {
    const lane = this.selectLane(ctx);
    lane.totalEnqueued++;

    if (lane.runningCount < lane.config.maxConcurrency) {
      lane.runningCount++;
      return lane.config.name;
    }

    // Lane is at capacity — wait
    return new Promise<string>((resolve) => {
      lane.waitingQueue.push(() => {
        lane.runningCount++;
        resolve(lane.config.name);
      });
    });
  }

  /**
   * Acquire a slot on a specific named lane (bypasses routing).
   */
  async acquireNamedSlot(laneName: string): Promise<boolean> {
    const lane = this.lanes.get(laneName);
    if (!lane) return false;

    lane.totalEnqueued++;
    if (lane.runningCount < lane.config.maxConcurrency) {
      lane.runningCount++;
      return true;
    }

    return new Promise<boolean>((resolve) => {
      lane.waitingQueue.push(() => {
        lane.runningCount++;
        resolve(true);
      });
    });
  }

  /**
   * Release a slot in a lane.
   */
  releaseSlot(laneName: string): void {
    const lane = this.lanes.get(laneName);
    if (!lane) {
      getGlobalLogger().warn('LaneManager', `releaseSlot: unknown lane "${laneName}"`);
      return;
    }

    lane.runningCount--;
    lane.totalCompleted++;

    const next = lane.waitingQueue.shift();
    if (next) {
      // Schedule next waiter on next tick to avoid deep stacks
      setImmediate(next);
    }
  }

  /**
   * Get statistics for all lanes.
   */
  getStats(): LaneStats[] {
    return this.getAllLanes().map(lane => ({
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
  getLaneBackend(ctx: LaneContext): string | undefined {
    const lane = this.selectLane(ctx);
    return lane.config.backendName;
  }

  /** Reset all lane state (for testing). */
  reset(): void {
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

// ============================================================================
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const laneManagerSingleton = createTenantAwareSingleton(() => new LaneManager());

export function getLaneManager(): LaneManager {
  return laneManagerSingleton.get();
}

export function resetLaneManager(): void {
  laneManagerSingleton.reset();
}
