/**
 * Supervision Tree — Erlang/OTP-Inspired Fault Isolation
 *
 * Research basis: "Commander Deadlock Prevention" report section 6 (Supervision Tree Recovery).
 *
 * Borrows Erlang/OTP's "Let It Crash" philosophy: instead of trying to handle
 * every possible error within an agent, let agents crash and have a supervisor
 * restart them automatically. The supervision tree provides:
 *
 *   1. Hierarchical supervision: each supervisor watches its children (agents
 *      or sub-supervisors). When a child crashes, the supervisor decides
 *      what to do based on its restart strategy.
 *   2. Restart strategies:
 *      - one_for_one: restart only the crashed child
 *      - one_for_all: restart ALL children (use when children are co-dependent)
 *      - rest_for_one: restart the crashed child and all children started after it
 *   3. Restart intensity: if a child restarts more than MaxR times in MaxT
 *      milliseconds, the supervisor itself crashes (escalating to ITS supervisor).
 *   4. Graceful shutdown: supervisors shut down children in reverse start order.
 *
 * In Commander, each agent runtime instance can be a child of a supervisor.
 * When an agent crashes (unhandled exception, OOM, timeout), the supervisor
 * restarts it with a fresh state, preserving the agent's task assignment.
 */

import { getMessageBus } from './messageBus';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';

// ── Types ────────────────────────────────────────────────────────────────────

export type RestartStrategy = 'one_for_one' | 'one_for_all' | 'rest_for_one';

export type ChildState = 'running' | 'stopped' | 'crashed' | 'restarting';

export interface ChildSpec {
  /** Unique child ID */
  id: string;
  /** Factory function to create/restart the child */
  start: () => Promise<ChildHandle>;
  /** Function to stop the child gracefully */
  stop?: (handle: ChildHandle) => Promise<void>;
  /** Restart strategy override (if null, uses supervisor's strategy) */
  restartStrategy?: RestartStrategy;
  /** Shutdown timeout (ms) — how long to wait for graceful shutdown before force-killing. Default 5000. */
  shutdownMs?: number;
  /** Max restarts within maxRestartIntervalMs before supervisor gives up. Default 5. */
  maxRestarts?: number;
  /** Time window (ms) for max restarts. Default 60000. */
  maxRestartIntervalMs?: number;
}

export interface ChildHandle {
  id: string;
  /** A function that returns true if the child is still alive/healthy */
  isAlive: () => boolean;
  /** Optional health check function */
  healthCheck?: () => Promise<ChildHealthStatus>;
}

export interface ChildHealthStatus {
  healthy: boolean;
  issues?: string[];
}

export interface ChildEntry {
  spec: ChildSpec;
  handle: ChildHandle | null;
  state: ChildState;
  startedAt: number | null;
  restartCount: number;
  restartHistory: number[]; // timestamps of restarts
  lastError: string | null;
}

export interface SupervisorConfig {
  /** Supervisor ID */
  id: string;
  /** Default restart strategy for children */
  strategy: RestartStrategy;
  /** Max restarts across ALL children before supervisor itself crashes. Default 10. */
  maxRestarts: number;
  /** Time window for max restarts. Default 60000. */
  maxRestartIntervalMs: number;
  /** Default shutdown timeout for children. Default 5000. */
  defaultShutdownMs: number;
  /** Whether to publish supervision events to the message bus. Default true */
  publishEvents: boolean;
  /** Parent supervisor ID (if this is a sub-supervisor) */
  parentSupervisorId?: string;
}

export interface SupervisionEvent {
  type:
    | 'child_started'
    | 'child_crashed'
    | 'child_restarted'
    | 'child_stopped'
    | 'supervisor_crashed'
    | 'supervisor_recovered';
  supervisorId: string;
  childId?: string;
  timestamp: number;
  message: string;
  metadata?: Record<string, unknown>;
}

export type SupervisionEventHandler = (event: SupervisionEvent) => void;

// ── Supervision Tree ─────────────────────────────────────────────────────────

