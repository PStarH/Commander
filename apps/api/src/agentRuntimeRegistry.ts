/**
 * AgentRuntimeRegistry — Per-tenant runtime instances for the API server.
 *
 * Each tenant gets its own AgentRuntime, so circuit breakers, dead-letter queues,
 * compensation registries, tool orchestrators, and in-memory state are isolated.
 * A global fallback instance is used when no tenant context is active.
 */
import { reportSilentFailure } from '../../../packages/core/src/silentFailureReporter';
import {
  AgentRuntime,
  OpenAIProvider,
  AnthropicProvider,
  getGlobalTenantProvider,
  getCostModel,
} from '@commander/core';
import type {
  AgentExecutionContext,
  AgentExecutionResult,
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '@commander/core';

const MAX_RUNTIME_INSTANCES = 50;
const RUNTIME_TTL_MS = 30 * 60 * 1000; // 30 minutes
const THROUGHPUT_WINDOW_MS = 60_000;

export interface RuntimeRegistryEntry {
  runtime: AgentRuntime;
  createdAt: number;
  lastUsedAt: number;
  totalRuns: number;
  activeRuns: number;
  queuedRuns: number;
  cumulativeCostUsd: number;
  runTimestamps: number[];
}

export interface RuntimeStats {
  tenantId: string | 'global';
  activeRuns: number;
  queuedRuns: number;
  totalRuns: number;
  totalRunsLastMinute: number;
  cumulativeCostUsd: number;
  instanceAgeMs: number;
}

const tenantRuntimes = new Map<string, RuntimeRegistryEntry>();
let globalEntry: RuntimeRegistryEntry | null = null;

function createMockProvider(name: string): LLMProvider {
  return {
    name,
    async call(request: LLMRequest): Promise<LLMResponse> {
      const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
      const text =
        typeof lastUser?.content === 'string' ? lastUser.content : `Mock ${name} response`;
      return {
        content: text.slice(0, 500),
        model: request.model || `${name}-mock`,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      };
    },
  };
}

function registerDefaultProviders(rt: AgentRuntime): void {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (openaiKey) {
    rt.registerProvider(
      'openai',
      new OpenAIProvider({
        apiKey: openaiKey,
        baseUrl: process.env.OPENAI_BASE_URL,
        defaultModel: process.env.OPENAI_DEFAULT_MODEL ?? 'gpt-4o',
      }),
    );
  } else {
    rt.registerProvider('openai', createMockProvider('openai'));
  }

  if (anthropicKey) {
    rt.registerProvider(
      'anthropic',
      new AnthropicProvider({
        apiKey: anthropicKey,
        baseUrl: process.env.ANTHROPIC_BASE_URL,
        defaultModel: process.env.ANTHROPIC_DEFAULT_MODEL ?? 'claude-3-5-sonnet-20241022',
      }),
    );
  } else {
    rt.registerProvider('anthropic', createMockProvider('anthropic'));
  }
}

function createRuntime(): AgentRuntime {
  const rt = new AgentRuntime({ maxRetries: 1, timeoutMs: 30000, maxConcurrency: 10 });
  registerDefaultProviders(rt);
  return rt;
}

function freshEntry(): RuntimeRegistryEntry {
  return {
    runtime: createRuntime(),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    totalRuns: 0,
    activeRuns: 0,
    queuedRuns: 0,
    cumulativeCostUsd: 0,
    runTimestamps: [],
  };
}

function pruneTimestamps(entry: RuntimeRegistryEntry): void {
  const cutoff = Date.now() - THROUGHPUT_WINDOW_MS;
  // Simple in-place pruning from the front; timestamps are appended in order.
  while (entry.runTimestamps.length > 0 && entry.runTimestamps[0] < cutoff) {
    entry.runTimestamps.shift();
  }
}

function estimateRunCost(tokens: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}): number {
  try {
    return getCostModel().calculate('unknown', 'unknown', {
      input: tokens.promptTokens,
      output: tokens.completionTokens,
      cached: 0,
      reasoning: 0,
      total: tokens.totalTokens,
    }).totalCostUsd;
  } catch (err) {
    reportSilentFailure(err, 'agentRuntimeRegistry:140');
    return 0;
  }
}

function evictStaleRuntimes(): void {
  const now = Date.now();
  for (const [tenantId, entry] of tenantRuntimes) {
    if (now - entry.lastUsedAt > RUNTIME_TTL_MS) {
      tenantRuntimes.delete(tenantId);
    }
  }
}

function evictLRU(): void {
  let oldestId: string | null = null;
  let oldestTime = Infinity;
  for (const [tenantId, entry] of tenantRuntimes) {
    if (entry.lastUsedAt < oldestTime) {
      oldestTime = entry.lastUsedAt;
      oldestId = tenantId;
    }
  }
  if (oldestId) tenantRuntimes.delete(oldestId);
}

