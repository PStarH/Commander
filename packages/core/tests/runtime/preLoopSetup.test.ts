import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PreLoopSetup } from '../../src/runtime/preLoopSetup';
import type { AgentExecutionContext, LLMRequest, RoutingDecision } from '../../src/runtime/types';
import type { CostEstimate } from '../../src/runtime/costEstimator';
import type { ProjectContext } from '../../src/runtime/projectContextLoader';
import { TokenGovernor } from '../../src/runtime/tokenGovernor';

vi.mock('../../src/runtime/messageBus', () => ({
  getMessageBus: vi.fn(() => ({
    publish: vi.fn(),
  })),
}));

vi.mock('../../src/runtime/executionTrace', () => ({
  getTraceRecorder: vi.fn(() => ({
    recordDecision: vi.fn(),
    startRun: vi.fn(),
    completeRun: vi.fn(),
    recordLLMCall: vi.fn(),
  })),
}));

vi.mock('../../src/runtime/toolProvisioner', () => ({
  provisionTools: vi.fn(async () => false),
}));

vi.mock('../../src/runtime/provenance', () => ({
  captureProvenance: vi.fn(() => ({})),
}));

vi.mock('../../src/logging', () => ({
  getGlobalLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../src/pluginManager', () => ({
  getHookManager: vi.fn(() => ({
    fireOnAgentStart: vi.fn(async () => undefined),
    fireBeforeLLMCall: vi.fn(async (req: LLMRequest) => req),
    fireAfterLLMCall: vi.fn(async () => undefined),
  })),
}));

describe('PreLoopSetup', () => {
  let currentGovernor: TokenGovernor;

  const makeDeps = (overrides: Record<string, unknown> = {}) => {
    const config = {
      budgetHardCapTokens: 1000,
      maxRetries: 2,
      ...(overrides.config as Record<string, unknown> | undefined),
    };

    const routing: RoutingDecision = {
      modelId: 'm1',
      provider: 'openai',
      tier: 'standard',
      reasoning: ['routed'],
      estimatedCost: 0.01,
      maxTokens: 4096,
    };

    const costEstimate: CostEstimate = {
      predictedCostUsd: 0.01,
      predictedTotalTokens: 100,
      confidence: 0.9,
      sampleCount: 1,
      taskCategory: 'general',
      modelTier: 'standard',
    };

    currentGovernor = new TokenGovernor({ totalBudget: 1000 });

    const router = { route: vi.fn(() => routing) };
    const executionRouter = {
      route: vi.fn(async () => ({
        status: 'proceed',
        routing,
        escalationChain: [],
        batchRouting: undefined,
        costEstimate,
      })),
    };
    const llmRequestBuilder = {
      build: vi.fn(() => ({
        request: {
          model: 'm1',
          messages: [{ role: 'user', content: 'test goal' }],
        } as LLMRequest,
        projectContext: undefined as ProjectContext | undefined,
      })),
    };
    const contextInjector = {
      inject: vi.fn(async () => ({ partCount: 0, content: '' })),
    };
    const checkpointingPhase = {
      checkpointStart: vi.fn(async () => undefined),
    };
    const samplesStore = {
      recordRunManifest: vi.fn(),
    };
    const circuitBreaker = {
      isAvailable: vi.fn(() => !(overrides.circuitOpen as boolean | undefined)),
    };
    const cacheManager = {
      getToolCache: vi.fn(() => ({})),
    };

    return {
      getConfig: () => config as any,
      getRouter: () => router,
      getExecutionRouter: () => executionRouter,
      getLLMRequestBuilder: () => llmRequestBuilder,
      getContextInjector: () => contextInjector,
      getCheckpointingPhase: () => checkpointingPhase,
      getSamplesStore: () => samplesStore,
      getGovernor: () => currentGovernor,
      getCircuitBreaker: () => circuitBreaker,
      getProviders: () => new Map<string, any>(),
      getTools: () => new Map<string, any>(),
      getCacheManager: () => cacheManager,
      getSmartRouterActive: () => true,
      setSmartRouterActive: vi.fn(),
      setGovernor: vi.fn((g: TokenGovernor) => {
        currentGovernor = g;
      }),
      setSlidingWindow: vi.fn(),
      setVerificationPipelineEvaluator: vi.fn(),
    };
  };

  const ctx: AgentExecutionContext = {
    agentId: 'a1',
    missionId: 'm1',
    goal: 'test goal',
    availableTools: [],
    tokenBudget: 500,
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a cancelled result when the hard budget is exceeded', async () => {
    const deps = makeDeps({ config: { budgetHardCapTokens: 100 } });
    const setup = new PreLoopSetup(deps as any);
    const result = await setup.prepare(ctx, { runId: 'r1', tenantId: undefined });

    expect('status' in result).toBe(true);
    if ('status' in result) {
      expect(result.status).toBe('cancelled');
      expect(result.summary).toContain('BUDGET_EXCEEDED');
    }
    expect(deps.getExecutionRouter().route).not.toHaveBeenCalled();
  });

  it('returns a cancelled result when the circuit breaker is open', async () => {
    const deps = makeDeps({ circuitOpen: true });
    const setup = new PreLoopSetup(deps as any);
    const result = await setup.prepare(ctx, { runId: 'r1', tenantId: undefined });

    expect('status' in result).toBe(true);
    if ('status' in result) {
      expect(result.status).toBe('cancelled');
      expect(result.summary).toContain('CIRCUIT_OPEN');
    }
    expect(deps.getExecutionRouter().route).toHaveBeenCalled();
  });

  it('returns a PreLoopSetupResult on the normal path', async () => {
    const deps = makeDeps();
    const setup = new PreLoopSetup(deps as any);
    const result = await setup.prepare(ctx, { runId: 'r1', tenantId: undefined });

    expect('status' in result).toBe(false);
    if (!('status' in result)) {
      expect(result.request).toBeDefined();
      expect(result.routing.modelId).toBe('m1');
      expect(result.escalationChain).toEqual([]);
      expect(result.costEstimate).toBeDefined();
      expect(result.taskType).toBeDefined();
      expect(result.state).toBeDefined();
      expect(result.state.runId).toBe('r1');
    }

    expect(deps.getExecutionRouter().route).toHaveBeenCalled();
    expect(deps.getLLMRequestBuilder().build).toHaveBeenCalled();
    expect(deps.getCheckpointingPhase().checkpointStart).toHaveBeenCalled();
    expect(deps.getContextInjector().inject).toHaveBeenCalled();
    // Per-run governor/sliding window are created by ExecutionContext.enter() in AgentRuntime.
    expect(deps.setGovernor).not.toHaveBeenCalled();
    expect(deps.setSlidingWindow).not.toHaveBeenCalled();
  });
});
