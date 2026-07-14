import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionRouter } from '../../src/runtime/executionRouter';
import type { AgentExecutionContext, RoutingDecision } from '../../src/runtime/types';
import type { ModelConfig } from '../../src/runtime/modelConfig';

// Vitest 4 + package type:module: vi.mock of named ESM imports is unreliable for
// production modules that already bind getX at import time. Prefer deps injection
// on ExecutionRouter (getPrivacyRouter / getCostEstimator) instead of module mocks.
import { ModelRouter } from '../../src/runtime/modelRouter';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
  return {
    agentId: 'agent-1',
    missionId: 'mission-1',
    goal: 'Analyze the codebase architecture and write a report',
    tokenBudget: 100000,
    availableTools: ['file_read'],
    maxSteps: 10,
    ...overrides,
  } as AgentExecutionContext;
}

function makeRouting(overrides?: Partial<RoutingDecision>): RoutingDecision {
  return {
    modelId: 'gpt-4o',
    tier: 'standard',
    provider: 'openai',
    reasoning: ['routed to standard tier'],
    estimatedCost: 0.05,
    maxTokens: 4096,
    ...overrides,
  };
}

function makeModelConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    id: 'gpt-4o',
    provider: 'openai',
    tier: 'standard',
    costPer1MInput: 2.5,
    costPer1MOutput: 10,
    capabilities: [],
    contextWindow: 128000,
    priority: 0,
    ...overrides,
  };
}

function makeRouter() {
  return {
    routeWithCascade: vi.fn(() => ({
      initial: makeRouting(),
      escalationChain: [makeModelConfig({ id: 'gpt-4o-mini' })],
    })),
    routeBatch: vi.fn(() => null),
    getModel: vi.fn(() => makeModelConfig()),
  } as any;
}

function makeGovernor() {
  return {
    getState: vi.fn(() => ({ phase: 'relaxed', usedTokens: 0 })),
  } as any;
}

function makeTracer() {
  return {
    recordDecision: vi.fn(),
  } as any;
}

function makeBus() {
  return {
    publish: vi.fn(),
  } as any;
}

function makeCostEstimator() {
  return {
    estimateBeforeRun: vi.fn(() => ({
      predictedCostUsd: 0.05,
      predictedTotalTokens: 5000,
      confidence: 0.8,
      sampleCount: 10,
      taskCategory: 'general',
      modelTier: 'standard',
    })),
  };
}

function makeDeps(overrides?: Partial<any>) {
  return {
    getSmartRouter: () => null,
    isSmartRouterActive: () => false,
    getRouter: () => makeRouter(),
    getGovernor: () => makeGovernor(),
    getProviders: () => new Map([['openai', {}]]),
    getPrivacyRouter: () => ({
      checkContent: vi.fn(async () => ({
        blocked: false,
        route: 'cloud',
        reason: '',
        matches: [],
      })),
      applyRouting: vi.fn((r: RoutingDecision) => r),
    }),
    getCostEstimator: () => makeCostEstimator(),
    ...overrides,
  };
}