function resolveTenantId(explicitTenantId?: string): string | undefined {
  return explicitTenantId ?? getGlobalTenantProvider().getCurrentTenantId() ?? undefined;
}

function wrapRuntimeExecute(entry: RuntimeRegistryEntry): void {
  const rt = entry.runtime;
  const original = rt.execute.bind(rt) as (
    ctx: AgentExecutionContext,
  ) => Promise<AgentExecutionResult>;
  if ((rt as unknown as Record<string, unknown>).__registryWrapped) return;
  (rt as unknown as Record<string, unknown>).__registryWrapped = true;

  rt.execute = async (ctx: AgentExecutionContext): Promise<AgentExecutionResult> => {
    entry.totalRuns++;
    entry.runTimestamps.push(Date.now());
    pruneTimestamps(entry);
    entry.activeRuns++;
    entry.queuedRuns = entry.runtime.getQueueDepth();
    try {
      const result = await original(ctx);
      entry.cumulativeCostUsd += estimateRunCost(result.totalTokenUsage);
      return result;
    } finally {
      entry.activeRuns = Math.max(0, entry.activeRuns - 1);
      entry.queuedRuns = entry.runtime.getQueueDepth();
      pruneTimestamps(entry);
    }
  };
}

function getEntry(explicitTenantId?: string): RuntimeRegistryEntry {
  const tenantId = resolveTenantId(explicitTenantId);

  if (!tenantId) {
    if (!globalEntry) {
      globalEntry = freshEntry();
    }
    globalEntry.lastUsedAt = Date.now();
    wrapRuntimeExecute(globalEntry);
    return globalEntry;
  }

  let entry = tenantRuntimes.get(tenantId);
  if (!entry) {
    if (tenantRuntimes.size >= MAX_RUNTIME_INSTANCES) {
      evictStaleRuntimes();
      if (tenantRuntimes.size >= MAX_RUNTIME_INSTANCES) {
        evictLRU();
      }
    }
    entry = freshEntry();
    tenantRuntimes.set(tenantId, entry);
  }
  entry.lastUsedAt = Date.now();
  wrapRuntimeExecute(entry);
  return entry;
}

/** Get the runtime for the current tenant context (or the global fallback). */
export function getTenantRuntime(explicitTenantId?: string): AgentRuntime {
  return getEntry(explicitTenantId).runtime;
}

/** Execute a run through the tenant-scoped runtime and update capacity stats. */
export async function executeTenantRun(
  ctx: AgentExecutionContext,
  explicitTenantId?: string,
): Promise<AgentExecutionResult> {
  const tenantId = resolveTenantId(explicitTenantId);
  const entry = getEntry(tenantId);
  entry.queuedRuns = Math.max(0, entry.queuedRuns);
  entry.totalRuns++;
  entry.runTimestamps.push(Date.now());
  pruneTimestamps(entry);
  entry.activeRuns++;
  entry.queuedRuns = entry.runtime.getQueueDepth();

  try {
    const result = await entry.runtime.execute(ctx);
    entry.cumulativeCostUsd += estimateRunCost(result.totalTokenUsage);
    return result;
  } finally {
    entry.activeRuns = Math.max(0, entry.activeRuns - 1);
    entry.queuedRuns = entry.runtime.getQueueDepth();
    pruneTimestamps(entry);
  }
}

/** Aggregate capacity stats across all tenant runtimes. */
export function getRuntimeStats(): RuntimeStats[] {
  const stats: RuntimeStats[] = [];
  if (globalEntry) {
    pruneTimestamps(globalEntry);
    stats.push({
      tenantId: 'global',
      activeRuns: globalEntry.activeRuns,
      queuedRuns: globalEntry.queuedRuns,
      totalRuns: globalEntry.totalRuns,
      totalRunsLastMinute: globalEntry.runTimestamps.length,
      cumulativeCostUsd: globalEntry.cumulativeCostUsd,
      instanceAgeMs: Date.now() - globalEntry.createdAt,
    });
  }
  for (const [tenantId, entry] of tenantRuntimes) {
    pruneTimestamps(entry);
    stats.push({
      tenantId,
      activeRuns: entry.activeRuns,
      queuedRuns: entry.queuedRuns,
      totalRuns: entry.totalRuns,
      totalRunsLastMinute: entry.runTimestamps.length,
      cumulativeCostUsd: entry.cumulativeCostUsd,
      instanceAgeMs: Date.now() - entry.createdAt,
    });
  }
  return stats;
}

/** Reset the registry (useful for tests). */
export function resetRuntimeRegistry(): void {
  tenantRuntimes.clear();
  globalEntry = null;
}
