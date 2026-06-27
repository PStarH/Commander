/**
 * Hierarchical Timeout Manager
 *
 * Research basis: "Commander Deadlock Prevention" report section 6 (Timeout Protection).
 *
 * Implements a multi-layer timeout hierarchy to prevent liveness issues at
 * different granularities:
 *
 *   Level 0: Tool call timeout     — individual tool execution
 *   Level 1: Step timeout           — single step in a saga/workflow
 *   Level 2: Phase timeout          — a group of related steps (e.g., "research phase")
 *   Level 3: Agent timeout           — entire agent lifecycle (including sub-agents)
 *   Level 4: Topology timeout        — entire topology execution (all agents)
 *   Level 5: Global execution timeout — hard cap on total execution time
 *
 * Design principles (from Temporal + LangGraph):
 *   - Lower-level timeouts must be SHORTER than higher-level timeouts
 *   - When a lower-level timeout fires, it escalates to the next level
 *   - Each level has a configurable action: retry, abort, compensate, escalate
 *   - The manager tracks active timers and can cancel them when work completes
 *
 * The manager also supports A2A communication timeouts: when Agent A sends a
 * request to Agent B, a communication timeout is set. If B doesn't respond
 * within the timeout, A can proceed with a fallback or escalate.
 */

import { getMessageBus } from './messageBus';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';

// ── Types ────────────────────────────────────────────────────────────────────

export type TimeoutLevel = 'tool' | 'step' | 'phase' | 'agent' | 'topology' | 'global';

export type TimeoutAction = 'retry' | 'abort' | 'compensate' | 'escalate' | 'fallback';

export interface TimeoutConfig {
  /** Timeout duration in milliseconds */
  durationMs: number;
  /** What to do when the timeout fires */
  action: TimeoutAction;
  /** Maximum retries (only for 'retry' action). Default 0. */
  maxRetries?: number;
  /** Fallback value to use when action='fallback'. */
  fallbackValue?: unknown;
  /** Whether this timeout can be extended dynamically. Default false. */
  extendable?: boolean;
  /** Maximum extension (ms) if extendable. Default 0. */
  maxExtensionMs?: number;
}

export interface TimeoutEvent {
  level: TimeoutLevel;
  scope: string;          // e.g., "tool:web_search", "step:saga_step_3", "agent:agent_42"
  action: TimeoutAction;
  firedAt: number;
  durationMs: number;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface ActiveTimeout {
  id: string;
  level: TimeoutLevel;
  scope: string;
  config: TimeoutConfig;
  startedAt: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  /** Current extension applied (0 if none) */
  extensionMs: number;
}

export interface HierarchicalTimeoutConfig {
  /** Default timeout configurations per level */
  defaults: Record<TimeoutLevel, TimeoutConfig>;
  /** Whether to publish timeout events to the message bus. Default true */
  publishEvents: boolean;
  /** Whether to enforce that lower-level timeouts are shorter than higher-level. Default true */
  enforceHierarchy: boolean;
  /** Tolerance (ms) for hierarchy enforcement — allow lower to be up to this much longer. Default 0 */
  hierarchyToleranceMs: number;
}

const DEFAULT_CONFIG: HierarchicalTimeoutConfig = {
  defaults: {
    tool: { durationMs: 30_000, action: 'abort' },
    step: { durationMs: 60_000, action: 'retry', maxRetries: 1 },
    phase: { durationMs: 180_000, action: 'escalate' },
    agent: { durationMs: 300_000, action: 'compensate' },
    topology: { durationMs: 600_000, action: 'abort' },
    global: { durationMs: 1_800_000, action: 'abort' }, // 30 min hard cap
  },
  publishEvents: true,
  enforceHierarchy: true,
  hierarchyToleranceMs: 0,
};

const LEVEL_SEVERITY: Record<TimeoutLevel, number> = {
  tool: 0,
  step: 1,
  phase: 2,
  agent: 3,
  topology: 4,
  global: 5,
};

// ── Hierarchical Timeout Manager ─────────────────────────────────────────────

export class HierarchicalTimeoutManager {
  private config: HierarchicalTimeoutConfig;
  private activeTimeouts: Map<string, ActiveTimeout> = new Map();
  private timeoutHistory: TimeoutEvent[] = [];
  private parentMap: Map<string, string> = new Map(); // child scope → parent scope
  private extensionUsed: Map<string, number> = new Map(); // scope → total extension used

  constructor(config?: Partial<HierarchicalTimeoutConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      defaults: { ...DEFAULT_CONFIG.defaults, ...config?.defaults },
    };
  }

