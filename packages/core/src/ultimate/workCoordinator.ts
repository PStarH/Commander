import { reportSilentFailure } from '../silentFailureReporter';
import { randomUUID } from 'crypto';
import { getMessageBus } from '../runtime/messageBus';
import { getGlobalLogger } from '../logging';
import type { WorkQueueStore } from './workQueueStore';
import { InMemoryWorkQueueStore } from './inMemoryWorkQueueStore';

export type WorkStatus = 'PENDING' | 'CLAIMED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'REASSIGNED';

export interface WorkItem {
  id: string;
  runId: string;
  parentNodeId: string;
  goal: string;
  tools: string[];
  dependsOn: string[];
  status: WorkStatus;
  claimedBy?: string;
  claimedAt?: string;
  completedAt?: string;
  failedAt?: string;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  tokenBudget: number;
  priority: number;
  createdAt: string;
  leaseToken?: string;
  fencingEpoch?: number;
}

export type WorkEvent =
  | { type: 'enqueued'; item: WorkItem }
  | { type: 'claimed'; item: WorkItem; agentId: string }
  | { type: 'started'; item: WorkItem; agentId: string }
  | { type: 'completed'; item: WorkItem; agentId: string }
  | { type: 'failed'; item: WorkItem; agentId: string; error: string }
  | { type: 'reassigned'; item: WorkItem; fromAgent: string; reason: string }
  | { type: 'terminal'; item: WorkItem; agentId: string; error: string };

export type WorkEventHandler = (event: WorkEvent) => void;

export interface EnqueueInput {
  runId: string;
  parentNodeId: string;
  goal: string;
  tools: string[];
  dependsOn?: string[];
  maxAttempts?: number;
  tokenBudget?: number;
  priority?: number;
}

export interface ClaimFilter {
  tools?: string[];
  runId?: string;
  agentId?: string;
  parentNodeId?: string;
}

export interface TeamStatus {
  runId: string;
  total: number;
  pending: number;
  claimed: number;
  running: number;
  completed: number;
  failed: number;
  reassigned: number;
  byAgent: Record<string, { claimed: number; running: number; completed: number; failed: number }>;
  pendingByAgent: Record<string, number>;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_TOKEN_BUDGET = 50_000;
const DEFAULT_PRIORITY = 50;
const MAX_ITEMS_RETENTION = 10_000;
const MAX_HANDLERS = 200;

export interface WorkCoordinatorConfig {
  store?: WorkQueueStore;
}

export class WorkCoordinator {
  private items = new Map<string, WorkItem>();
  private handlers = new Set<WorkEventHandler>();
  private counter = 0;
  private store: WorkQueueStore;

  constructor(config: WorkCoordinatorConfig = {}) {
    this.store = config.store ?? new InMemoryWorkQueueStore();
    this.recover();
  }

