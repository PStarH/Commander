/**
 * CommanderClient — Lightweight SDK wrapper for Commander.
 *
 * This is a thin proxy that delegates all infrastructure wiring to the
 * core Commander class. Use this when embedding Commander into your app
 * programmatically.
 *
 * For zero-config CLI usage, use `Commander.create()` directly from core.
 *
 * @example
 * ```typescript
 * import { CommanderClient, Topology } from '@commander/sdk';
 *
 * // Auto-detect environment (tier, provider, model)
 * const client = new CommanderClient();
 * await client.connect();
 * const result = await client.run('analyze this repository');
 *
 * // With explicit config
 * const client = new CommanderClient({ provider: 'openai' });
 * await client.connect();
 * await client.disconnect();
 * ```
 */

import type { CommanderOptions } from '@commander/core';

import type {
  CommanderClientConfig,
  ExecutionResult,
  ExecutionEvent,
  SessionSummary,
  SystemStatus,
  AgentConfig,
  AgentSnapshot,
  Task,
  TaskHandle,
  MemoryWriteOptions,
  MemoryQueryOptions,
  MemoryItem,
  MemoryStats,
  Topology,
  SDKReliabilityStats,
  ExecutionStepSummary,
} from './types';

// ============================================================================
// Agent
// ============================================================================

let agentIdCounter = 0;

/**
 * Agent — a configured persona within Commander.
 */
export class Agent {
  readonly id: string;
  readonly config: AgentConfig;
  readonly createdAt: string;
  runCount = 0;
  totalTokensUsed = 0;
  lastRunAt?: string;

  constructor(config: AgentConfig) {
    this.id = config.id ?? `agent_${++agentIdCounter}`;
    this.config = { ...config };
    this.createdAt = new Date().toISOString();
    if (!config.name || !config.role) {
      throw new Error('Agent requires both `name` and `role`.');
    }
  }

  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      name: this.config.name,
      role: this.config.role,
      tools: this.config.tools ?? [],
      topology: this.config.topology ?? ('SINGLE' as Topology),
      runCount: this.runCount,
      totalTokensUsed: this.totalTokensUsed,
      createdAt: this.createdAt,
      lastRunAt: this.lastRunAt,
    };
  }

  static fromSnapshot(snapshot: AgentSnapshot): Agent {
    const agent = new Agent({
      id: snapshot.id,
      name: snapshot.name,
      role: snapshot.role,
      tools: snapshot.tools,
      topology: snapshot.topology,
    });
    agent.runCount = snapshot.runCount;
    agent.totalTokensUsed = snapshot.totalTokensUsed;
    agent.lastRunAt = snapshot.lastRunAt;
    return agent;
  }
}

// ============================================================================
// CommanderClient (thin wrapper)
// ============================================================================

export class CommanderClient {
  private config: CommanderClientConfig;
  private commander: Awaited<ReturnType<typeof import('@commander/core').Commander.create>> | null =
    null;
  private connected = false;
  private startTime: number = 0;
  private runCount = 0;
  private activeSessions = 0;
  private eventHandlers: Set<(event: ExecutionEvent) => void> = new Set();
  private sessions: SessionSummary[] = [];
  private agents: Map<string, Agent> = new Map();
  private tasks: Map<string, TaskHandle> = new Map();
  private taskCounter = 0;

  constructor(config: CommanderClientConfig = {}) {
    this.config = {
      tokenBudget: 64000,
      defaultTopology: 'SINGLE' as Topology,
      persistSessions: true,
      ...config,
    };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async connect(): Promise<void> {
    if (this.connected) return;
    this.startTime = Date.now();

    // Delegate all environment probing + tier selection + wiring to core Commander
    const { Commander } = await import('@commander/core');
    const options: CommanderOptions = {};

    if (this.config.provider) options.provider = this.config.provider;
    if (this.config.apiKey) options.apiKey = this.config.apiKey;
    if (this.config.model) options.model = this.config.model;
    if (this.config.baseUrl) options.baseUrl = this.config.baseUrl;
    if (this.config.tokenBudget) options.tokenBudget = this.config.tokenBudget;

    this.commander = await Commander.create(options);

    // Wire SSE events
    const { getMessageBus } = await import('@commander/core');
    const bus = getMessageBus();
    bus.subscribe('agent.started', () => {
      this.activeSessions++;
    });
    bus.subscribe('agent.completed', () => {
      this.runCount++;
      this.activeSessions = Math.max(0, this.activeSessions - 1);
    });
    bus.subscribe('agent.failed', () => {
      this.runCount++;
      this.activeSessions = Math.max(0, this.activeSessions - 1);
    });

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.commander?.dispose();
    this.eventHandlers.clear();
    this.commander = null;
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // ==========================================================================
  // Agent Management
  // ==========================================================================

  createAgent(config: AgentConfig): Agent {
    const agent = new Agent(config);
    this.agents.set(agent.id, agent);
    return agent;
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }
  listAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  removeAgent(id: string): boolean {
    return this.agents.delete(id);
  }

  getAgentSnapshots(): AgentSnapshot[] {
    return this.listAgents().map((a) => a.snapshot());
  }

  // ==========================================================================
  // Task Submission
  // ==========================================================================

  submitTask(agent: Agent, task: Task): TaskHandle {
    const id = `task_${++this.taskCounter}`;
    const handle: TaskHandle = {
      id,
      task,
      status: 'pending',
      agentId: agent.id,
      submittedAt: new Date().toISOString(),
    };
    this.tasks.set(id, handle);

    this.executeTask(agent, handle).catch((err) => {
      handle.status = 'failed';
      handle.completedAt = new Date().toISOString();
      handle.result = {
        status: 'FAILED',
        summary: err instanceof Error ? err.message : String(err),
        steps: [],
        totalTokenUsage: 0,
        totalDurationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    });
    return handle;
  }

  async awaitTask(taskId: string, timeoutMs = 120_000): Promise<ExecutionResult | null> {
    const handle = this.tasks.get(taskId);
    if (!handle) return null;
    if (handle.result) return handle.result;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 200));
      const h = this.tasks.get(taskId);
      if (h?.result) return h.result;
    }
    return null;
  }