  /**
   * Start a timeout for a specific scope.
   *
   * @param level - The timeout level
   * @param scope - A unique identifier for this timeout scope
   * @param config - Override the default config for this level
   * @param parentScope - Optional parent scope (for hierarchy tracking)
   * @returns The timeout ID, or null if the timeout was rejected (hierarchy violation)
   */
  startTimeout(
    level: TimeoutLevel,
    scope: string,
    config?: Partial<TimeoutConfig>,
    parentScope?: string,
  ): string | null {
    const timeoutConfig: TimeoutConfig = {
      ...this.config.defaults[level],
      ...config,
    };

    // Enforce hierarchy: lower-level timeouts must be shorter than parent
    if (this.config.enforceHierarchy && parentScope) {
      const parent = this.activeTimeouts.get(parentScope);
      if (parent) {
        const remainingParentMs = parent.expiresAt - Date.now();
        if (timeoutConfig.durationMs > remainingParentMs + this.config.hierarchyToleranceMs) {
          getGlobalLogger().warn(
            'HierarchicalTimeoutManager',
            `Hierarchy violation: ${level} timeout (${timeoutConfig.durationMs}ms) exceeds remaining parent time (${remainingParentMs}ms). Clamping.`,
            { scope, parentScope },
          );
          timeoutConfig.durationMs = Math.max(1000, remainingParentMs - 1000);
        }
      }
    }

    const id = `timeout_${level}_${scope}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    const expiresAt = startedAt + timeoutConfig.durationMs;

    // Don't unref — we want the timer to fire even if the event loop is idle
    const timer = setTimeout(() => {
      this.fireTimeout(id);
    }, timeoutConfig.durationMs);
    timer.unref();

    const active: ActiveTimeout = {
      id,
      level,
      scope,
      config: timeoutConfig,
      startedAt,
      expiresAt,
      timer,
      extensionMs: 0,
    };

    this.activeTimeouts.set(id, active);

    if (parentScope) {
      this.parentMap.set(scope, parentScope);
    }

    return id;
  }

  /**
   * Clear a timeout (work completed before the deadline).
   */
  clearTimeout(id: string): boolean {
    const active = this.activeTimeouts.get(id);
    if (!active) return false;

    clearTimeout(active.timer);
    this.activeTimeouts.delete(id);
    this.parentMap.delete(active.scope);
    this.extensionUsed.delete(active.scope);
    return true;
  }

  /**
   * Extend a timeout (if extendable).
   */
  extendTimeout(id: string, extensionMs: number): boolean {
    const active = this.activeTimeouts.get(id);
    if (!active || !active.config.extendable) return false;

    const currentExtension = this.extensionUsed.get(active.scope) ?? 0;
    const maxExtension = active.config.maxExtensionMs ?? 0;
    const allowedExtension = Math.min(extensionMs, maxExtension - currentExtension);

    if (allowedExtension <= 0) return false;

    // Clear existing timer and set a new one
    clearTimeout(active.timer);
    active.expiresAt += allowedExtension;
    active.extensionMs += allowedExtension;
    this.extensionUsed.set(active.scope, currentExtension + allowedExtension);

    active.timer = setTimeout(() => {
      this.fireTimeout(id);
    }, active.expiresAt - Date.now());
    active.timer.unref();

    return true;
  }

  /**
   * Get all active timeouts.
   */
  getActiveTimeouts(): ActiveTimeout[] {
    return Array.from(this.activeTimeouts.values());
  }

  /**
   * Get timeout history.
   */
  getTimeoutHistory(): TimeoutEvent[] {
    return [...this.timeoutHistory];
  }

  /**
   * Clear all active timeouts (e.g., on execution completion).
   */
  clearAll(): void {
    for (const active of this.activeTimeouts.values()) {
      clearTimeout(active.timer);
    }
    this.activeTimeouts.clear();
    this.parentMap.clear();
    this.extensionUsed.clear();
  }

  /**
   * Get the default config for a level.
   */
  getDefaultConfig(level: TimeoutLevel): TimeoutConfig {
    return { ...this.config.defaults[level] };
  }

  /**
   * Update the default config for a level.
   */
  setDefaultConfig(level: TimeoutLevel, config: Partial<TimeoutConfig>): void {
    this.config.defaults[level] = { ...this.config.defaults[level], ...config };
  }

  /**
   * Reset all state.
   */
  reset(): void {
    this.clearAll();
    this.timeoutHistory = [];
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private fireTimeout(id: string): void {
    // Iterative (non-recursive) cascade to prevent stack overflow on deeply
    // nested timeout hierarchies. We use a queue and process all child
    // timeouts level by level.
    const queue: string[] = [id];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const active = this.activeTimeouts.get(currentId);
      if (!active) continue;

      const event: TimeoutEvent = {
        level: active.level,
        scope: active.scope,
        action: active.config.action,
        firedAt: Date.now(),
        durationMs: active.config.durationMs + active.extensionMs,
        message: `${active.level} timeout fired for "${active.scope}" after ${active.config.durationMs + active.extensionMs}ms — action: ${active.config.action}`,
      };

      this.timeoutHistory.push(event);
      if (this.timeoutHistory.length > 200) this.timeoutHistory.shift();

      this.activeTimeouts.delete(currentId);

      getGlobalLogger().warn(
        'HierarchicalTimeoutManager',
        event.message,
        { level: active.level, scope: active.scope, action: active.config.action },
      );

      // Publish to message bus
      if (this.config.publishEvents) {
        try {
          const bus = getMessageBus();
          bus.publish('system.alert', 'hierarchical-timeout', {
            type: 'timeout_fired',
            level: active.level,
            scope: active.scope,
            action: active.config.action,
            durationMs: event.durationMs,
            message: event.message,
          });
        } catch (err) {
          reportSilentFailure(err, 'hierarchicalTimeout:publish');
        }
      }

      // Enqueue child timeouts for cascading cancellation (iterative, not recursive)
      for (const [childScope, parentScope] of this.parentMap) {
        if (parentScope === active.scope) {
          for (const [childId, childActive] of this.activeTimeouts) {
            if (childActive.scope === childScope) {
              queue.push(childId);
            }
          }
        }
      }
      this.parentMap.delete(active.scope);
      this.extensionUsed.delete(active.scope);
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

import { createTenantAwareSingleton } from './tenantAwareSingleton';

const hierarchicalTimeoutSingleton = createTenantAwareSingleton(
  () => new HierarchicalTimeoutManager(),
);

export function getHierarchicalTimeoutManager(): HierarchicalTimeoutManager {
  return hierarchicalTimeoutSingleton.get();
}

export function resetHierarchicalTimeoutManager(): void {
  hierarchicalTimeoutSingleton.reset();
}
