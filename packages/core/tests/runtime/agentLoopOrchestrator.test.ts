import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoopOrchestrator } from '../../src/runtime/agentLoopOrchestrator';
import type {
  AgentExecutionContext,
  LLMRequest,
  LLMResponse,
  RoutingDecision,
} from '../../src/runtime/types';
import type { PreLoopSetupResult } from '../../src/runtime/preLoopSetup';
import type { AgentExecutionState } from '../../src/runtime/phases/AgentExecutionState';

vi.mock('../../src/runtime/messageBus', () => ({
  getMessageBus: vi.fn(() => ({
    publish: vi.fn(),
  })),
}));

vi.mock('../../src/runtime/executionTrace', () => ({
  getTraceRecorder: vi.fn(() => ({
    startRun: vi.fn(),
    completeRun: vi.fn(),
    recordDecision: vi.fn(),
    recordLLMCall: vi.fn(),
    recordVerification: vi.fn(),
    recordError: vi.fn(),
  })),
}));

vi.mock('../../src/runtime/determinismCapture', () => ({
  getGlobalDeterminismCapture: vi.fn(() => ({
    nextStep: vi.fn(() => 0),
    captureLLMResponse: vi.fn(),
    clearRun: vi.fn(),
  })),
}));

vi.mock('../../src/runtime/metricsCollector', () => ({
  getMetricsCollector: vi.fn(() => ({
    recordLLMCall: vi.fn(),
    recordRunComplete: vi.fn(),
    recordVerificationResult: vi.fn(),
    recordStepLatency: vi.fn(),
    recordCascadeEscalation: vi.fn(),
    recordCostByFailureMode: vi.fn(),
    recordSubAgentOutcome: vi.fn(),
    incrementCounter: vi.fn(),
    setGauge: vi.fn(),
  })),
}));

vi.mock('../../src/runtime/costEstimator', () => ({
  getCostEstimator: vi.fn(() => ({
    recordActualCost: vi.fn(),
    estimateCostFromUsage: vi.fn(() => 0.01),
    exportHistory: vi.fn(),
  })),
}));

vi.mock('../../src/pluginManager', () => ({
  getHookManager: vi.fn(() => ({
    fireBeforeLLMCall: vi.fn(async (req: LLMRequest) => req),
    fireAfterLLMCall: vi.fn(async () => undefined),
    fireOnSessionArchive: vi.fn(async () => undefined),
    fireOnAgentComplete: vi.fn(async () => undefined),
    fireOnError: vi.fn(async () => undefined),
    fireOnStepStart: vi.fn(async () => undefined),
    fireOnAgentStart: vi.fn(async () => undefined),
  })),
}));