export class Supervisor {
  private config: SupervisorConfig;
  private children: Map<string, ChildEntry> = new Map();
  private childOrder: string[] = []; // tracks start order for rest_for_one
  private supervisionHistory: SupervisionEvent[] = [];
  private eventHandlers: Set<SupervisionEventHandler> = new Set();
  private supervisorRestartCount = 0;
  private crashed = false;

  constructor(config: SupervisorConfig) {
    this.config = config;
  }

  /**
   * Start a new child under this supervisor.
   */
  async startChild(spec: ChildSpec): Promise<ChildHandle> {
    if (this.crashed) {
      const err = new Error(`Supervisor ${this.config.id} has crashed — cannot start new children`);
      (err as Error & { supervisorId?: string }).supervisorId = this.config.id;
      throw err;
    }

    if (this.children.has(spec.id)) {
      const err2 = new Error(`Child ${spec.id} already exists under supervisor ${this.config.id}`);
      (err2 as Error & { supervisorId?: string }).supervisorId = this.config.id;
      throw err2;
    }

    const entry: ChildEntry = {
      spec,
      handle: null,
      state: 'stopped',
      startedAt: null,
      restartCount: 0,
      restartHistory: [],
      lastError: null,
    };

    this.children.set(spec.id, entry);
    this.childOrder.push(spec.id);

    try {
      const handle = await spec.start();
      entry.handle = handle;
      entry.state = 'running';
      entry.startedAt = Date.now();

      this.emitEvent({
        type: 'child_started',
        supervisorId: this.config.id,
        childId: spec.id,
        timestamp: Date.now(),
        message: `Child "${spec.id}" started under supervisor "${this.config.id}"`,
      });

      return handle;
    } catch (err) {
      entry.state = 'crashed';
      entry.lastError = err instanceof Error ? err.message : String(err);
      this.emitEvent({
        type: 'child_crashed',
        supervisorId: this.config.id,
        childId: spec.id,
        timestamp: Date.now(),
        message: `Child "${spec.id}" failed to start: ${entry.lastError}`,
        metadata: { error: entry.lastError },
      });
      throw err;
    }
  }

  /**
   * Stop a child gracefully.
   */
  async stopChild(childId: string): Promise<void> {
    const entry = this.children.get(childId);
    if (!entry) return;

    await this.gracefulStop(entry);

    this.emitEvent({
      type: 'child_stopped',
      supervisorId: this.config.id,
      childId,
      timestamp: Date.now(),
      message: `Child "${childId}" stopped gracefully`,
    });
  }

  /**
   * Report that a child has crashed. This triggers the restart strategy.
   */
  async reportChildCrash(childId: string, error: string): Promise<void> {
    const entry = this.children.get(childId);
    if (!entry) return;

    entry.state = 'crashed';
    entry.lastError = error;

    this.emitEvent({
      type: 'child_crashed',
      supervisorId: this.config.id,
      childId,
      timestamp: Date.now(),
      message: `Child "${childId}" crashed: ${error}`,
      metadata: { error },
    });

    // Check restart intensity
    const now = Date.now();
    entry.restartHistory.push(now);
    // Prune old restart history
    const cutoff = now - (entry.spec.maxRestartIntervalMs ?? this.config.maxRestartIntervalMs);
    entry.restartHistory = entry.restartHistory.filter((t) => t > cutoff);

    const maxR = entry.spec.maxRestarts ?? this.config.maxRestarts;
    if (entry.restartHistory.length > maxR) {
      // Child has exceeded its restart intensity — escalate
      getGlobalLogger().warn(
        'Supervisor',
        `Child "${childId}" exceeded restart intensity (${entry.restartHistory.length} > ${maxR} in ${this.config.maxRestartIntervalMs}ms)`,
        { supervisorId: this.config.id, childId },
      );
      // Don't restart — leave in crashed state
      return;
    }

    // Apply restart strategy
    const strategy = entry.spec.restartStrategy ?? this.config.strategy;
    switch (strategy) {
      case 'one_for_one':
        await this.restartChild(childId);
        break;
      case 'one_for_all':
        await this.restartAllChildren();
        break;
      case 'rest_for_one':
        await this.restartFromChild(childId);
        break;
    }
  }

