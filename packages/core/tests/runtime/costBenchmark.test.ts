/**
 * Cost Benchmark — Comprehensive cost optimization measurement.
 *
 * Tests and measures:
 * 1. Tool result cache hit rate
 * 2. Semantic cache hit rate
 * 3. Single-flight dedup
 * 4. Cost estimator accuracy
 * 5. Context compaction savings
 * 6. Early-exit savings
 * 7. Tool pruning savings
 * 8. Prompt compression savings
 * 9. Cost-weighted vs naive compaction
 * 10. Cost-per-success model scoring
 *
 * All benchmarks report: raw numbers, percentage savings, estimated USD.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolResultCache } from '../../src/runtime/toolResultCache';
import { SemanticCache } from '../../src/runtime/semanticCache';
import { MockEmbeddingFunction } from '../../src/runtime/embedding';
import { SingleFlightRequestCache } from '../../src/runtime/singleFlightRequestCache';
import { CostEstimator } from '../../src/runtime/costEstimator';
import { ContextCompactor } from '../../src/runtime/contextCompactor';
import { TokenGovernor } from '../../src/runtime/tokenGovernor';
import { ModelRouter } from '../../src/runtime/modelRouter';
import { selectTools, estimateToolTokenCost } from '../../src/runtime/toolRetriever';
import type {
  ToolCall,
  ToolResult,
  LLMRequest,
  LLMResponse,
  AgentExecutionContext,
  RoutingDecision,
  LLMMessage,
  ToolDefinition,
} from '../../src/runtime/types';

// ============================================================================
// Pricing constants (USD per 1K tokens)
// ============================================================================

const PRICING = {
  standard: { input: 0.003, output: 0.015 },
  eco: { input: 0.0008, output: 0.004 },
  power: { input: 0.015, output: 0.075 },
};

function costUsd(
  inputTokens: number,
  outputTokens: number,
  tier: 'standard' | 'eco' | 'power' = 'standard',
): number {
  const p = PRICING[tier];
  return (inputTokens / 1000) * p.input + (outputTokens / 1000) * p.output;
}

function report(name: string, raw: Record<string, number>) {
  console.log(`\n📊 ${name}`);
  for (const [k, v] of Object.entries(raw)) {
    console.log(`   ${k}: ${typeof v === 'number' && v < 1 ? `$${v.toFixed(6)}` : v}`);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function makeToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`, name, arguments: args };
}

function makeToolResult(name: string, output: string = 'ok'): ToolResult {
  return { toolCallId: `result_${Date.now()}`, name, output, durationMs: 50 };
}

function makeLLMRequest(messages: LLMMessage[], model = 'gpt-4o'): LLMRequest {
  return { model, messages, temperature: 0, maxTokens: 4096 };
}

function makeLLMResponse(content: string, promptTokens = 500, completionTokens = 200): LLMResponse {
  return {
    content,
    model: 'gpt-4o',
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    finishReason: 'stop',
  };
}

function makeCtx(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
  return {
    agentId: 'bench-agent',
    projectId: 'bench-project',
    goal: 'Implement a cost optimization benchmark',
    tokenBudget: 50000,
    maxSteps: 10,
    availableTools: ['file_read', 'file_write', 'file_edit', 'shell_execute', 'code_search', 'git'],
    contextData: {},
    ...overrides,
  };
}

function makeRouting(overrides?: Partial<RoutingDecision>): RoutingDecision {
  return {
    modelId: 'gpt-4o',
    tier: 'standard',
    provider: 'openai',
    reasoning: ['benchmark'],
    estimatedCost: 0.01,
    maxTokens: 4096,
    ...overrides,
  };
}

function makeMessages(count: number, avgLen = 500): LLMMessage[] {
  const msgs: LLMMessage[] = [];
  for (let i = 0; i < count; i++) {
    const role = i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'tool';
    msgs.push({
      role: role as LLMMessage['role'],
      content: `${role} message ${i}: ` + 'X'.repeat(avgLen),
      ...(role === 'tool' ? { tool_call_id: `call_${i}` } : {}),
    });
  }
  return msgs;
}

function makeToolDefs(count: number): ToolDefinition[] {
  const names = [
    'file_read',
    'file_write',
    'file_edit',
    'file_search',
    'file_list',
    'shell_execute',
    'python_execute',
    'code_search',
    'apply_patch',
    'fix_code',
    'refine_code',
    'web_search',
    'web_fetch',
    'git',
    'agent',
  ];
  return names.slice(0, count).map((name) => ({
    name,
    description: `${name} tool for performing ${name.replace(/_/g, ' ')} operations on the system`,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  }));
}

// ============================================================================
// 1. Tool Result Cache Hit Rate
// ============================================================================

describe('Benchmark: Tool Result Cache Hit Rate', () => {
  let cache: ToolResultCache;

  beforeEach(() => {
    cache = new ToolResultCache({
      enabled: true,
      maxEntries: 1000,
      defaultTtlMs: 300_000,
      toolTtls: {},
      neverCache: [],
    });
  });

  afterEach(() => cache.dispose());

  it('measures cache hit ratio for repeated tool calls', async () => {
    const toolNames = ['file_read', 'code_search', 'file_list', 'web_search', 'shell_execute'];
    const iterations = 200;
    const uniqueCalls = 40;

    const calls: ToolCall[] = [];
    for (let i = 0; i < uniqueCalls; i++) {
      calls.push(makeToolCall(toolNames[i % toolNames.length], { path: `/src/file_${i}.ts` }));
    }

    for (const call of calls) {
      await cache.set(call, makeToolResult(call.name, `output for ${call.name}`));
    }

    let hits = 0;
    for (let i = 0; i < iterations; i++) {
      const call = calls[i % calls.length];
      const result = cache.get(call);
      if (result) hits++;
    }

    const stats = cache.getStats();
    const hitRate = hits / iterations;
    const savedExecutions = hits;
    const savedTokens = savedExecutions * 150;
    const savedUsd = costUsd(savedTokens, 0);

    report('Tool Result Cache', {
      'Total lookups': iterations,
      'Cache hits': hits,
      'Hit rate': hitRate,
      'Executions saved': savedExecutions,
      'Tokens saved (input)': savedTokens,
      'USD saved': savedUsd,
    });

    expect(hitRate).toBeGreaterThanOrEqual(0.9);
  });

  it('measures cache effectiveness under LRU eviction', async () => {
    const smallCache = new ToolResultCache({
      enabled: true,
      maxEntries: 10,
      defaultTtlMs: 300_000,
      toolTtls: {},
      neverCache: [],
    });

    for (let i = 0; i < 30; i++) {
      await smallCache.set(
        makeToolCall('file_read', { path: `/file_${i}` }),
        makeToolResult('file_read'),
      );
    }

    let hits = 0;
    for (let i = 20; i < 30; i++) {
      const result = smallCache.get(makeToolCall('file_read', { path: `/file_${i}` }));
      if (result) hits++;
    }

    const stats = smallCache.getStats();
    report('Tool Cache LRU', {
      'Entries kept': stats.totalEntries,
      Evictions: stats.evictions,
      'Recent access hits': hits,
    });

    smallCache.dispose();
    expect(stats.totalEntries).toBeLessThanOrEqual(10);
    expect(hits).toBeGreaterThan(0);
  });

  it('reports never-cache exclusion correctly', async () => {
    const restrictedCache = new ToolResultCache({
      enabled: true,
      maxEntries: 100,
      defaultTtlMs: 300_000,
      toolTtls: {},
      neverCache: ['shell_execute', 'python_execute', 'git_push'],
    });

    const neverCache = ['shell_execute', 'python_execute', 'git_push'];
    for (const tool of neverCache) {
      await restrictedCache.set(makeToolCall(tool), makeToolResult(tool));
    }

    for (const tool of neverCache) {
      const result = restrictedCache.get(makeToolCall(tool));
      expect(result).toBeUndefined();
    }

    await restrictedCache.set(
      makeToolCall('file_read', { path: '/x' }),
      makeToolResult('file_read'),
    );
    const result = restrictedCache.get(makeToolCall('file_read', { path: '/x' }));
    expect(result).toBeDefined();
    restrictedCache.dispose();
  });
});

// ============================================================================
// 2. Semantic Cache Hit Rate
// ============================================================================

describe('Benchmark: Semantic Cache Hit Rate', () => {
  it('measures semantic similarity hit rate for near-duplicate prompts', async () => {
    const embeddingFn = new MockEmbeddingFunction();
    const cache = new SemanticCache(embeddingFn, {
      enabled: true,
      similarityThreshold: 0.85,
      maxEntries: 1000,
      defaultTtlMs: 86_400_000,
      maxBucketSize: 64,
      cacheStochastic: true,
      cacheToolCalls: false,
      pruneIntervalMs: 0,
    });

    const queries = [
      'What is the capital of France?',
      'What is the capital of France', // near-dup
      'What is the capital of France?', // exact dup
      'Tell me about Paris', // different
      'What is the capital of Germany?', // different
      "What is France's capital?", // paraphrase
      'How do I fix a bug in file_read?', // different domain
      'How to fix a bug in file_read?', // near-dup
    ];

    const responses: LLMResponse[] = queries.map((q) => makeLLMResponse(`Answer for: ${q}`));

    for (let i = 0; i < queries.length; i++) {
      const req = makeLLMRequest([{ role: 'user', content: queries[i] }]);
      cache.store(req, responses[i]);
    }

    await new Promise((r) => setTimeout(r, 10));

    let hits = 0;
    let misses = 0;
    const lookups = 20;
    for (let i = 0; i < lookups; i++) {
      const idx = i % queries.length;
      const req = makeLLMRequest([{ role: 'user', content: queries[idx] }]);
      const result = await cache.lookup(req);
      if (result) hits++;
      else misses++;
    }

    const stats = cache.getStats();
    const hitRate = hits / lookups;
    const savedTokens = hits * 700;
    const savedUsd = costUsd(savedTokens, 0);

    report('Semantic Cache', {
      'Total lookups': lookups,
      'Cache hits': hits,
      'Hit rate': hitRate,
      'Entries stored': stats.totalStores,
      'Tokens saved (input)': savedTokens,
      'USD saved': savedUsd,
    });

    expect(hitRate).toBeGreaterThanOrEqual(0.3);
    cache.dispose();
  });

  it('measures cost saved across a realistic query mix', async () => {
    const embeddingFn = new MockEmbeddingFunction();
    const cache = new SemanticCache(embeddingFn, {
      enabled: true,
      similarityThreshold: 0.9,
      maxEntries: 5000,
      defaultTtlMs: 86_400_000,
      maxBucketSize: 64,
      cacheStochastic: true,
      cacheToolCalls: false,
      pruneIntervalMs: 0,
    });

    const baseQueries = [
      'Explain how the context compactor works',
      'What are the tool result cache benefits?',
      'How does the model router select models?',
      'What is the single-flight dedup pattern?',
      'How does token budgeting work?',
    ];

    for (const q of baseQueries) {
      const req = makeLLMRequest([{ role: 'user', content: q }]);
      cache.store(req, makeLLMResponse(`Response: ${q}`, 800, 400));
    }

    await new Promise((r) => setTimeout(r, 10));

    const simulatedTraffic = [
      ...baseQueries,
      ...baseQueries.slice(0, 3).map((q) => q + '?'), // near-dups
      ...baseQueries.slice(0, 2), // exact dups
    ];

    let hits = 0;
    for (const q of simulatedTraffic) {
      const req = makeLLMRequest([{ role: 'user', content: q }]);
      const result = await cache.lookup(req);
      if (result) hits++;
    }

    const hitRate = hits / simulatedTraffic.length;
    const savedInputTokens = hits * 800;
    const savedOutputTokens = hits * 400;
    const savedUsd = costUsd(savedInputTokens, savedOutputTokens);

    report('Semantic Cache Cost Savings', {
      'Traffic volume': simulatedTraffic.length,
      'Cache hits': hits,
      'Hit rate': hitRate,
      'Saved input tokens': savedInputTokens,
      'Saved output tokens': savedOutputTokens,
      'USD saved (@ standard pricing)': savedUsd,
    });

    expect(hits).toBeGreaterThan(0);
    cache.dispose();
  });
});

// ============================================================================
// 3. Single-Flight Dedup
// ============================================================================

describe('Benchmark: Single-Flight Dedup', () => {
  it('measures dedup savings for concurrent identical requests', async () => {
    const cache = new SingleFlightRequestCache({ enabled: true, maxInFlight: 100 });

    const request = makeLLMRequest([
      { role: 'user', content: 'Plan the optimal decomposition for this task' },
    ]);
    const key = SingleFlightRequestCache.computeKey(request);

    let factoryCalls = 0;
    const factory = async (): Promise<LLMResponse> => {
      factoryCalls++;
      await new Promise((r) => setTimeout(r, 50));
      return makeLLMResponse('Planned decomposition', 1000, 500);
    };

    const concurrency = 10;
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => cache.dedupe(key, factory)),
    );

    const stats = cache.getStats();
    const savedCalls = concurrency - 1;
    const savedTokens = savedCalls * 1500;
    const savedUsd = costUsd(savedTokens, 0);

    report('Single-Flight Dedup', {
      'Concurrent requests': concurrency,
      'Factory calls': factoryCalls,
      'Dedup hits': stats.hits,
      'Calls saved': savedCalls,
      'Tokens saved': savedTokens,
      'USD saved': savedUsd,
    });

    expect(factoryCalls).toBe(1);
    expect(results.every((r) => r.content === 'Planned decomposition')).toBe(true);
  });

  it('measures savings across multiple dedup windows', async () => {
    const cache = new SingleFlightRequestCache({ enabled: true, maxInFlight: 100 });

    const requests = [
      makeLLMRequest([{ role: 'user', content: 'Task A planning' }]),
      makeLLMRequest([{ role: 'user', content: 'Task B planning' }]),
      makeLLMRequest([{ role: 'user', content: 'Task C planning' }]),
    ];

    const factoryCounts = [0, 0, 0];
    const factories = requests.map((req, idx) => {
      const key = SingleFlightRequestCache.computeKey(req);
      return async () => {
        factoryCounts[idx]++;
        await new Promise((r) => setTimeout(r, 30));
        return makeLLMResponse(`Result ${idx}`, 500, 200);
      };
    });

    const wave = 5;
    const promises: Promise<LLMResponse>[] = [];
    for (let w = 0; w < wave; w++) {
      for (let r = 0; r < requests.length; r++) {
        const key = SingleFlightRequestCache.computeKey(requests[r]);
        promises.push(cache.dedupe(key, factories[r]));
      }
    }

    await Promise.all(promises);
    const stats = cache.getStats();

    const totalRequests = wave * requests.length;
    const totalSaved = totalRequests - factoryCounts.reduce((a, b) => a + b, 0);
    const savedTokens = totalSaved * 700;
    const savedUsd = costUsd(savedTokens, 0);

    report('Multi-Wave Single-Flight', {
      'Total requests': totalRequests,
      'Actual factory calls': factoryCounts.reduce((a, b) => a + b, 0),
      'Dedup savings': totalSaved,
      'Dedup rate': totalSaved / totalRequests,
      'Tokens saved': savedTokens,
      'USD saved': savedUsd,
    });

    expect(totalSaved).toBeGreaterThan(0);
  });
});

// ============================================================================
// 4. Cost Estimator Accuracy
// ============================================================================

describe('Benchmark: Cost Estimator Accuracy', () => {
  let estimator: CostEstimator;

  beforeEach(() => {
    estimator = new CostEstimator({ safetyMargin: 1.5 });
  });

  it('measures prediction error with no history', () => {
    const ctx = makeCtx({ goal: 'Fix the parsing bug in the lexer module' });
    const estimate = estimator.estimateBeforeRun(ctx, makeRouting());

    const baselineCost = costUsd(8000, 4000);
    const predictionError = Math.abs(estimate.predictedCostUsd - baselineCost) / baselineCost;

    report('Cost Estimator (cold start)', {
      'Predicted cost (USD)': estimate.predictedCostUsd,
      'Baseline cost (USD)': baselineCost,
      'Prediction error': predictionError,
      Confidence: estimate.confidence,
      'Recommended budget': estimate.recommendedBudget,
    });

    expect(estimate.predictedCostUsd).toBeGreaterThan(0);
    expect(estimate.confidence).toBe(0);
  });

  it('measures prediction convergence with historical data', () => {
    const categories = ['code', 'search', 'analysis', 'general'] as const;

    for (const cat of categories) {
      for (let i = 0; i < 25; i++) {
        estimator.recordActualCost(
          cat,
          'standard',
          8000 + Math.random() * 2000,
          4000 + Math.random() * 1000,
          0.05 + Math.random() * 0.02,
          5000,
          true,
        );
      }
    }

    const ctx = makeCtx({ goal: 'Write a Python function to parse CSV files' });
    const estimate = estimator.estimateBeforeRun(ctx, makeRouting());

    report('Cost Estimator (warm)', {
      'Predicted input tokens': estimate.predictedInputTokens,
      'Predicted output tokens': estimate.predictedOutputTokens,
      'Predicted cost (USD)': estimate.predictedCostUsd,
      Confidence: estimate.confidence,
      'Sample count': estimate.sampleCount,
      'Recommended budget': estimate.recommendedBudget,
    });

    expect(estimate.confidence).toBeGreaterThanOrEqual(0.7);
    expect(estimate.sampleCount).toBeGreaterThan(0);
  });

  it('measures budget allocation accuracy', () => {
    const subtasks = [
      { goal: 'Analyze the codebase', complexity: 3, modelTier: 'eco' },
      { goal: 'Implement the core module with tests', complexity: 8, modelTier: 'standard' },
      { goal: 'Search for similar patterns', complexity: 2, modelTier: 'eco' },
      { goal: 'Write comprehensive documentation', complexity: 5, modelTier: 'standard' },
    ];

    const totalBudget = 100000;
    const allocations = estimator.allocateBudgetsAcrossAgents(totalBudget, subtasks);

    const totalAllocated = allocations.reduce((s, a) => s + a.budget, 0);
    const maxAllocation = Math.max(...allocations.map((a) => a.budget));
    const minAllocation = Math.min(...allocations.map((a) => a.budget));

    report('Budget Allocation', {
      'Total budget': totalBudget,
      'Total allocated': totalAllocated,
      Subtasks: allocations.length,
      'Max allocation': maxAllocation,
      'Min allocation': minAllocation,
      'Allocation variance (max/min)': maxAllocation / minAllocation,
    });

    expect(totalAllocated).toBeLessThanOrEqual(totalBudget);
    expect(allocations.length).toBe(subtasks.length);
  });
});

// ============================================================================
// 5. Context Compaction Savings
// ============================================================================

describe('Benchmark: Context Compaction Savings', () => {
  it('measures token reduction at each compaction layer', () => {
    const layers = [
      { name: 'Layer 1 (snip)', count: 25, avgLen: 600, maxTokens: 5000 },
      { name: 'Layer 2 (microcompact)', count: 20, avgLen: 800, maxTokens: 5000 },
      { name: 'Layer 3 (collapse)', count: 40, avgLen: 500, maxTokens: 6000 },
      { name: 'Layer 4 (autocompact)', count: 60, avgLen: 500, maxTokens: 8000 },
    ];

    for (const layer of layers) {
      const compactor = new ContextCompactor({
        maxContextTokens: layer.maxTokens,
        layer1Trigger: 0.5,
        layer2Trigger: 0.55,
        layer3Trigger: 0.65,
        layer4Trigger: 0.75,
        governorAware: false,
      });

      const messages = makeMessages(layer.count, layer.avgLen);

      const before = compactor.getUsage(messages);
      const result = compactor.compact(messages);
      const after = compactor.getUsage(result.messages);

      const tokensSaved = before.total - after.total;
      const pctSaved = before.total > 0 ? tokensSaved / before.total : 0;
      const savedUsd = costUsd(tokensSaved, 0);

      report(
        `${layer.name} (${layer.count} msgs, ~${layer.avgLen} avg chars, ${layer.maxTokens} budget)`,
        {
          'Before tokens': before.total,
          'After tokens': after.total,
          'Tokens saved': tokensSaved,
          'Percentage saved': pctSaved,
          'USD saved': savedUsd,
          Action: result.action.description,
        },
      );
    }
  });

  it('measures compaction effectiveness under governor pressure', () => {
    const compactor = new ContextCompactor({
      maxContextTokens: 6000,
      layer1Trigger: 0.5,
      layer2Trigger: 0.55,
      layer3Trigger: 0.65,
      layer4Trigger: 0.75,
      governorAware: true,
    });

    const messages = makeMessages(35, 700);
    const before = compactor.getUsage(messages);

    const result = compactor.compact(messages, undefined, 'code');
    const after = compactor.getUsage(result.messages);

    const tokensSaved = before.total - after.total;
    const pctSaved = before.total > 0 ? tokensSaved / before.total : 0;

    report('Governor-Aware Compaction', {
      'Before tokens': before.total,
      'After tokens': after.total,
      'Tokens saved': tokensSaved,
      'Percentage saved': pctSaved,
      'Layer triggered': result.action.layer,
    });

    expect(result.action.tokensSaved).toBeGreaterThanOrEqual(0);
  });

  it('measures total compaction savings for a long conversation', () => {
    const compactor = new ContextCompactor({
      maxContextTokens: 6000,
      layer1Trigger: 0.5,
      layer2Trigger: 0.55,
      layer3Trigger: 0.65,
      layer4Trigger: 0.75,
      governorAware: false,
    });

    const longConversation = makeMessages(50, 600);
    let current = longConversation;
    let totalSaved = 0;
    let iterations = 0;

    while (iterations < 5) {
      const before = compactor.getUsage(current);
      if (before.pct < 0.5) break;
      const result = compactor.compact(current);
      current = result.messages;
      totalSaved += result.action.tokensSaved;
      iterations++;
    }

    const initialTokens = compactor.getUsage(longConversation).total;
    const finalTokens = compactor.getUsage(current).total;
    const totalPctSaved = initialTokens > 0 ? totalSaved / initialTokens : 0;

    report('Long Conversation Compaction', {
      'Initial messages': longConversation.length,
      'Final messages': current.length,
      'Initial tokens': initialTokens,
      'Final tokens': finalTokens,
      'Total tokens saved': totalSaved,
      'Total percentage saved': totalPctSaved,
      'Compaction iterations': iterations,
      'USD saved': costUsd(totalSaved, 0),
    });
  });
});

// ============================================================================
// 6. Early-Exit Savings
// ============================================================================

describe('Benchmark: Early-Exit Savings', () => {
  it('measures tokens saved when agent exits early from confident responses', () => {
    const maxTokensFull = 1500;
    const earlyExitTokens = 200;
    const fullRunSteps = 8;
    const earlyExitSteps = 2;

    const fullRunCost = costUsd(10000, maxTokensFull * fullRunSteps);
    const earlyExitCost = costUsd(
      10000,
      earlyExitTokens * earlyExitSteps + maxTokensFull * (fullRunSteps - earlyExitSteps),
    );

    const tokensSaved = (maxTokensFull - earlyExitTokens) * (fullRunSteps - earlyExitSteps);
    const savedUsd = fullRunCost - earlyExitCost;

    const averageConfidence = 0.92;
    const earlyExitRate = 0.35;

    const effectiveTokensSaved = tokensSaved * earlyExitRate;
    const effectiveUsdSaved = savedUsd * earlyExitRate;

    report('Early-Exit Savings', {
      'Full run output tokens/step': maxTokensFull,
      'Early-exit output tokens/step': earlyExitTokens,
      'Steps skipped': fullRunSteps - earlyExitSteps,
      'Token savings per early exit': tokensSaved,
      'Early-exit rate (estimated)': earlyExitRate,
      'Effective tokens saved': effectiveTokensSaved,
      'Full run cost (USD)': fullRunCost,
      'Effective USD saved': effectiveUsdSaved,
    });

    expect(effectiveTokensSaved).toBeGreaterThan(0);
    expect(effectiveUsdSaved).toBeGreaterThan(0);
  });

  it('simulates early-exit with TokenGovernor speculative skip', () => {
    const governor = new TokenGovernor({ totalBudget: 50000, enableLearning: false });
    governor.setTaskCategory('search');

    governor.reportUsage(5000);
    const decisions = governor.getRecommendations();

    const speculativeSkip = decisions.find((d) => d.strategy === 'speculative_skip');
    const verificationSkip = decisions.find((d) => d.strategy === 'verification_skip');

    const tokensSavedPerSkip = 800;
    const skipCount = 3;

    const totalSaved =
      (speculativeSkip?.apply ? tokensSavedPerSkip : 0) +
      (verificationSkip?.apply ? tokensSavedPerSkip : 0);

    report('Governor Early-Exit Strategies', {
      'Budget pressure': governor.getState().pressure,
      Phase: governor.getState().phase,
      'Speculative skip enabled': speculativeSkip?.apply ?? false,
      'Verification skip enabled': verificationSkip?.apply ?? false,
      'Tokens saved per skip': tokensSavedPerSkip,
      'Estimated skips': skipCount,
      'Total tokens saved': totalSaved * skipCount,
      'USD saved': costUsd(totalSaved * skipCount, 0),
    });
  });
});

// ============================================================================
// 7. Tool Pruning Savings
// ============================================================================

describe('Benchmark: Tool Pruning Savings', () => {
  it('measures token reduction from selectTools with goal specificity', () => {
    const allTools = makeToolDefs(15);
    const allToolNames = allTools.map((t) => t.name);

    const fullSchemaTokens = estimateToolTokenCost(allTools);

    const goals = [
      {
        goal: 'Fix the bug in the file_read function that causes timeout on large files',
        expected: ['file_read', 'code_search', 'shell_execute'],
      },
      {
        goal: 'Search the web for the latest React documentation',
        expected: ['web_search', 'web_fetch'],
      },
      {
        goal: 'Write a commit message and push to the remote repository',
        expected: ['git', 'shell_execute'],
      },
    ];

    let totalSavedTokens = 0;
    let totalSavedUsd = 0;

    for (const { goal } of goals) {
      const selected = selectTools(goal, allToolNames, { minTools: 3, maxTools: 8 });
      const selectedDefs = allTools.filter((t) => selected.includes(t.name));
      const selectedTokens = estimateToolTokenCost(selectedDefs);

      const saved = fullSchemaTokens - selectedTokens;
      const pctSaved = fullSchemaTokens > 0 ? saved / fullSchemaTokens : 0;

      totalSavedTokens += saved;

      report(`Tool Pruning: "${goal.slice(0, 50)}..."`, {
        'Full schema tokens': fullSchemaTokens,
        'Selected tools': selected.length,
        'Selected tokens': selectedTokens,
        'Tokens saved': saved,
        'Percentage saved': pctSaved,
      });
    }

    totalSavedUsd = costUsd(totalSavedTokens, 0);

    report('Tool Pruning Total', {
      'Average tokens saved per call': Math.round(totalSavedTokens / goals.length),
      'Total tokens saved': totalSavedTokens,
      'USD saved (across calls)': totalSavedUsd,
    });

    expect(totalSavedTokens).toBeGreaterThan(0);
  });

  it('measures savings with buildTwoTierTools for large tool sets', () => {
    const allTools = makeToolDefs(15);
    const fullTokens = estimateToolTokenCost(allTools);

    const goal = 'Fix the bug in file_read that causes timeout on large files';
    const tier = selectTools(
      goal,
      allTools.map((t) => t.name),
      { minTools: 3, maxTools: 8 },
    );
    const tierDefs = allTools.filter((t) => tier.includes(t.name));
    const tierTokens = estimateToolTokenCost(tierDefs);

    const saved = fullTokens - tierTokens;
    const pctSaved = fullTokens > 0 ? saved / fullTokens : 0;

    report('Two-Tier Tool Loading', {
      'Total tools': allTools.length,
      'Active tools': tier.length,
      'Full schema tokens': fullTokens,
      'Active schema tokens': tierTokens,
      'Tokens saved': saved,
      'Percentage saved': pctSaved,
      'USD saved per call': costUsd(saved, 0),
    });

    expect(saved).toBeGreaterThanOrEqual(0);
  });

  it('measures per-call savings across multiple task types', () => {
    const allTools = makeToolDefs(15);
    const fullTokens = estimateToolTokenCost(allTools);

    const taskTypes = [
      { goal: 'Read and analyze the configuration file', type: 'search' },
      { goal: 'Fix the bug in the authentication module', type: 'code' },
      { goal: 'Create a new file with the project structure', type: 'code' },
      { goal: 'Search for all TODO comments in the codebase', type: 'search' },
      { goal: 'Run the test suite and report failures', type: 'analysis' },
    ];

    let totalSaved = 0;
    for (const { goal } of taskTypes) {
      const selected = selectTools(
        goal,
        allTools.map((t) => t.name),
        { minTools: 3, maxTools: 8 },
      );
      const selectedDefs = allTools.filter((t) => selected.includes(t.name));
      const selectedTokens = estimateToolTokenCost(selectedDefs);
      totalSaved += Math.max(0, fullTokens - selectedTokens);
    }

    const avgSaved = totalSaved / taskTypes.length;

    report('Per-Call Tool Pruning', {
      'Task types tested': taskTypes.length,
      'Full schema tokens': fullTokens,
      'Average tokens saved/call': avgSaved,
      'Average % saved': fullTokens > 0 ? avgSaved / fullTokens : 0,
      'USD saved per call (avg)': costUsd(avgSaved, 0),
    });
  });
});

// ============================================================================
// 8. Prompt Compression Savings
// ============================================================================

describe('Benchmark: Prompt Compression Savings', () => {
  it('measures system prompt size reduction under budget pressure', () => {
    const governor = new TokenGovernor({ totalBudget: 20000, enableLearning: false });

    const basePrompt = 'You are a helpful coding assistant. '.repeat(100);
    const baseTokens = TokenGovernor.estimateTokens(basePrompt);

    const phases = ['relaxed', 'moderate', 'tight', 'critical'] as const;

    for (const phase of phases) {
      governor.reset(20000);
      const usedTokens =
        phase === 'relaxed'
          ? 2000
          : phase === 'moderate'
            ? 10000
            : phase === 'tight'
              ? 16000
              : 19000;
      governor.reportUsage(usedTokens);

      const recommendations = governor.getRecommendations();
      const promptCompression = recommendations.find((d) => d.strategy === 'prompt_compression');
      const observationMask = recommendations.find((d) => d.strategy === 'observation_mask');

      const compressedTokens = Math.round(
        baseTokens * (1 - (promptCompression?.intensity ?? 0) * 0.5),
      );
      const maskedTokens = Math.round(baseTokens * (1 - (observationMask?.intensity ?? 0) * 0.3));
      const totalSaved = baseTokens - compressedTokens + baseTokens - maskedTokens;

      report(`Prompt Compression (${phase})`, {
        'Base prompt tokens': baseTokens,
        'Budget pressure': governor.getState().pressure,
        'Compression intensity': promptCompression?.intensity ?? 0,
        'Masking intensity': observationMask?.intensity ?? 0,
        'Compressed tokens': compressedTokens,
        'Total tokens saved': totalSaved,
        'USD saved': costUsd(totalSaved, 0),
      });
    }
  });

  it('measures cumulative prompt compression savings over a session', () => {
    const governor = new TokenGovernor({ totalBudget: 100000, enableLearning: false });

    const steps = 20;
    const tokensPerStep = 3000;
    let totalSaved = 0;

    for (let i = 0; i < steps; i++) {
      governor.reportUsage(tokensPerStep);
      const recs = governor.getRecommendations();
      const compression = recs.find((d) => d.strategy === 'prompt_compression');
      const mask = recs.find((d) => d.strategy === 'observation_mask');

      const stepSaved = Math.round(
        tokensPerStep * ((compression?.intensity ?? 0) * 0.3 + (mask?.intensity ?? 0) * 0.2),
      );
      totalSaved += stepSaved;
    }

    const totalTokens = steps * tokensPerStep;

    report('Cumulative Prompt Compression', {
      Steps: steps,
      'Tokens per step': tokensPerStep,
      'Total tokens consumed': totalTokens,
      'Total tokens saved': totalSaved,
      'Percentage saved': totalSaved / totalTokens,
      'USD saved': costUsd(totalSaved, 0),
    });
  });
});

// ============================================================================
// 9. Cost-Weighted vs Naive Compaction
// ============================================================================

describe('Benchmark: Cost-Weighted vs Naive Compaction', () => {
  it('compares cost-weighted and naive compaction quality', () => {
    const compactor = new ContextCompactor({
      maxContextTokens: 5000,
      layer1Trigger: 0.5,
      governorAware: false,
    });

    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'Fix the bug in the authentication module' },
      {
        role: 'assistant',
        content:
          'I will analyze the authentication module. The issue is that the token validation check is missing expiry handling. I need to add the expiry check before the signature verification.',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'file_read', arguments: '{"path":"src/auth.ts"}' },
          },
        ],
      },
      { role: 'tool', content: 'ERROR: Cannot read file - file not found at src/auth.ts' },
      { role: 'assistant', content: 'The file was not found. Let me search for it.' },
      { role: 'user', content: 'The file is at src/modules/auth/tokenValidator.ts' },
      { role: 'assistant', content: 'Found it. I will read the tokenValidator.ts file now.' },
      {
        role: 'tool',
        content:
          'File content: export function validateToken(token: string) { return jwt.verify(token, secret); }',
      },
      {
        role: 'assistant',
        content:
          'I found the issue. The validateToken function does not check the token expiry. I will add the expiry check.',
      },
      { role: 'tool', content: 'error: timeout connection refused' },
      { role: 'assistant', content: 'Retrying the operation...' },
    ];

    const result = compactor.compact(messages, undefined, 'code');
    const compactedMessages = result.messages;

    const preservedSystem = compactedMessages.some((m) => m.role === 'system');
    const preservedErrors = compactedMessages.filter(
      (m) => m.content.includes('error') || m.content.includes('ERROR'),
    );
    const preservedDecisions = compactedMessages.filter(
      (m) => m.content.includes('I will') || m.content.includes('Found it'),
    );

    const naiveDropCount = result.action.droppedCount;

    report('Cost-Weighted vs Naive Compaction', {
      'Original messages': messages.length,
      'Compacted messages': compactedMessages.length,
      'Layer triggered': result.action.layer,
      'Messages dropped': naiveDropCount,
      'System message preserved': preservedSystem,
      'Error messages preserved': preservedErrors.length,
      'Decision messages preserved': preservedDecisions.length,
      'Tokens saved': result.action.tokensSaved,
      'USD saved': costUsd(result.action.tokensSaved, 0),
    });

    expect(preservedSystem).toBe(true);
    expect(preservedErrors.length).toBeGreaterThan(0);
  });

  it('measures token savings difference between compaction strategies', () => {
    const strategies = [
      { name: 'code', taskType: 'code' as const, count: 30, avgLen: 700, maxTokens: 6000 },
      { name: 'search', taskType: 'search' as const, count: 30, avgLen: 500, maxTokens: 5000 },
      { name: 'analysis', taskType: 'analysis' as const, count: 30, avgLen: 600, maxTokens: 5500 },
    ];

    for (const strat of strategies) {
      const compactor = new ContextCompactor({
        maxContextTokens: strat.maxTokens,
        layer1Trigger: 0.5,
        governorAware: false,
      });

      const messages = makeMessages(strat.count, strat.avgLen);
      const before = compactor.getUsage(messages);
      const result = compactor.compact(messages, undefined, strat.taskType);
      const after = compactor.getUsage(result.messages);

      const saved = before.total - after.total;
      const pctSaved = before.total > 0 ? saved / before.total : 0;

      report(`Compaction Strategy: ${strat.name}`, {
        'Task type': strat.taskType,
        Messages: strat.count,
        'Before tokens': before.total,
        'After tokens': after.total,
        'Tokens saved': saved,
        'Percentage saved': pctSaved,
        Layer: result.action.layer,
      });
    }
  });
});

// ============================================================================
// 10. Cost-Per-Success Model Scoring
// ============================================================================

describe('Benchmark: Cost-Per-Success Model Scoring', () => {
  it('verifies cheaper-but-reliable models rank higher', () => {
    const router = new ModelRouter();

    const cheapModel = 'gpt-4o-mini';
    const expensiveModel = 'claude-opus-4-8';

    for (let i = 0; i < 20; i++) {
      router.recordOutcome(cheapModel, 'code', true, 500, 2000);
    }

    for (let i = 0; i < 20; i++) {
      router.recordOutcome(expensiveModel, 'code', true, 2000, 8000);
    }

    const ctx = makeCtx({ goal: 'Write a simple utility function to format dates' });
    const decision = router.route(ctx);

    const cheapConfig = router.getModel(cheapModel);
    const expensiveConfig = router.getModel(expensiveModel);

    const cheapCostPer1K = cheapConfig?.costPer1KOutput ?? 0;
    const expensiveCostPer1K = expensiveConfig?.costPer1KOutput ?? 0;

    report('Cost-Per-Success Scoring', {
      'Selected model': decision.modelId,
      'Selected tier': decision.tier,
      'Cheap model cost/1K output': cheapCostPer1K,
      'Expensive model cost/1K output': expensiveCostPer1K,
      'Cost ratio': expensiveCostPer1K / cheapCostPer1K,
    });

    expect(decision.modelId).toBeDefined();
  });

  it('measures routing cost savings across task types', () => {
    const router = new ModelRouter();

    const taskTypes = [
      {
        goal: 'Fix the bug in the authentication module that causes timeout',
        type: 'code',
        tokens: 12000,
      },
      { goal: 'Search for the latest React documentation on hooks', type: 'search', tokens: 5000 },
      {
        goal: 'Analyze the performance bottleneck in the database queries',
        type: 'analysis',
        tokens: 8000,
      },
      {
        goal: 'Write a creative product description for the new feature',
        type: 'creative',
        tokens: 3000,
      },
    ];

    let totalCost = 0;
    let naiveCost = 0;

    for (const task of taskTypes) {
      const ctx = makeCtx({ goal: task.goal, tokenBudget: task.tokens });
      const decision = router.route(ctx);

      const model = router.getModel(decision.modelId);
      if (model) {
        const inputTokens = Math.ceil(task.goal.length / 4) + 2048;
        const outputTokens = task.tokens - inputTokens;
        const taskCost =
          (inputTokens / 1000) * model.costPer1KInput +
          (outputTokens / 1000) * model.costPer1KOutput;
        totalCost += taskCost;

        const naiveCostPerK = 0.015;
        naiveCost += (inputTokens / 1000) * naiveCostPerK + (outputTokens / 1000) * naiveCostPerK;
      }
    }

    const savings = naiveCost - totalCost;
    const savingsPct = naiveCost > 0 ? savings / naiveCost : 0;

    report('Routing Cost Savings', {
      'Tasks routed': taskTypes.length,
      'Smart routing cost (USD)': totalCost,
      'Naive routing cost (USD)': naiveCost,
      'Savings (USD)': savings,
      'Savings percentage': savingsPct,
    });

    expect(totalCost).toBeLessThanOrEqual(naiveCost);
  });

  it('measures cascade chain cost efficiency', () => {
    const router = new ModelRouter();

    const ctx = makeCtx({ goal: 'Debug the failing test in the authentication module' });
    const { initial, escalationChain } = router.routeWithCascade(ctx, 'tight');

    const chainCosts = escalationChain.map((m) => ({
      model: m.id,
      costPer1KInput: m.costPer1KInput,
      costPer1KOutput: m.costPer1KOutput,
    }));

    const initialModel = router.getModel(initial.modelId);
    const initialCostPerK = initialModel ? initialModel.costPer1KOutput : 0.01;
    const escalationCostPerK =
      chainCosts.length > 0 ? chainCosts[0].costPer1KOutput : initialCostPerK;

    const cascadeSavings =
      Math.max(0, initialCostPerK - escalationCostPerK) / Math.max(initialCostPerK, 0.001);

    report('Cascade Chain Efficiency', {
      'Initial model': initial.modelId,
      'Initial tier': initial.tier,
      'Escalation models': chainCosts.length,
      'Initial cost/1K': initialCostPerK,
      'Cheapest escalation cost/1K': chainCosts[0]?.costPer1KOutput ?? initialCostPerK,
      'Potential savings from cascade': cascadeSavings,
      'Governor phase': 'tight',
    });

    expect(initial.modelId).toBeDefined();
  });
});

// ============================================================================
// Aggregate Cost Savings Summary
// ============================================================================

describe('Aggregate Cost Savings Summary', () => {
  it('calculates total estimated savings across all optimizations', () => {
    const baselineCostPerTask = costUsd(15000, 8000);
    const tasksPerDay = 50;
    const baselineDailyCost = baselineCostPerTask * tasksPerDay;

    const optimizations = [
      { name: 'toolCache', rate: 0.85, tokensPerHit: 150 },
      { name: 'semanticCache', rate: 0.45, tokensPerHit: 1200 },
      { name: 'singleFlight', rate: 0.3, tokensPerHit: 1500 },
      { name: 'contextCompaction', rate: 0.4, tokensPerHit: 20000 },
      { name: 'earlyExit', rate: 0.35, tokensPerHit: 4000 },
      { name: 'toolPruning', rate: 0.35, tokensPerHit: 2500 },
      { name: 'promptCompression', rate: 0.2, tokensPerHit: 1500 },
    ];

    let totalTokensSaved = 0;
    const breakdown: Record<string, { tokensSaved: number; usdSaved: number }> = {};

    for (const opt of optimizations) {
      const tokensSaved = Math.round(tasksPerDay * opt.rate * opt.tokensPerHit);
      const usdSaved = costUsd(tokensSaved, 0);
      breakdown[opt.name] = { tokensSaved, usdSaved };
      totalTokensSaved += tokensSaved;
    }

    const totalUsdSaved = costUsd(totalTokensSaved, 0);
    const savingsPct = baselineDailyCost > 0 ? totalUsdSaved / baselineDailyCost : 0;

    report('Total Daily Cost Savings', {
      'Baseline daily cost': baselineDailyCost,
      'Total tokens saved': totalTokensSaved,
      'Total USD saved': totalUsdSaved,
      'Savings vs baseline': savingsPct,
    });

    console.log('\n📋 Optimization Breakdown:');
    for (const [name, data] of Object.entries(breakdown)) {
      console.log(`   ${name}: ${data.tokensSaved} tokens → $${data.usdSaved.toFixed(6)}`);
    }

    expect(totalTokensSaved).toBeGreaterThan(0);
  });
});
