import { reportSilentFailure } from '../silentFailureReporter';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_TOKEN_GOVERNOR_BUDGET,
  TOOL_OUTPUT_TURN_BUDGET,
  CIRCUIT_BREAKER_THRESHOLD,
  CIRCUIT_BREAKER_RECOVERY_MS,
  VERIFICATION_FLOOR_TOKENS,
  VERIFICATION_BUDGET_TOKENS,
  MAX_REFLEXION_MEMORIES,
  MAX_TOKENS_PER_REFLEXION,
  TOOL_ORCHESTRATOR_MAX_RETRIES,
  TOOL_ORCHESTRATOR_CIRCUIT_THRESHOLD,
} from './runtimeConstants';

import type { AgentRuntimeConfig } from './types';

import { ContextCompactor } from './contextCompactor';
import { SlidingWindowOrchestrator } from './slidingWindowOrchestrator';
import { ReliabilityEngine } from './reliabilityEngine';
import { TokenGovernor } from './tokenGovernor';
import { UnifiedVerificationPipeline } from './unifiedVerification';
import { ReflexionInjector } from '../memory/reflexionInjector';
import { SamplesStore } from './samplesStore';
import { PersistentTraceStore } from './traceStore';
import { LeaseManager } from '../atr/leaseManager';
import { StepTimeoutManager } from './stepTimeoutManager';
import { ProviderFallbackChain } from './providerFallbackChain';
import { CompensationService } from './compensationService';
import { AgentInbox } from './agentInbox';
import { TeamRegistry } from './teamRegistry';
import { AgentHandoff } from './agentHandoff';
import { CacheManager } from './cacheManager';
import { ConcurrencyController } from './concurrencyController';
import { RunLifecycleManager } from './runLifecycleManager';
import { TenantManager } from './tenantManager';
import { ToolExecutionService } from './toolExecutionService';
import { ToolOutputManager } from './toolOutputManager';
import { ToolApproval } from './toolApproval';
import { ToolOrchestrator } from './toolOrchestrator';
import { CircuitBreakerRegistry } from './circuitBreakerRegistry';
import { ToolPlanner } from './toolPlanner';
import { CycleDetector } from './cycleDetector';
import { createContentScanner } from '../contentScanner';

import { getMessageBus } from './messageBus';
import { getIntentLog } from './intentLog';
import { getMetricsCollector } from './metricsCollector';
import { getGlobalLogger } from '../logging';
import { getGlobalTenantProvider } from './tenantProvider';
import { getGlobalThreeLayerMemory } from '../threeLayerMemory';
import { getTraceRecorder } from './executionTrace';
import { getConversationStore } from '../memory/conversationStore';
import { getHookManager } from '../pluginManager';
import { createParameterControllerPlugin } from './parameterController';
import { installProcessCrashHandlers } from './processCrashSafety';
import { getSecurityMonitor } from '../security/securityMonitor';
import { getOTelExporter } from './openTelemetryExporter';
import { createMemoryStore } from '../memory';

import type { StateCheckpointer } from './stateCheckpointer';
import type { DeadLetterQueue } from './deadLetterQueue';

interface ServiceInitializerConfig {
  config: AgentRuntimeConfig;
  checkpointer: StateCheckpointer;
  dlq: DeadLetterQueue;
  traceStore: PersistentTraceStore;
  getRunHandle: () => import('../atr/scheduler').RunHandle | null;
  getLedgerCtx: () => {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    tenantId?: string;
  } | null;
  getActiveRuns: () => Set<string>;
}

export interface InitializedServices {
  compactor: ContextCompactor;
  slidingWindow: SlidingWindowOrchestrator;
  reliabilityEngine: ReliabilityEngine;
  governor: TokenGovernor;
  verificationPipeline: UnifiedVerificationPipeline;
  reflexionInjector: ReflexionInjector;
  samplesStore: SamplesStore;
  leaseManager: LeaseManager;
  stepTimeout: StepTimeoutManager;
  fallbackChain: ProviderFallbackChain<import('./types').LLMResponse>;
  compensationService: CompensationService;
  agentInbox: AgentInbox;
  teamRegistry: TeamRegistry;
  agentHandoff: AgentHandoff;
  cacheManager: CacheManager;
  concurrencyController: ConcurrencyController;
  runLifecycle: RunLifecycleManager;
  tenantManager: TenantManager;
  toolExecutionService: ToolExecutionService;
  outputManager: ToolOutputManager;
  orchestrator: ToolOrchestrator;
  planner: ToolPlanner;
  cycleDetector: CycleDetector;
  contentScanner: ReturnType<typeof createContentScanner>;
  memory: import('../threeLayerMemory').ThreeLayerMemory | null;
  memoryStore: import('../memory').MemoryStore | null;
  conversationStore: import('../memory/conversationStore').ConversationStore | null;
  otelExporter: import('./openTelemetryExporter').OpenTelemetryExporter | null;
}