vi.mock('../../src/hallucinationDetector', () => ({
  getHallucinationDetector: vi.fn(() => ({
    analyze: vi.fn(() => ({ recommendation: 'pass', riskScore: 0, signals: [] })),
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

vi.mock('../../src/runtime/freezeDry', () => ({
  getFreezeDryManager: vi.fn(() => ({
    setRunState: vi.fn(),
    setActiveRuns: vi.fn(),
  })),
}));

vi.mock('../../src/runtime/modelPerformanceStore', () => ({
  getModelPerformanceStore: vi.fn(() => ({
    record: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('../../src/runtime/verificationReportStore', () => ({
  getVerificationReportStore: vi.fn(() => ({
    write: vi.fn(),
  })),
}));

vi.mock('../../src/runtime/intentLog', () => ({
  getIntentLog: vi.fn(() => ({
    write: vi.fn(),
  })),
}));

vi.mock('../../src/security/memoryPoisoningGate', () => ({
  checkMemoryPoisoning: vi.fn(() => ({ allowed: true })),
}));

vi.mock('../../src/security/memoryPoisoningDefenseEngine', () => ({
  getMemoryPoisoningDefenseEngine: vi.fn(() => ({
    validateMemoryWrite: vi.fn(() => ({ allowed: true })),
  })),
}));

vi.mock('../../src/runtime/tenantProvider', () => ({
  getGlobalTenantProvider: vi.fn(() => ({
    getCurrentTenantId: vi.fn(() => undefined),
  })),
}));

describe('AgentLoopOrchestrator', () => {
  const makeRouting = (): RoutingDecision => ({
    modelId: 'm1',
    provider: 'openai',
    tier: 'standard',
    reasoning: ['routed'],
    estimatedCost: 0.01,
    maxTokens: 4096,
  });

  const makeRequest = (): LLMRequest => ({
    model: 'm1',
    messages: [{ role: 'user', content: 'test goal' }],
  });

  const makeResponse = (overrides: Partial<LLMResponse> = {}): LLMResponse =>
    ({
      model: 'm1',
      content: 'hello',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      ...overrides,
    }) as LLMResponse;

  const makeSetup = (overrides: Partial<PreLoopSetupResult> = {}): PreLoopSetupResult => {
    const state = { runId: 'r1' } as unknown as AgentExecutionState;
    return {
      request: makeRequest(),
      routing: makeRouting(),
      escalationChain: [],
      batchRouting: undefined,
      costEstimate: {
        predictedCostUsd: 0.01,
        predictedTotalTokens: 100,
        confidence: 0.9,
        sampleCount: 1,
        taskCategory: 'general',
        modelTier: 'standard',
      } as any,
      taskType: 'general' as any,
      projectContext: undefined,
      state,
      ...overrides,
    };
  };

  const makeDeps = (overrides: Record<string, unknown> = {}) => {
    const config = {
      maxRetries: 2,
      retryDelayMs: 0,
      reflexionMaxIterations: 0,
      outputFormat: 'auto',
      ...(overrides.config as Record<string, unknown> | undefined),
    };

    const router = {
      getModel: vi.fn(() => ({
        id: 'm1',
        provider: 'openai',
        tier: 'standard',
        costPer1MInput: 3,
        costPer1MOutput: 10,
      })),
      recordOutcome: vi.fn(),
      getNextEscalation: vi.fn(),
      getFallbackModel: vi.fn(),
    };

    const governor = {
      reportUsage: vi.fn(),
      getState: vi.fn(() => ({ remainingTokens: 100000 })),
      shouldApply: vi.fn(() => ({ apply: false, intensity: 0 })),
      recordOutcome: vi.fn(),
    };

    const circuitBreaker = {
      recordSemanticFailure: vi.fn(),
      recordSemanticSuccess: vi.fn(),
      onFailure: vi.fn(),
      onSuccess: vi.fn(),
    };

    const toolExecutionHandler = {
      executeStep: vi.fn(async () => ({
        response: makeResponse(),
        earlyExit: false,
        interruptData: null,
        largestFileWriteContent: '',
      })),
    };

    const toolExecutionService = {
      triggerSpeculativeExecution: vi.fn(async () => undefined),
    };

    const goalCompletionVerifier = {
      verify: vi.fn(async () => ({ isComplete: true, verificationTrace: 'ok' })),
    };

    const verificationPipeline = {
      verify: vi.fn(async () => ({
        passed: true,
        confidence: 0.9,
        signals: [],
        tokensUsed: 0,
        stagesRun: [],
      })),
      toFeedback: vi.fn(() => 'feedback'),
    };

    const contentScanner = {
      scan: vi.fn(async () => ({ isSafe: true, threats: [], riskScore: 0 })),
    };

    const checkpointingPhase = {
      checkpointAfterStep: vi.fn(async () => undefined),
      checkpointTerminal: vi.fn(async () => undefined),
    };

    const samplesStore = {
      recordVerification: vi.fn(),
    };

    const compactor = {
      recordFailureCorrelation: vi.fn(),
      getUsage: vi.fn(() => ({ total: 100 })),
      compact: vi.fn(() => ({ messages: makeRequest().messages, action: { droppedCount: 0 } })),
    };

    const cycleDetector = {
      checkOutput: vi.fn(() => ({ detected: false })),
    };

    const reflexionInjector = {
      addReflection: vi.fn(),
      getRecentReflections: vi.fn(() => []),
    };

    const reflexionGenerator = {
      generate: vi.fn(async () => ({})),
    };

    const securityOrch = {
      onAgentEvent: vi.fn(),
    };

    const runTelemetryRecorder = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(async () => ({
        runId: 'r1',
        agentId: 'a1',
        missionId: 'm1',
        status: 'failed',
        summary: 'failed',
        steps: [],
        totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        totalDurationMs: 0,
        error: 'failed',
      })),
    };

    const metricsCollector = {
      recordLLMCall: vi.fn(),
      recordRunComplete: vi.fn(),
      recordVerificationResult: vi.fn(),
      recordStepLatency: vi.fn(),
      recordCascadeEscalation: vi.fn(),
      recordCostByFailureMode: vi.fn(),
      recordSubAgentOutcome: vi.fn(),
      incrementCounter: vi.fn(),
      setGauge: vi.fn(),
    };

    const costEstimator = {
      recordActualCost: vi.fn(),
      estimateCostFromUsage: vi.fn(() => 0.01),
    };

    const hookManager = {
      fireBeforeLLMCall: vi.fn(async (req: LLMRequest) => req),
      fireAfterLLMCall: vi.fn(async () => undefined),
      fireOnSessionArchive: vi.fn(async () => undefined),
      fireOnAgentComplete: vi.fn(async () => undefined),
      fireOnError: vi.fn(async () => undefined),
      fireOnStepStart: vi.fn(async () => undefined),
      fireOnAgentStart: vi.fn(async () => undefined),
    };

    const executeTool = vi.fn(async () => ({
      toolCallId: 'tc1',
      name: 'noop',
      output: 'done',
      durationMs: 0,
    }));

    const callWithTimeout = vi.fn(async () => makeResponse());

    const deps = {
      getConfig: () => config as any,
      getProviders: () => new Map<string, any>(),
      getRouter: () => router,
      getSmartRouter: () => null,
      getGovernor: () => governor,
      getCircuitBreaker: () => circuitBreaker,
      getToolExecutionHandler: () => toolExecutionHandler,
      getToolExecutionService: () => toolExecutionService,
      getGoalCompletionVerifier: () => goalCompletionVerifier,
      getVerificationPipeline: () => verificationPipeline,
      getContentScanner: () => contentScanner,
      getMemory: () => null,
      getCheckpointingPhase: () => checkpointingPhase,
      getSamplesStore: () => samplesStore,
      getCompactor: () => compactor,
      getCycleDetector: () => cycleDetector,
      getReflexionInjector: () => reflexionInjector,
      getReflexionGenerator: () => reflexionGenerator,
      getSecurityOrch: () => securityOrch,
      getRunTelemetryRecorder: () => runTelemetryRecorder,
      getMetricsCollector: () => metricsCollector,
      getCostEstimator: () => costEstimator,
      getHookManager: () => hookManager,
      getLastProviderError: () => null,
      setLastProviderError: vi.fn(),
      setLastHallucinationDetected: vi.fn(),
      onCircuitReleased: vi.fn(),
      executeTool,
      callWithTimeout,
    };

    // Apply overrides that replace entire getters
    for (const [key, value] of Object.entries(overrides)) {
      if (key !== 'config') {
        (deps as any)[key] = value;
      }
    }

    return deps;
  };

  const ctx: AgentExecutionContext = {
    agentId: 'a1',
    missionId: 'm1',
    goal: 'test goal',
    availableTools: [],
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success for a one-turn run with no tool calls', async () => {
    const deps = makeDeps();
    const orchestrator = new AgentLoopOrchestrator(deps as any);
    const setup = makeSetup();

    const result = await orchestrator.run(
      ctx,
      { runId: 'r1', tenantId: undefined, startTime: Date.now() },
      setup,
    );

    expect(result.status).toBe('success');
    expect(result.summary).toBe('hello');
    expect(result.runId).toBe('r1');
    expect(deps.callWithTimeout).toHaveBeenCalledTimes(1);
    expect(deps.getRunTelemetryRecorder().recordSuccess).toHaveBeenCalled();
    expect(deps.onCircuitReleased).toHaveBeenCalled();
  });

  it('returns success after a tool call and propagates artifact content', async () => {
    const deps = makeDeps({
      getToolExecutionHandler: () => ({
        executeStep: vi.fn(async () => ({
          response: makeResponse({ content: 'tool result' }),
          earlyExit: false,
          interruptData: null,
          largestFileWriteContent: 'file artifact',
        })),
      }),
    });
    const orchestrator = new AgentLoopOrchestrator(deps as any);
    const setup = makeSetup();

    const result = await orchestrator.run(
      ctx,
      { runId: 'r1', tenantId: undefined, startTime: Date.now() },
      setup,
    );

    expect(result.status).toBe('success');
    expect(result.artifactContent).toBe('file artifact');
    expect(deps.executeTool).not.toHaveBeenCalled();
  });

  it('retries when verification fails and then succeeds', async () => {
    const verify = vi.fn();
    verify
      .mockResolvedValueOnce({
        passed: false,
        confidence: 0.9,
        signals: [{ type: 'incomplete' }],
        tokensUsed: 1,
        stagesRun: [],
        toFeedback: 'fix it',
      })
      .mockResolvedValueOnce({
        passed: true,
        confidence: 0.95,
        signals: [],
        tokensUsed: 0,
        stagesRun: [],
      });

    const deps = makeDeps({
      getVerificationPipeline: () => ({
        verify,
        toFeedback: vi.fn(() => 'fix it'),
      }),
    });
    const orchestrator = new AgentLoopOrchestrator(deps as any);
    const setup = makeSetup();

    const result = await orchestrator.run(
      ctx,
      { runId: 'r1', tenantId: undefined, startTime: Date.now() },
      setup,
    );

    expect(result.status).toBe('success');
    expect(deps.callWithTimeout).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('takes the early exit path when tool execution handler signals earlyExit', async () => {
    const deps = makeDeps({
      getToolExecutionHandler: () => ({
        executeStep: vi.fn(async () => ({
          response: makeResponse({ content: 'early answer' }),
          earlyExit: true,
          interruptData: null,
          largestFileWriteContent: '',
        })),
      }),
    });
    const orchestrator = new AgentLoopOrchestrator(deps as any);
    const setup = makeSetup();

    const result = await orchestrator.run(
      ctx,
      { runId: 'r1', tenantId: undefined, startTime: Date.now() },
      setup,
    );

    expect(result.status).toBe('success');
    expect(result.summary).toBe('early answer');
    expect(deps.getVerificationPipeline().verify).not.toHaveBeenCalled();
    expect(deps.getRunTelemetryRecorder().recordSuccess).not.toHaveBeenCalled();
  });

  it('propagates interruption from tool execution handler', async () => {
    const deps = makeDeps({
      getToolExecutionHandler: () => ({
        executeStep: vi.fn(async () => ({
          response: makeResponse(),
          earlyExit: false,
          interruptData: { reason: 'human_input', value: null },
          largestFileWriteContent: '',
        })),
      }),
    });
    const orchestrator = new AgentLoopOrchestrator(deps as any);
    const setup = makeSetup();

    const result = await orchestrator.run(
      ctx,
      { runId: 'r1', tenantId: undefined, startTime: Date.now() },
      setup,
    );

    expect(result.status).toBe('interrupted');
    expect(result.summary).toBe('Interrupted: human_input');
    expect(deps.getCheckpointingPhase().checkpointTerminal).toHaveBeenCalled();
  });
});