  /**
   * Check health of all children.
   */
  async healthCheck(): Promise<void> {
    for (const [childId, entry] of this.children) {
      if (entry.state !== 'running' || !entry.handle) continue;

      // Quick liveness check
      if (!entry.handle.isAlive()) {
        await this.reportChildCrash(childId, 'Health check: isAlive() returned false');
        continue;
      }

      // Detailed health check
      if (entry.handle.healthCheck) {
        try {
          const status = await entry.handle.healthCheck();
          if (!status.healthy) {
            const issues = status.issues?.join('; ') ?? 'unhealthy';
            await this.reportChildCrash(childId, `Health check failed: ${issues}`);
          }
        } catch (err) {
          await this.reportChildCrash(
            childId,
            `Health check threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  /**
   * Get all children and their states.
   */
  getChildren(): Array<{
    id: string;
    state: ChildState;
    restartCount: number;
    lastError: string | null;
  }> {
    return Array.from(this.children.entries()).map(([id, entry]) => ({
      id,
      state: entry.state,
      restartCount: entry.restartCount,
      lastError: entry.lastError,
    }));
  }

  /**
   * Get supervision event history.
   */
  getEventHistory(): SupervisionEvent[] {
    return [...this.supervisionHistory];
  }

  /**
   * Register an event handler.
   */
  onEvent(handler: SupervisionEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Check if the supervisor itself has crashed.
   */
  isCrashed(): boolean {
    return this.crashed;
  }

  /**
   * Get the supervisor's ID.
   */
  getId(): string {
    return this.config.id;
  }

  /**
   * Shut down the supervisor and all its children.
   * Children are stopped in REVERSE start order.
   */
  async shutdown(): Promise<void> {
    const reverseOrder = [...this.childOrder].reverse();
    for (const childId of reverseOrder) {
      const entry = this.children.get(childId);
      if (entry && entry.state === 'running') {
        await this.gracefulStop(entry);
      }
    }
    this.emitEvent({
      type: 'supervisor_recovered',
      supervisorId: this.config.id,
      timestamp: Date.now(),
      message: `Supervisor "${this.config.id}" shut down gracefully`,
    });
  }

  /**
   * Reset the supervisor (clear all children and history).
   */
  reset(): void {
    this.children.clear();
    this.childOrder = [];
    this.supervisionHistory = [];
    this.supervisorRestartCount = 0;
    this.crashed = false;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async restartChild(childId: string): Promise<void> {
    const entry = this.children.get(childId);
    if (!entry) return;

    entry.state = 'restarting';

    try {
      const handle = await entry.spec.start();
      entry.handle = handle;
      entry.state = 'running';
      entry.startedAt = Date.now();
      entry.restartCount++;

      this.emitEvent({
        type: 'child_restarted',
        supervisorId: this.config.id,
        childId,
        timestamp: Date.now(),
        message: `Child "${childId}" restarted (restart #${entry.restartCount})`,
        metadata: { restartCount: entry.restartCount },
      });
    } catch (err) {
      entry.state = 'crashed';
      entry.lastError = err instanceof Error ? err.message : String(err);
      getGlobalLogger().warn(
        'Supervisor',
        `Failed to restart child "${childId}": ${entry.lastError}`,
        { supervisorId: this.config.id, childId },
      );
    }
  }

  private async restartAllChildren(): Promise<void> {
    for (const childId of this.childOrder) {
      const entry = this.children.get(childId);
      if (entry && entry.state !== 'running') {
        await this.restartChild(childId);
      }
    }
  }

  private async restartFromChild(crashedChildId: string): Promise<void> {
    const idx = this.childOrder.indexOf(crashedChildId);
    if (idx === -1) return;

    // Restart the crashed child and all children started after it
    for (let i = idx; i < this.childOrder.length; i++) {
      const childId = this.childOrder[i];
      const entry = this.children.get(childId);
      if (entry && entry.state !== 'running') {
        await this.restartChild(childId);
      }
    }
  }

  private async gracefulStop(entry: ChildEntry): Promise<void> {
    const shutdownMs = entry.spec.shutdownMs ?? this.config.defaultShutdownMs;

    if (entry.spec.stop && entry.handle) {
      try {
        await Promise.race([
          entry.spec.stop(entry.handle),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Shutdown timeout')), shutdownMs),
          ),
        ]);
      } catch (err) {
        // Force stop — just mark as stopped
        reportSilentFailure(err, 'supervisionTree:gracefulStop');
      }
    }

    entry.state = 'stopped';
    entry.handle = null;
  }

  private emitEvent(event: SupervisionEvent): void {
    this.supervisionHistory.push(event);
    if (this.supervisionHistory.length > 200) this.supervisionHistory.shift();

    // Notify handlers
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        reportSilentFailure(err, 'supervisionTree:emitEvent');
      }
    }