export function initializeServices(
  svcConfig: ServiceInitializerConfig,
  tools: Map<string, import('./types').Tool>,
): InitializedServices {
  const { config, getRunHandle, getLedgerCtx, getActiveRuns } = svcConfig;

  const compactor = new ContextCompactor({
    maxContextTokens: config.budgetHardCapTokens || DEFAULT_CONTEXT_WINDOW_TOKENS,
  });

  const slidingWindow = new SlidingWindowOrchestrator();

  const reliabilityEngine = new ReliabilityEngine({
    circuitThreshold: CIRCUIT_BREAKER_THRESHOLD,
    circuitRecoveryMs: CIRCUIT_BREAKER_RECOVERY_MS,
    circuitProviderName: 'agentRuntime',
    circuitTransitionHandler: (from, to, provider) => {
      try {
        getIntentLog(undefined).write({
          schemaVersion: 1,
          runId: 'circuit-breaker',
          capturedAt: new Date().toISOString(),
          stage: 'agentRuntime.circuit',
          decision: 'transition',
          reason: `circuit ${from}->${to}`,
          payload: { from, to, provider: provider ?? 'agentRuntime' },
        });
      } catch (err) {
        reportSilentFailure(err, 'serviceInitializer:140');
        /* best-effort */
      }
    },
  });

  const circuitBreaker = reliabilityEngine.getCircuitBreaker();
  const resolvedDlq = reliabilityEngine.getDeadLetterQueue();
  const resolvedCheckpointer = reliabilityEngine.getStateCheckpointer();

  circuitBreaker.setObservability({
    onTransition: (from, to, provider) => {
      try {
        getMetricsCollector().recordCircuitTransition(from, to, provider ?? 'agentRuntime');
      } catch (err) {
        reportSilentFailure(err, 'serviceInitializer:155');
        /* best-effort */
      }
      try {
        resolvedDlq.enqueue({
          category: 'circuit_breaker',
          operationName: 'circuit.transition',
          errorMessage: `${from}->${to}`,
          tags: [`from:${from}`, `to:${to}`, `provider:${provider ?? 'agentRuntime'}`],
          failureMode: 'circuit_open',
          failureModeNumber: 11,
        });
      } catch (err) {
        reportSilentFailure(err, 'serviceInitializer:168');
        /* best-effort */
      }
      try {
        getIntentLog(undefined).write({
          schemaVersion: 1,
          runId: 'circuit-breaker',
          capturedAt: new Date().toISOString(),
          stage: 'agentRuntime.circuit',
          decision: 'transition',
          reason: `circuit ${from}->${to}`,
          payload: { from, to, provider: provider ?? 'agentRuntime' },
        });
      } catch (err) {
        reportSilentFailure(err, 'serviceInitializer:182');
        /* best-effort */
      }
    },
  });

  circuitBreaker.setSemanticTripHandler((consecutiveFailures, reason) => {
    const bus = getMessageBus();
    bus.publish('system.alert', 'runtime', {
      type: 'semantic_circuit_trip',
      consecutiveFailures,
      reason,
    });
    try {
      resolvedDlq.enqueue({
        category: 'verification',
        operationName: 'semantic.circuit_trip',
        errorMessage: `Semantic circuit tripped after ${consecutiveFailures} consecutive verification failures: ${reason}`,
        tags: ['semantic_drift', 'verification_failure', `count:${consecutiveFailures}`],
        failureMode: 'verification',
        failureModeNumber: 7,
      });
    } catch (err) {
      reportSilentFailure(err, 'serviceInitializer:205');
      /* best-effort */
    }
    try {
      getIntentLog(undefined).write({
        schemaVersion: 1,
        runId: 'semantic-circuit-breaker',
        capturedAt: new Date().toISOString(),
        stage: 'agentRuntime.semantic',
        decision: 'trip',
        reason: `semantic circuit tripped: ${consecutiveFailures} consecutive failures`,
        payload: { consecutiveFailures, reason },
      });
    } catch (err) {
      reportSilentFailure(err, 'serviceInitializer:219');
      /* best-effort */
    }
  });

  const governor = new TokenGovernor({
    totalBudget: config.budgetHardCapTokens || DEFAULT_TOKEN_GOVERNOR_BUDGET,
  });

  const verificationPipeline = new UnifiedVerificationPipeline({
    enabled: true,
    budgetFloorTokens: VERIFICATION_FLOOR_TOKENS,
    llmVerificationBudget: VERIFICATION_BUDGET_TOKENS,
  });

  const reflexionInjector = new ReflexionInjector({
    maxReflections: MAX_REFLEXION_MEMORIES,
    maxTokensPerReflection: MAX_TOKENS_PER_REFLEXION,
  });

  const samplesStore = new SamplesStore();
  const resolvedTraceStore = new PersistentTraceStore();
  const leaseManager = new LeaseManager();
  const stepTimeout = new StepTimeoutManager();
  const fallbackChain = new ProviderFallbackChain<import('./types').LLMResponse>();

  const compensationService = new CompensationService({
    dlq: resolvedDlq,
    getRunId: () => getLedgerCtx()?.runId ?? 'unknown',
    traceStore: resolvedTraceStore,
  });

  const agentInbox = new AgentInbox();
  const teamRegistry = new TeamRegistry();
  const agentHandoff = new AgentHandoff(agentInbox, resolvedCheckpointer);

  let memory: import('../threeLayerMemory').ThreeLayerMemory | null = null;
  try {
    memory = getGlobalThreeLayerMemory();
  } catch (e) {
    getGlobalLogger().warn('AgentRuntime', 'Failed to initialize global memory', {
      error: (e as Error)?.message,
    });
  }

  try {
    getTraceRecorder(resolvedTraceStore);
  } catch (e) {
    getGlobalLogger().warn('AgentRuntime', 'Failed to initialize trace recorder', {
      error: (e as Error)?.message,
    });
  }

  let memoryStore: import('../memory').MemoryStore | null = null;
  if (config.memoryStoreType) {
    createMemoryStore(config.memoryStoreType)
      .then((store) => {
        memoryStore = store;
      })
      .catch((e) => {
        getGlobalLogger().warn('AgentRuntime', 'Failed to initialize memory store', {
          type: config.memoryStoreType,
          error: (e as Error)?.message,
        });
      });
  }

  let otelExporter: import('./openTelemetryExporter').OpenTelemetryExporter | null = null;
  if (config.otelExporter?.enabled) {
    try {
      const exporter = getOTelExporter({
        endpoint: config.otelExporter.endpoint,
        serviceName: config.otelExporter.serviceName,
        headers: config.otelExporter.headers,
      });
      exporter.start().catch((e) =>
        getGlobalLogger().warn('AgentRuntime', 'Failed to start OTel exporter', {
          error: (e as Error)?.message,
        }),
      );
      otelExporter = exporter;
    } catch (e) {
      getGlobalLogger().warn('AgentRuntime', 'Failed to initialize OTel exporter', {
        error: (e as Error)?.message,
      });
    }
  }

  const cacheManager = new CacheManager({
    semanticCache: config.semanticCache,
    singleFlight: config.singleFlight,
    geminiCache: config.geminiCache,
  });

  const concurrencyController = new ConcurrencyController(config.maxConcurrency);
  const runLifecycle = new RunLifecycleManager();
  const tenantManager = new TenantManager();

  const { ReflexionGenerator } =
    require('./reflexionGenerator') as typeof import('./reflexionGenerator');
  const reflexionGenerator = new ReflexionGenerator();
  const breakerRegistry = new CircuitBreakerRegistry();

  const toolExecutionService = new ToolExecutionService({
    tools,
    compensationService,
    cacheManager,
    dlq: resolvedDlq,
    getRunHandle,
    config,
    reflexionGenerator,
    stepTimeout,
    getPromotedTools: () => new Set<string>(),
    generateActionId: () => `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    getBreakerRegistry: () => breakerRegistry,
  });

  const outputManager = new ToolOutputManager({
    enabled: true,
    turnBudget: TOOL_OUTPUT_TURN_BUDGET,
  });

  const defaultApprovalCallback = async (req: {
    id: string;
    toolName: string;
    arguments: Record<string, unknown>;
    reason?: string;
  }) => ({
    approved: true,
    requestId: req.id,
    approvedAt: new Date().toISOString(),
    reason: 'Auto-approved',
  });

  const approvalCallback = config.approval?.approvalCallback ?? defaultApprovalCallback;
  const toolApproval = new ToolApproval(approvalCallback);

  const orchestrator = new ToolOrchestrator(
    {
      enabled: true,
      maxRetries: TOOL_ORCHESTRATOR_MAX_RETRIES,
      circuitBreakerThreshold: TOOL_ORCHESTRATOR_CIRCUIT_THRESHOLD,
      useApproval: true,
    },
    toolApproval,
    breakerRegistry,
  );

  const planner = new ToolPlanner();
  const cycleDetector = new CycleDetector();
  const contentScanner = createContentScanner();

  let conversationStore: import('../memory/conversationStore').ConversationStore | null = null;
  try {
    conversationStore = getConversationStore();
    const bus = getMessageBus();
    const store = conversationStore;
    const sessionMap = new Map<string, string>();

    bus.subscribe('agent.started', (msg) => {
      const payload = msg.payload as Record<string, unknown>;
      const runId = (payload.runId ?? payload.taskId) as string | undefined;
      const goal = payload.goal as string | undefined;
      if (!runId || !goal) return;
      store
        .startSession({
          projectId: 'default',
          agentId: msg.source,
          goal: goal || undefined,
          metadata: { runId, model: payload.model },
        })
        .then((session) => {
          sessionMap.set(runId, session.id);
          store.addTurn({ sessionId: session.id, role: 'user', content: goal }).catch(() => {});
        })
        .catch(() => {});
    });

    bus.subscribe('agent.completed', (msg) => {
      const payload = msg.payload as Record<string, unknown>;
      const runId = (payload.runId ?? payload.taskId) as string | undefined;
      const summary = payload.summary as string | undefined;
      if (!runId) return;
      const sessionId = sessionMap.get(runId);
      if (sessionId) {
        sessionMap.delete(runId);
        store
          .addTurn({ sessionId, role: 'assistant', content: (summary || '').slice(0, 5000) })
          .catch(() => {});
        store.endSession(sessionId).catch(() => {});
      }
    });

    bus.subscribe('agent.failed', (msg) => {
      const payload = msg.payload as Record<string, unknown>;
      const runId = (payload.runId ?? payload.taskId) as string | undefined;
      const error = payload.error as string | undefined;
      if (!runId) return;
      const sessionId = sessionMap.get(runId);
      if (sessionId) {
        sessionMap.delete(runId);
        store
          .addTurn({
            sessionId,
            role: 'assistant',
            content: `[Failed] ${(error || '').slice(0, 2000)}`,
          })
          .catch(() => {});
        store.endSession(sessionId).catch(() => {});
      }
    });
  } catch (e) {
    getGlobalLogger().warn('AgentRuntime', 'Failed to initialize conversation store', {
      error: (e as Error)?.message,
    });
  }

  getHookManager()
    .register(createParameterControllerPlugin())
    .catch((e) =>
      getGlobalLogger().debug('AgentRuntime', 'Hook registration', {
        error: (e as Error)?.message,
      }),
    );

  resolvedCheckpointer.setLeaseManager(leaseManager);

  installProcessCrashHandlers({
    dlq: resolvedDlq,
    leaseManager,
    activeRunIds: getActiveRuns,
    leaseTokenFor: (runId: string) => {
      return getRunHandle()?.runId === runId
        ? (getRunHandle() as import('../atr/scheduler').RunHandle)?.leaseToken
        : undefined;
    },
    fencingEpochFor: (runId: string) => {
      return getRunHandle()?.runId === runId
        ? (getRunHandle() as import('../atr/scheduler').RunHandle)?.fencingEpoch
        : undefined;
    },
    tenantIdFor: () => getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
  });

  try {
    getSecurityMonitor().start();
  } catch (err) {
    reportSilentFailure(err, 'serviceInitializer:466');
    /* best-effort */
  }

  return {
    compactor,
    slidingWindow,
    reliabilityEngine,
    governor,
    verificationPipeline,
    reflexionInjector,
    samplesStore,
    leaseManager,
    stepTimeout,
    fallbackChain,
    compensationService,
    agentInbox,
    teamRegistry,
    agentHandoff,
    cacheManager,
    concurrencyController,
    runLifecycle,
    tenantManager,
    toolExecutionService,
    outputManager,
    orchestrator,
    planner,
    cycleDetector,
    contentScanner,
    memory,
    memoryStore,
    conversationStore,
    otelExporter,
  };
}