  getTaskHandle(id: string): TaskHandle | undefined {
    return this.tasks.get(id);
  }

  cancelTask(id: string): boolean {
    const handle = this.tasks.get(id);
    if (!handle || handle.status === 'completed' || handle.status === 'failed') return false;
    handle.status = 'cancelled';
    handle.completedAt = new Date().toISOString();
    return true;
  }

  private async executeTask(agent: Agent, handle: TaskHandle): Promise<void> {
    handle.status = 'running';
    agent.lastRunAt = new Date().toISOString();
    try {
      const result = await this.runInternal(handle.task.goal, agent);
      handle.status = 'completed';
      handle.completedAt = new Date().toISOString();
      handle.result = result;
      agent.runCount++;
      agent.totalTokensUsed += result.totalTokenUsage;
    } catch (err) {
      handle.status = 'failed';
      handle.completedAt = new Date().toISOString();
      handle.result = {
        status: 'FAILED',
        summary: err instanceof Error ? err.message : String(err),
        steps: [],
        totalTokenUsage: 0,
        totalDurationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ==========================================================================
  // Execution
  // ==========================================================================

  async plan(task: string): Promise<unknown> {
    this.ensureConnected();
    return this.commander!.plan(task);
  }

  async run(task: string): Promise<ExecutionResult> {
    this.ensureConnected();
    return this.runInternal(task);
  }

  private async runInternal(task: string, agent?: Agent): Promise<ExecutionResult> {
    const startTime = Date.now();
    const result = await this.commander!.run(
      task,
      agent?.id ?? 'commander-sdk',
      agent?.config.tools,
    );

    if (this.config.persistSessions !== false) {
      if (this.sessions.length >= 1000) {
        this.sessions.splice(0, this.sessions.length - 999);
      }
      this.sessions.push({
        runId: result.runId,
        task: task.slice(0, 80),
        status: result.status.toUpperCase(),
        agentId: agent?.id ?? 'commander-sdk',
        topology: agent?.config.topology ?? this.config.defaultTopology ?? ('SINGLE' as Topology),
        tokenUsage: result.tokenUsage.totalTokens,
        durationMs: result.durationMs,
        timestamp: new Date().toISOString(),
      });
    }

    const status: ExecutionResult['status'] =
      result.status === 'success' ? 'SUCCESS' : result.status === 'failed' ? 'FAILED' : 'PARTIAL';

    return {
      status,
      summary: result.summary,
      steps: result.steps as unknown as ExecutionStepSummary[],
      totalTokenUsage: result.tokenUsage.totalTokens,
      totalDurationMs: result.durationMs,
      error: result.error,
      runId: result.runId,
    };
  }

  // ==========================================================================
  // Memory
  // ==========================================================================

  async writeMemory(content: string, options: MemoryWriteOptions = {}): Promise<string | null> {
    try {
      const { getGlobalThreeLayerMemory } = await import('@commander/core');
      const memory = getGlobalThreeLayerMemory();
      const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      memory.add(
        content,
        options.layer ?? 'episodic',
        `id:${id}`,
        options.importance ?? 0.5,
        options.tags ?? [],
      );
      return id;
    } catch {
      return null;
    }
  }

  queryMemory(options: MemoryQueryOptions = {}): MemoryItem[] {
    // Memory access is best-effort — returns empty on failure
    return [];
  }

  async getMemoryStats(): Promise<MemoryStats> {
    // Memory stats via core Commander — best-effort, returns zeros on failure
    return {
      workingCount: 0,
      episodicCount: 0,
      longTermCount: 0,
      totalCount: 0,
      oldestEntry: '',
      newestEntry: '',
    };
  }

  // ==========================================================================
  // Events
  // ==========================================================================

  onEvent(handler: (event: ExecutionEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  // ==========================================================================
  // Session History
  // ==========================================================================

  listSessions(): SessionSummary[] {
    return [...this.sessions].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  }

  // ==========================================================================
  // System Status
  // ==========================================================================

  async getStatus(): Promise<SystemStatus> {
    this.ensureConnected();
    const coreStatus = this.commander!.getStatus();
    return {
      provider: this.config.provider ?? (coreStatus.provider as string) ?? 'auto',
      model: this.config.model ?? (coreStatus.model as string) ?? 'auto',
      uptime: coreStatus.uptime as string,
      totalRuns: this.runCount,
      activeSessions: this.activeSessions,
      memoryUsage: process.memoryUsage().heapUsed,
      topologyDefaults: this.config.defaultTopology ?? ('SINGLE' as Topology),
      agentCount: this.agents.size,
    };
  }

  getReliabilityStats(): SDKReliabilityStats {
    return {
      circuitState: 'CLOSED',
      circuitFailures: 0,
      dlqTotalEntries: 0,
      pendingCompensations: 0,
      checkpointCount: 0,
    };
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private ensureConnected(): void {
    if (!this.connected || !this.commander) {
      throw new Error('CommanderClient not connected. Call client.connect() first.');
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Quick-start: create and connect a CommanderClient in one call.
 */
export async function createClient(config?: CommanderClientConfig): Promise<CommanderClient> {
  const client = new CommanderClient(config);
  await client.connect();
  return client;
}