  private recover(): void {
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
        getGlobalLogger().info('WorkCoordinator', 'Reclaimed in-flight items from prior process', {
          reclaimedCount,
          totalRecovered: persisted.length,
        });
      } else if (persisted.length > 0) {
        getGlobalLogger().info('WorkCoordinator', 'Recovered work items from store', {
          count: persisted.length,
        });
      }
    } catch (err) {
      getGlobalLogger().error('WorkCoordinator', 'Failed to recover from store', err as Error);
    }
  }

  enqueue(input: EnqueueInput | EnqueueInput[]): WorkItem[] {
    const inputs = Array.isArray(input) ? input : [input];
    const out: WorkItem[] = [];
    const now = new Date().toISOString();
    for (const i of inputs) {
      const id = this.generateId();
      const item: WorkItem = {
        id,
        runId: i.runId,
        parentNodeId: i.parentNodeId,
        goal: i.goal,
        tools: i.tools,
        dependsOn: i.dependsOn ?? [],
        status: 'PENDING',
        attempts: 0,
        maxAttempts: i.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        tokenBudget: i.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
        priority: i.priority ?? DEFAULT_PRIORITY,
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

  claim(agentId: string, filter?: ClaimFilter): WorkItem | null {
    if (this.hasCycle(filter?.runId)) {
      getGlobalLogger().warn('WorkCoordinator', 'Dependency cycle detected, refusing claim', {
        agentId,
      });
      return null;
    }

    const candidates: WorkItem[] = [];
    for (const item of this.items.values()) {
      if (item.status !== 'PENDING') continue;
      if (filter?.runId && item.runId !== filter.runId) continue;
      if (filter?.tools && !filter.tools.some((t) => item.tools.includes(t))) continue;
      if (filter?.parentNodeId && item.parentNodeId !== filter.parentNodeId) continue;
      if (!this.dependenciesMet(item)) continue;
      candidates.push(item);
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.createdAt.localeCompare(b.createdAt);
    });

    for (const item of candidates) {
      const leaseToken = randomUUID();
      const claimedAt = new Date().toISOString();
      if (!this.store.tryClaim(agentId, item.id, leaseToken, claimedAt)) {
        continue;
      }
      item.status = 'CLAIMED';
      item.claimedBy = agentId;
      item.claimedAt = claimedAt;
      item.attempts++;
      item.leaseToken = leaseToken;
      item.fencingEpoch = (item.fencingEpoch ?? 0) + 1;
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

  start(workId: string, agentId: string): boolean {
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

  complete(workId: string, agentId: string, result?: unknown): boolean {
    const item = this.items.get(workId);
    if (
      !item ||
      (item.status !== 'CLAIMED' && item.status !== 'RUNNING') ||
      item.claimedBy !== agentId
    ) {
      return false;
    }
    item.status = 'COMPLETED';
    item.completedAt = new Date().toISOString();
    if (item.leaseToken) this.store.releaseClaim(item.leaseToken);
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

  fail(workId: string, agentId: string, error: string): WorkItem | null {
    const item = this.items.get(workId);
    if (
      !item ||
      (item.status !== 'CLAIMED' && item.status !== 'RUNNING') ||
      item.claimedBy !== agentId
    ) {
      return null;
    }
    item.lastError = error;
    item.failedAt = new Date().toISOString();
    if (item.leaseToken) this.store.releaseClaim(item.leaseToken);
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
      return this.reassignInternal(
        item,
        agentId,
        `attempt ${item.attempts} failed: ${error.slice(0, 100)}`,
      );
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

  reassign(workId: string, reason: string): WorkItem | null {
    const item = this.items.get(workId);
    if (!item) return null;
    if (item.status !== 'CLAIMED' && item.status !== 'RUNNING' && item.status !== 'REASSIGNED') {
      return null;
    }
    const fromAgent = item.claimedBy ?? 'unknown';
    return this.reassignInternal(item, fromAgent, reason);
  }

  list(filter?: { runId?: string; status?: WorkStatus; agentId?: string }): WorkItem[] {
    const result: WorkItem[] = [];
    for (const item of this.items.values()) {
      if (filter?.runId && item.runId !== filter.runId) continue;
      if (filter?.status && item.status !== filter.status) continue;
      if (filter?.agentId && item.claimedBy !== filter.agentId) continue;
      result.push(item);
    }
    return result;
  }

  getTeamStatus(runId: string): TeamStatus {
    const items = this.list({ runId });
    const byAgent: Record<
      string,
      { claimed: number; running: number; completed: number; failed: number }
    > = {};
    const pendingByAgent: Record<string, number> = {};
    let pending = 0,
      claimed = 0,
      running = 0,
      completed = 0,
      failed = 0,
      reassigned = 0;
    for (const item of items) {
      const agent = item.claimedBy ?? 'unassigned';
      if (!byAgent[agent]) byAgent[agent] = { claimed: 0, running: 0, completed: 0, failed: 0 };
      switch (item.status) {
        case 'PENDING':
          pending++;
          pendingByAgent[agent] = (pendingByAgent[agent] ?? 0) + 1;
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

  subscribe(handler: WorkEventHandler): () => void {
    if (this.handlers.size >= MAX_HANDLERS) {
      getGlobalLogger().warn('WorkCoordinator', 'Handler cap reached, dropping subscription');
      return () => {};
    }
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  clear(runId?: string): number {
    let removed = 0;
    for (const [id, item] of this.items) {
      if (runId && item.runId !== runId) continue;
      this.items.delete(id);
      removed++;
    }
    this.store.remove((item) => (runId ? item.runId === runId : true));
    return removed;
  }

  private dependenciesMet(item: WorkItem): boolean {
    if (item.dependsOn.length === 0) return true;
    for (const depId of item.dependsOn) {
      const dep = this.items.get(depId);
      if (!dep || dep.status !== 'COMPLETED') return false;
    }
    return true;
  }

  private hasCycle(runId?: string): boolean {
    const items = runId
      ? Array.from(this.items.values()).filter((i) => i.runId === runId)
      : Array.from(this.items.values());
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const adj = new Map<string, string[]>();
    for (const item of items) adj.set(item.id, item.dependsOn);

    const dfs = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const dep of adj.get(id) ?? []) {
        if (dfs(dep)) return true;
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    };

    for (const item of items) {
      if (dfs(item.id)) return true;
    }
    return false;
  }

  private reassignInternal(item: WorkItem, fromAgent: string, reason: string): WorkItem {
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

  private emit(event: WorkEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        getGlobalLogger().error('WorkCoordinator', 'Handler error', err as Error);
      }
    }
  }

  private publishBus(topic: string, payload: unknown): void {
    try {
      const bus = getMessageBus();
      (bus.publish as (t: string, s: string, p: unknown) => unknown)(
        topic,
        'work-coordinator',
        payload,
      );
    } catch (err) {
      reportSilentFailure(err, 'workCoordinator:458');
      // Bus may be uninitialized in tests
    }
  }

  private enforceRetention(): void {
    if (this.items.size <= MAX_ITEMS_RETENTION) return;
    const toRemove: string[] = [];
    for (const [id, item] of this.items) {
      if (item.status === 'COMPLETED' || item.status === 'FAILED') {
        toRemove.push(id);
        if (this.items.size - toRemove.length <= MAX_ITEMS_RETENTION) break;
      }
    }
    for (const id of toRemove) this.items.delete(id);
  }

  private generateId(): string {
    this.counter++;
    return `wko_${Date.now()}_${this.counter}`;
  }
}

let singleton: WorkCoordinator | null = null;
let singletonConfig: WorkCoordinatorConfig | null = null;

export function getWorkCoordinator(config?: WorkCoordinatorConfig): WorkCoordinator {
  if (config) {
    if (singleton) singleton.clear();
    singleton = new WorkCoordinator(config);
    singletonConfig = config;
    return singleton;
  }
  if (!singleton) {
    singleton = new WorkCoordinator(singletonConfig ?? undefined);
  }
  return singleton;
}

export function resetWorkCoordinator(): void {
  if (singleton) {
    singleton.clear();
    (singleton as unknown as { store: { close?: () => void } }).store.close?.();
  }
  singleton = null;
  singletonConfig = null;
}