function makePrivacyMock(options: {
  blocked?: boolean;
  route?: string;
  reason?: string;
  matches?: string[];
  throw?: boolean;
}) {
  return {
    checkContent: options.throw
      ? vi.fn(async () => {
          throw new Error('privacy service unavailable');
        })
      : vi.fn(async () => ({
          blocked: options.blocked ?? false,
          route: options.route ?? 'cloud',
          reason: options.reason ?? '',
          matches: options.matches ?? [],
        })),
    applyRouting: vi.fn((_r: RoutingDecision) =>
      makeRouting({ modelId: 'ollama/llama3', provider: 'ollama' }),
    ),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ExecutionRouter', () => {
  let router: ExecutionRouter;
  let deps: any;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: not batch eligible
    vi.spyOn(ModelRouter, 'isBatchEligible').mockReturnValue(false);

    deps = makeDeps();
    router = new ExecutionRouter(deps);
  });

  it('constructs with deps', () => {
    expect(router).toBeDefined();
  });

  it('returns proceed with routing data on success', async () => {
    const result = await router.route({
      ctx: makeCtx(),
      runId: 'run-1',
      bus: makeBus(),
      tracer: makeTracer(),
    });

    expect(result.status).toBe('proceed');
    if (result.status === 'proceed') {
      expect(result.routing.modelId).toBe('gpt-4o');
      expect(result.escalationChain.length).toBe(1);
      expect(result.batchRouting).toBeUndefined();
      expect(result.costEstimate).toBeDefined();
      expect(result.costEstimate.predictedCostUsd).toBe(0.05);
    }
  });

  it('uses smartRouter when available and active', async () => {
    const smartRouting = makeRouting({ modelId: 'claude-3.5-sonnet', provider: 'anthropic' });
    const smartRouter = {
      route: vi.fn(() => ({
        ...smartRouting,
        escalationChain: ['claude-3.5-haiku'],
      })),
      getModel: vi.fn(() => makeModelConfig({ id: 'claude-3.5-haiku' })),
    };
    deps = makeDeps({
      getSmartRouter: () => smartRouter,
      isSmartRouterActive: () => true,
    });
    router = new ExecutionRouter(deps);

    const result = await router.route({
      ctx: makeCtx(),
      runId: 'run-1',
      bus: makeBus(),
      tracer: makeTracer(),
    });

    expect(smartRouter.route).toHaveBeenCalled();
    if (result.status === 'proceed') {
      expect(result.routing.modelId).toBe('claude-3.5-sonnet');
    }
  });

  it('falls back to cascade router when smartRouter is not active', async () => {
    const cascadeRouter = makeRouter();
    deps = makeDeps({
      getSmartRouter: () => ({ route: vi.fn(), getModel: vi.fn() }),
      isSmartRouterActive: () => false,
      getRouter: () => cascadeRouter,
    });
    router = new ExecutionRouter(deps);

    const result = await router.route({
      ctx: makeCtx(),
      runId: 'run-1',
      bus: makeBus(),
      tracer: makeTracer(),
    });

    expect(cascadeRouter.routeWithCascade).toHaveBeenCalled();
    expect(result.status).toBe('proceed');
  });

  it('returns cancelled when privacy check blocks', async () => {
    const privacy = makePrivacyMock({
      blocked: true,
      route: 'block',
      reason: 'API key detected in goal',
      matches: ['sk-xxxx'],
    });
    deps = makeDeps({ getPrivacyRouter: () => privacy });
    router = new ExecutionRouter(deps);

    const result = await router.route({
      ctx: makeCtx({ goal: 'Analyze this API key: sk-xxxx' }),
      runId: 'run-1',
      bus: makeBus(),
      tracer: makeTracer(),
    });

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.summary).toContain('PRIVACY_BLOCKED');
      expect(result.summary).toContain('API key detected');
    }
  });

  it('overrides routing to local model when privacy detects sensitive content', async () => {
    const privacy = makePrivacyMock({
      blocked: false,
      route: 'local',
      reason: 'Internal IP detected',
      matches: ['10.0.0.1'],
    });
    deps = makeDeps({ getPrivacyRouter: () => privacy });
    router = new ExecutionRouter(deps);

    const result = await router.route({
      ctx: makeCtx({ goal: 'Check server at 10.0.0.1' }),
      runId: 'run-1',
      bus: makeBus(),
      tracer: makeTracer(),
    });

    expect(result.status).toBe('proceed');
    if (result.status === 'proceed') {
      expect(result.routing.modelId).toBe('ollama/llama3');
    }
  });

  it('proceeds with cloud routing when privacy check fails', async () => {
    const privacy = makePrivacyMock({ throw: true });
    deps = makeDeps({ getPrivacyRouter: () => privacy });
    router = new ExecutionRouter(deps);

    const result = await router.route({
      ctx: makeCtx(),
      runId: 'run-1',
      bus: makeBus(),
      tracer: makeTracer(),
    });

    expect(result.status).toBe('proceed');
  });

  it('computes batch routing when eligible', async () => {
    const batchModel = makeModelConfig({
      id: 'gpt-4o-batch',
      tier: 'standard',
      provider: 'openai',
      contextWindow: 128000,
      costPer1MInput: 1.25,
      costPer1MOutput: 5,
      maxBatchSize: 100,
    });
    const cascadeRouter = makeRouter();
    cascadeRouter.routeBatch = vi.fn(() => batchModel);
    vi.spyOn(ModelRouter, 'isBatchEligible').mockReturnValue(true);

    deps = makeDeps({ getRouter: () => cascadeRouter });
    router = new ExecutionRouter(deps);

    const result = await router.route({
      ctx: makeCtx({ goal: 'Process 1000 documents for data labeling' }),
      runId: 'run-1',
      bus: makeBus(),
      tracer: makeTracer(),
    });

    expect(result.status).toBe('proceed');
    if (result.status === 'proceed') {
      expect(result.batchRouting).toBeDefined();
      expect(result.batchRouting!.modelId).toBe('gpt-4o-batch');
    }
  });

  it('records routing decision in tracer', async () => {
    const tracer = makeTracer();
    await router.route({
      ctx: makeCtx(),
      runId: 'run-1',
      bus: makeBus(),
      tracer,
    });

    expect(tracer.recordDecision).toHaveBeenCalled();
    const decisions = tracer.recordDecision.mock.calls.map((c: any[]) => c[1]);
    expect(decisions.some((d: string) => d.includes('routed to'))).toBe(true);
    expect(decisions.some((d: string) => d.includes('cost_estimate'))).toBe(true);
  });

  it('publishes batch routing alert when batch is selected', async () => {
    const batchModel = makeModelConfig({
      id: 'gpt-4o-batch',
      maxBatchSize: 100,
    });
    const cascadeRouter = makeRouter();
    cascadeRouter.routeBatch = vi.fn(() => batchModel);
    vi.spyOn(ModelRouter, 'isBatchEligible').mockReturnValue(true);

    deps = makeDeps({ getRouter: () => cascadeRouter });
    router = new ExecutionRouter(deps);
    const bus = makeBus();

    await router.route({
      ctx: makeCtx({ goal: 'Batch process documents' }),
      runId: 'run-1',
      bus,
      tracer: makeTracer(),
    });

    const published = bus.publish.mock.calls.filter((c: any[]) => c[1] === 'runtime');
    expect(published.some((c: any[]) => c[2]?.type === 'batch_routing_selected')).toBe(true);
  });
});
