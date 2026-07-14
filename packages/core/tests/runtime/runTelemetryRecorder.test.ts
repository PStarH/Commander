import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunTelemetryRecorder } from '../../src/runtime/runTelemetryRecorder';
import { ThreeLayerMemory } from '../../src/threeLayerMemory';
import { MemoryManagerAgent } from '../../src/memory/memoryManagerAgent';
import type { AgentExecutionContext, TokenUsage } from '../../src/runtime/types';

vi.mock('../../src/runtime/messageBus', () => ({
  getMessageBus: vi.fn(() => ({
    publish: vi.fn(),
  })),
}));

vi.mock('../../src/runtime/executionTrace', () => ({
  getTraceRecorder: vi.fn(() => ({
    recordError: vi.fn(),
  })),
}));

vi.mock('../../src/runtime/metricsCollector', () => ({
  getMetricsCollector: vi.fn(() => ({
    recordRunComplete: vi.fn(),
  })),
}));

vi.mock('../../src/runtime/costEstimator', () => ({
  getCostEstimator: vi.fn(() => ({
    estimateCostFromUsage: vi.fn(() => 0.01),
    recordActualCost: vi.fn(),
  })),
}));

vi.mock('../../src/pluginManager', () => ({
  getHookManager: vi.fn(() => ({
    fireOnAgentComplete: vi.fn(async () => undefined),
    fireOnError: vi.fn(async () => undefined),
  })),
}));

vi.mock('../../src/intelligence/agentIntegration', () => ({
  getAgentIntelligence: vi.fn(() => ({
    postTask: vi.fn(),
  })),
}));

vi.mock('../../src/selfEvolution/metaLearner', () => ({
  getMetaLearner: vi.fn(() => ({
    recordExperience: vi.fn(),
  })),
}));

vi.mock('../../src/intelligence/failurePatterns', () => ({
  getFailurePatternLearner: vi.fn(() => ({
    recordFailure: vi.fn(),
  })),
}));

vi.mock('../../src/atr/scheduler', () => ({
  getExecutionScheduler: vi.fn(() => ({
    commitRun: vi.fn(),
  })),
}));

vi.mock('../../src/runtime/modelPerformanceStore', () => ({
  getModelPerformanceStore: vi.fn(() => ({
    record: vi.fn(),
  })),
}));

vi.mock('../../src/security/memoryPoisoningGate', () => ({
  checkMemoryPoisoning: vi.fn(() => ({ allowed: true })),
}));

vi.mock('../../src/runtime/tenantProvider', () => ({
  getGlobalTenantProvider: vi.fn(() => ({
    getCurrentTenantId: vi.fn(() => undefined),
  })),
}));

vi.mock('../../src/logging', () => ({
  getGlobalLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../src/silentFailureReporter', () => ({
  reportSilentFailure: vi.fn(),
}));

describe('RunTelemetryRecorder', () => {
  const makeCtx = (): AgentExecutionContext =>
    ({
      agentId: 'agent-a',
      projectId: 'project-p',
      missionId: 'mission-m',
      goal: 'Test goal',
      contextData: {},
      availableTools: [],
      maxSteps: 5,
      tokenBudget: 1000,
    }) as AgentExecutionContext;

  const makeTokens = (): TokenUsage => ({
    totalTokens: 10,
    promptTokens: 5,
    completionTokens: 5,
  });

  const makeRecorder = (memory: ThreeLayerMemory) => {
    return new RunTelemetryRecorder({
      getMemory: () => memory,
      getRouter: () =>
        ({
          getModel: vi.fn(() => ({
            id: 'm1',
            costPer1MInput: 3,
            costPer1MOutput: 10,
          })),
          recordOutcome: vi.fn(),
        }) as unknown as import('../../src/runtime/modelRouter').ModelRouter,
      getCircuitBreaker: () =>
        ({
          onSuccess: vi.fn(),
        }) as unknown as import('../../src/runtime/circuitBreaker').CircuitBreaker,
      getRunHandle: () => null,
      getCheckpointingPhase: () =>
        ({
          checkpointTerminal: vi.fn(async () => undefined),
        }) as unknown as import('../../src/runtime/phases/checkpointing').CheckpointingPhase,
      getMaxRetries: () => 1,
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('recordSuccess', () => {
    it('writes success telemetry to memory via observe()', async () => {
      const memory = new ThreeLayerMemory();
      memory.setMemoryManagerAgent(new MemoryManagerAgent({ retentionLimit: 10 }));
      const recorder = makeRecorder(memory);

      await recorder.recordSuccess({
        ctx: makeCtx(),
        runId: 'run-1',
        routing: {
          modelId: 'm1',
          tier: 'standard',
        } as import('../../src/runtime/types').RoutingDecision,
        taskType: 'general',
        result: { summary: 'Done' } as import('../../src/runtime/types').AgentExecutionResult,
        totalTokens: makeTokens(),
        steps: [],
        startTime: Date.now() - 100,
        tenantId: undefined,
      });

      expect(memory.getStats().totalEntries).toBeGreaterThan(0);
    });
  });

  describe('recordFailure', () => {
    it('writes failure telemetry to memory via observe()', async () => {
      const memory = new ThreeLayerMemory();
      memory.setMemoryManagerAgent(new MemoryManagerAgent({ retentionLimit: 10 }));
      const recorder = makeRecorder(memory);

      await recorder.recordFailure({
        ctx: makeCtx(),
        runId: 'run-2',
        routing: {
          modelId: 'm1',
          tier: 'standard',
        } as import('../../src/runtime/types').RoutingDecision,
        taskType: 'general',
        lastError: 'Something went wrong',
        lastErrorIsPermanent: false,
        totalTokens: makeTokens(),
        steps: [],
        startTime: Date.now() - 100,
        tenantId: undefined,
        costEstimate: {
          predictedCostUsd: 0.01,
          predictedTotalTokens: 100,
          confidence: 0.9,
          sampleCount: 1,
          taskCategory: 'general',
          modelTier: 'standard',
        },
        state: {
          totalTokenUsage: makeTokens(),
          steps: [],
          lastError: 'Something went wrong',
        } as unknown as import('../../src/runtime/phases/AgentExecutionState').AgentExecutionState,
        request: {
          model: 'm1',
          messages: [],
        } as import('../../src/runtime/types').LLMRequest,
      });

      expect(memory.getStats().totalEntries).toBeGreaterThan(0);
    });
  });
});