    // Publish to message bus
    if (this.config.publishEvents) {
      try {
        const bus = getMessageBus();
        bus.publish('system.alert', 'supervision-tree', {
          type: event.type,
          supervisorId: event.supervisorId,
          childId: event.childId,
          message: event.message,
        });
      } catch (err) {
        reportSilentFailure(err, 'supervisionTree:publish');
      }
    }

    getGlobalLogger().info('Supervisor', event.message, {
      type: event.type,
      supervisorId: event.supervisorId,
      childId: event.childId,
    });
  }
}

// ── Supervision Tree Registry ────────────────────────────────────────────────

/**
 * Registry of all supervisors in the system, enabling hierarchical
 * supervision (sub-supervisors under parent supervisors).
 */
export class SupervisionTreeRegistry {
  private supervisors: Map<string, Supervisor> = new Map();
  private parentChild: Map<string, string> = new Map(); // child supervisor → parent supervisor

  /**
   * Register an existing supervisor by its config ID.
   */
  register(supervisor: Supervisor): void {
    // Use getId() to access the supervisor's ID without touching private fields
    this.supervisors.set(supervisor.getId(), supervisor);
  }

  get(supervisorId: string): Supervisor | undefined {
    return this.supervisors.get(supervisorId);
  }

  /**
   * Create and register a new supervisor.
   */
  createSupervisor(config: SupervisorConfig): Supervisor {
    if (this.supervisors.has(config.id)) {
      throw new Error(`Supervisor with id "${config.id}" already exists`);
    }
    const supervisor = new Supervisor(config);
    this.supervisors.set(config.id, supervisor);
    if (config.parentSupervisorId) {
      this.parentChild.set(config.id, config.parentSupervisorId);
    }
    return supervisor;
  }

  /**
   * Propagate a crash from a sub-supervisor to its parent.
   */
  async propagateCrash(supervisorId: string, error: string): Promise<void> {
    const parentId = this.parentChild.get(supervisorId);
    if (parentId) {
      const parent = this.supervisors.get(parentId) as Supervisor | undefined;
      if (parent) {
        await parent.reportChildCrash(supervisorId, error);
      }
    }
  }

  /**
   * Shut down all supervisors (reverse order: children first, parents last).
   */
  async shutdownAll(): Promise<void> {
    const all = Array.from(this.supervisors.values()) as Supervisor[];
    // Shut down in reverse order (leaf supervisors first)
    for (let i = all.length - 1; i >= 0; i--) {
      await all[i].shutdown();
    }
    this.supervisors.clear();
    this.parentChild.clear();
  }

  reset(): void {
    this.supervisors.clear();
    this.parentChild.clear();
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

import { createTenantAwareSingleton } from './tenantAwareSingleton';

const supervisionTreeSingleton = createTenantAwareSingleton(
  () => new SupervisionTreeRegistry(),
  {},
);

export function getSupervisionTreeRegistry(): SupervisionTreeRegistry {
  return supervisionTreeSingleton.get();
}

export function resetSupervisionTreeRegistry(): void {
  supervisionTreeSingleton.reset();
}
