/**
 * Agent Runtime — Core execution engine for the Commander agent loop.
 *
 * The central orchestrator that drives the LLM → Tools → Verification → Retry
 * cycle. Each call to execute() runs one full agent turn:
 *   1. Model routing (eco → standard → power)
 *   2. Tool selection & availability filtering
 *   3. LLM provider call with timeout & retry
 *   4. Tool execution with dependency-aware planning
 *   5. Verification via UnifiedVerificationPipeline
 *   6. State checkpointing (crash-safe atomic writes)
 *   7. Metrics collection & trace recording
 *
 * Integrates CircuitBreaker, TokenGovernor, ContextCompactor, CompensationRegistry,
 * DeadLetterQueue, CycleDetector, and all tool subsystems.
 */
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  AgentExecutionContext,
  AgentExecutionStep,
  AgentExecutionResult,
  AgentRuntimeConfig,
  Tool,
  ToolCall,
  ToolResult,
  ToolDefinition,
  RoutingDecision,
  TokenUsage,
  CacheConfig,
  ModelConfig,
  ModelTier,
} from './types';
import type { AgentRuntimeInterface } from './agentRuntimeInterface';
import { ModelRouter, getModelRouter } from './modelRouter';
import {
  SmartModelRouter,
  getSmartModelRouter,
  type ModelRouterUserConfig,
} from './smartModelRouter';
import { getMessageBus } from './messageBus';
import { getTraceRecorder } from './executionTrace';
import { getAnomalyDetector } from '../observability/anomalyDetector';
import { PersistentTraceStore } from './traceStore';
import { compactToolDef, compactToolDefs, getCompactConfigForTier } from './programmaticToolFormatter';
import { ContextCompactor } from './contextCompactor';
import { SlidingWindowOrchestrator } from './slidingWindowOrchestrator';
import { classifyLLMError, computeBackoff } from './llmRetry';
import { CircuitBreaker } from './circuitBreaker';
import { createParameterControllerPlugin, applyControllerParams } from './parameterController';
import {
  UnifiedVerificationPipeline,
  type UVPTaskContext,
  detectTaskType,
} from './unifiedVerification';
import { provisionTools } from './toolProvisioner';
import { TokenGovernor, type OptimizationStrategy } from './tokenGovernor';
import { SamplesStore } from './samplesStore';
import { captureProvenance } from './provenance';
import { getIntentLog } from './intentLog';
import { getVerificationReportStore } from './verificationReportStore';
import { getDeadLetterQueue } from './deadLetterQueueSingleton';
import { StateCheckpointer, type CheckpointState } from './stateCheckpointer';
import { installProcessCrashHandlers } from './processCrashSafety';
import { RunRecovery, type RunRecoveryResult } from './runRecovery';
import { StepTimeoutManager, StepTimeoutError } from './stepTimeoutManager';
import {
  ProviderFallbackChain,
  FallbackChainExhaustedError,
  type ProviderEntry,
} from './providerFallbackChain';
import { getCompensationQueue } from '../atr/compensationQueue';
import { ReflexionInjector, type ReflectionEntry } from '../memory/reflexionInjector';
import { failureModeTag, type FailureMode } from './deadLetterQueue';
import { DeadLetterQueue } from './deadLetterQueue';
import { StepErrorBoundary } from './stepErrorBoundary';
import { getMetricsCollector } from './metricsCollector';
import { CompensationRegistry, type CompensableAction } from './compensationRegistry';
import { AgentInbox } from './agentInbox';
import { TeamRegistry } from './teamRegistry';
import { AgentHandoff } from './agentHandoff';
import { getGlobalThreeLayerMemory } from '../threeLayerMemory';
import { runWithTenant } from './tenantContext';
import { getHookManager } from '../pluginManager';
import { ToolResultCache } from './toolResultCache';
import { SemanticCache } from './semanticCache';
import { SingleFlightRequestCache, type SingleFlightStats } from './singleFlightRequestCache';
import { GeminiCacheManager, type GeminiCacheStats } from './geminiCacheManager';
import {
  MockEmbeddingFunction,
  OpenAIEmbeddingFunction,
  LocalEmbeddingFunction,
} from './embedding';
import { ToolOutputManager } from './toolOutputManager';
import { ToolOrchestrator } from './toolOrchestrator';
import { ToolApproval } from './toolApproval';
import {
  selectTools,
  sortToolDefinitionsForCache,
  buildTwoTierTools,
  buildRegistrySummary,
  calculateTierMetrics,
  detectContextPromotions,
} from './toolRetriever';
import { createRequestToolTool } from '../tools/requestToolTool';
import { ToolPlanner } from './toolPlanner';
import { CycleDetector } from './cycleDetector';
import { repairToolCallArguments } from './toolCallRepair';
import {
  validateToolCall,
  formatValidationErrors,
  formatValidationErrorsJson,
} from './toolCallValidator';
import { suggestRepairsForValidationErrors } from './toolCallRepair';
import { ToolRegistry } from '../tools/toolRegistry';
import { getExecutionScheduler, type RunHandle } from '../atr/scheduler';
import { LeaseManager } from '../atr/leaseManager';
import { generateIdempotencyKey } from '../atr/canonicalJson';
import { parseStructuredOutput } from './structuredOutput';
import { isConfidentResponse } from './entropyGater';
import { InterruptError } from './interruptError';
import { createContentScanner, type ContentScanner } from '../contentScanner';
import { scanToolOutputForInjection } from '../contentScanner';
import { getPrivacyRouter } from './privacyRouter';
import type { TenantProvider, TenantConfig } from './tenantProvider';
import { generateRollbackPlan } from '../compensation/rollbackPlanner';
import type { PlannedToolCall, PlanInput } from '../compensation/rollbackPlanner';
import type { CompensationPlan } from '../compensation/external/types';
import { getGlobalTenantProvider, getGlobalMemoryRegistry } from './tenantProvider';
import { getLaneManager } from '../sandbox/lane';
import { createMemoryStore } from '../memory';
import type { MemoryStore } from '../memory';
import { CompensationEventSubscriber } from './compensationEventSubscriber';
import { getConversationStore } from '../memory/conversationStore';
import {
  OpenTelemetryExporter,
  getOTelExporter,
  executionTraceToOtlpSpans,
} from './openTelemetryExporter';
import { exportSOPFromTrace, formatSOPAsMarkdown } from './sopExport';
import type { OTelSpan } from './openTelemetryExporter';
import {
  buildSystemPrompt,
  buildCacheAwareUserPrompt,
  computePrefixCacheKey,
} from './promptBuilder';
import { loadProjectContext } from './projectContextLoader';
import { ReflexionGenerator, type Reflexion, type ReflexionContext } from './reflexionGenerator';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getGlobalLogger } from '../logging';
import type { CompactTaskType } from './contextCompactor';
import { getCostEstimator, type CostEstimate } from './costEstimator';
import { getModelPerformanceStore } from './modelPerformanceStore';
import { getGuardianAgent } from '../security/guardianAgent';
import { getSecurityMonitor } from '../security/securityMonitor';
import {
  DEFAULT_CONFIG,
  generateId,
  now,
  delay,
  descendingToolOrder,
  applyObservationMask,
  isMutationTool,
} from './runtimeHelpers';

// ============================================================================
// Tenant context resolution — extracted from execute() for clarity
// ============================================================================

interface TenantOverrides {
  origSamplesStore: SamplesStore;
  origTraceStore: PersistentTraceStore;
  origCheckpointer: StateCheckpointer;
  origMemory: import('../threeLayerMemory').ThreeLayerMemory | null;
  origGovernor: TokenGovernor;
}

interface TenantResolutionResult {
  allowed: boolean;
  error?: string;
  overrides?: TenantOverrides;
}

export class AgentRuntime implements AgentRuntimeInterface {
  private config: AgentRuntimeConfig;
  private providers: Map<string, LLMProvider> = new Map();
  private tools: Map<string, Tool> = new Map();
  private router: ModelRouter;
  private smartRouter: SmartModelRouter | null = null;
  /** When false, the smart router is bypassed and the legacy routeWithCascade path runs even if a smartRouter instance exists. Default ON. */
  private smartRouterActive: boolean = true;
  private activeRuns: Set<string> = new Set();
  private pausedRuns: Set<string> = new Set();
  private compactor: ContextCompactor;
  private slidingWindow: SlidingWindowOrchestrator;
  private circuitBreaker: CircuitBreaker;
  private verificationPipeline: UnifiedVerificationPipeline;
  private reflexionInjector: ReflexionInjector;
  private governor: TokenGovernor;
  private samplesStore: SamplesStore;
  private memory: import('../threeLayerMemory').ThreeLayerMemory | null = null;
  private traceStore: PersistentTraceStore;
  private checkpointer: StateCheckpointer;
  private dlq: DeadLetterQueue;
  private leaseManager: LeaseManager;
  private reflexionGenerator: ReflexionGenerator = new ReflexionGenerator();
  private stepTimeout: StepTimeoutManager;
  private fallbackChain: ProviderFallbackChain<import('./types').LLMResponse>;
  private lastPrefixCacheKey?: string;
  private compensationRegistry: CompensationRegistry;
  private agentInbox: AgentInbox;
  private teamRegistry: TeamRegistry;
  private agentHandoff: AgentHandoff;
  private toolCache: ToolResultCache;
  private semanticCache: SemanticCache;
  private singleFlight: SingleFlightRequestCache;
  private geminiCache: GeminiCacheManager;
  private outputManager: ToolOutputManager;
  private memoryStore: MemoryStore | null = null;
  private otelExporter: OpenTelemetryExporter | null = null;
  private orchestrator: ToolOrchestrator;
  private queueTimer: ReturnType<typeof setInterval> | null = null;
  private planner: ToolPlanner;
  private cycleDetector: CycleDetector;
  /** Tools promoted to Tier 1 (full schema) in the current turn — for hallucination rejection gate */
  private promotedTools: Set<string> = new Set();
  // Phase 3 — ExecutionScheduler handle for the currently executing run
  private runHandle: RunHandle | null = null;
  /** Tracks successful mutation tool calls per retry attempt for rollback planning */
  private executedMutations: PlannedToolCall[] = [];
  /** RunLedger transaction context (runId, leaseToken, fencingEpoch) */
  private ledgerCtx: {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    tenantId?: string;
  } | null = null;
  private compensationEventSubscriber: CompensationEventSubscriber;
  private contentScanner: ContentScanner;
  // Conversation store (FTS5-powered session persistence)
  private conversationStore: import('../memory/conversationStore').ConversationStore | null = null;
  // Concurrency semaphore (GAP-07)
  private runningCount = 0;
  private waitingQueue: Array<() => void> = [];

  // Tenant isolation
  private tenantProvider: TenantProvider;
  private tenantRateLimits: Map<string, { count: number; resetAt: number }> = new Map();
  private tenantRunningCounts: Map<string, number> = new Map();
  private tenantSamplesStores: Map<string, SamplesStore> = new Map();
  private tenantTraceStores: Map<string, PersistentTraceStore> = new Map();
  private tenantCheckpointers: Map<string, StateCheckpointer> = new Map();

  constructor(
    config?: Partial<AgentRuntimeConfig>,
    router?: ModelRouter,
    tenantProvider?: TenantProvider,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.router = router ?? getModelRouter();
    if (this.config.smartModelRouter?.enabled) {
      this.smartRouter =
        SmartModelRouter.fromEnv() ??
        new SmartModelRouter(this.config.smartModelRouter as Partial<ModelRouterUserConfig>);
    }
    this.tenantProvider = tenantProvider ?? getGlobalTenantProvider();
    this.compactor = new ContextCompactor({
      maxContextTokens: this.config.budgetHardCapTokens || 128000,
    });
    this.slidingWindow = new SlidingWindowOrchestrator();
    this.circuitBreaker = new CircuitBreaker(5, 30000);
    this.circuitBreaker.setProviderName('agentRuntime');
    this.circuitBreaker.setObservability({
      onTransition: (from, to, provider) => {
        try {
          getMetricsCollector().recordCircuitTransition(from, to, provider ?? 'agentRuntime');
        } catch {
          /* best-effort */
        }
        try {
          this.dlq.enqueue({
            category: 'circuit_breaker',
            operationName: 'circuit.transition',
            errorMessage: `${from}->${to}`,
            tags: [`from:${from}`, `to:${to}`, `provider:${provider ?? 'agentRuntime'}`],
            failureMode: 'circuit_open',
            failureModeNumber: 11,
          });
        } catch {
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
        } catch {
          /* best-effort */
        }
      },
    });
    // Wire semantic trip handler: when consecutive verification failures exceed
    // threshold, publish an alert and enqueue a dead-letter entry for operator
    // review. This enables operators to detect systemic quality degradation
    // (e.g., a model version regression) vs. isolated operational errors.
    this.circuitBreaker.setSemanticTripHandler((consecutiveFailures, reason) => {
      const bus = getMessageBus();
      bus.publish('system.alert', 'runtime', {
        type: 'semantic_circuit_trip',
        consecutiveFailures,
        reason,
      });
      try {
        this.dlq.enqueue({
          category: 'verification',
          operationName: 'semantic.circuit_trip',
          errorMessage: `Semantic circuit tripped after ${consecutiveFailures} consecutive verification failures: ${reason}`,
          tags: ['semantic_drift', 'verification_failure', `count:${consecutiveFailures}`],
          failureMode: 'verification',
          failureModeNumber: 7,
        });
      } catch {
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
      } catch {
        /* best-effort */
      }
    });
    this.governor = new TokenGovernor({ totalBudget: this.config.budgetHardCapTokens || 200000 });
    this.verificationPipeline = new UnifiedVerificationPipeline({
      enabled: true,
      budgetFloorTokens: 1500,
      llmVerificationBudget: 300,
    });
    this.verificationPipeline.setRuntime(this);
    this.reflexionInjector = new ReflexionInjector({
      maxReflections: 3,
      maxTokensPerReflection: 50,
    });
    this.samplesStore = new SamplesStore();
    this.traceStore = new PersistentTraceStore();
    this.checkpointer = new StateCheckpointer();
    this.dlq = new DeadLetterQueue();
    this.leaseManager = new LeaseManager();
    this.stepTimeout = new StepTimeoutManager();
    this.fallbackChain = new ProviderFallbackChain<import('./types').LLMResponse>();
    this.compensationRegistry = new CompensationRegistry();

    // Wire durable compensation queue for crash-safe retry
    try {
      this.compensationRegistry.setCompensationQueue(getCompensationQueue());
    } catch {
      /* queue requires better-sqlite3; skip durable retry */
    }
    this.compensationRegistry.setObservability({
      onSuccess: (action) => {
        try {
          getMetricsCollector().recordCompensation(action.toolName, 'success');
        } catch {
          /* best-effort */
        }
      },
      onFailed: (action, err) => {
        try {
          getMetricsCollector().recordCompensation(action.toolName, 'failed');
        } catch {
          /* best-effort */
        }
        try {
          getIntentLog(undefined).write({
            schemaVersion: 1,
            runId: 'compensation',
            capturedAt: new Date().toISOString(),
            stage: 'agentRuntime.compensation',
            decision: 'failed',
            reason: err.slice(0, 200),
            payload: {
              toolName: action.toolName,
              actionId: action.actionId,
              args: JSON.stringify(action.args).slice(0, 500),
            },
          });
        } catch {
          /* best-effort */
        }
      },
      onExhausted: (action, err) => {
        try {
          getMetricsCollector().recordCompensation(action.toolName, 'exhausted');
        } catch {
          /* best-effort */
        }
        try {
          this.dlq.enqueue({
            category: 'compensation',
            operationName: 'compensation.exhausted',
            errorMessage: err,
            tags: [action.toolName],
            failureMode: 'compensation_exhausted',
            failureModeNumber: 12,
          });
        } catch {
          /* best-effort */
        }
        try {
          getIntentLog(undefined).write({
            schemaVersion: 1,
            runId: 'compensation',
            capturedAt: new Date().toISOString(),
            stage: 'agentRuntime.compensation',
            decision: 'exhausted',
            reason: err.slice(0, 200),
            payload: { toolName: action.toolName, actionId: action.actionId },
          });
        } catch {
          /* best-effort */
        }
      },
    });
    this.agentInbox = new AgentInbox();
    this.teamRegistry = new TeamRegistry();
    this.agentHandoff = new AgentHandoff(this.agentInbox, this.checkpointer);
    // Register default compensation handlers for mutation tools
    this.registerDefaultCompensation();
    try {
      this.memory = getGlobalThreeLayerMemory();
    } catch (e) {
      getGlobalLogger().warn('AgentRuntime', 'Failed to initialize global memory', {
        error: (e as Error)?.message,
      });
    }
    try {
      getTraceRecorder(this.traceStore);
    } catch (e) {
      getGlobalLogger().warn('AgentRuntime', 'Failed to initialize trace recorder', {
        error: (e as Error)?.message,
      });
    }
    // Initialize memory store if configured
    if (this.config.memoryStoreType) {
      createMemoryStore(this.config.memoryStoreType)
        .then((store) => {
          this.memoryStore = store;
        })
        .catch((e) => {
          getGlobalLogger().warn('AgentRuntime', 'Failed to initialize memory store', {
            type: this.config.memoryStoreType,
            error: (e as Error)?.message,
          });
        });
    }
    // Initialize OTel exporter if configured
    if (this.config.otelExporter?.enabled) {
      try {
        const exporter = getOTelExporter({
          endpoint: this.config.otelExporter.endpoint,
          serviceName: this.config.otelExporter.serviceName,
          headers: this.config.otelExporter.headers,
        });
        exporter.start().catch((e) =>
          getGlobalLogger().warn('AgentRuntime', 'Failed to start OTel exporter', {
            error: (e as Error)?.message,
          }),
        );
        this.otelExporter = exporter;
      } catch (e) {
        getGlobalLogger().warn('AgentRuntime', 'Failed to initialize OTel exporter', {
          error: (e as Error)?.message,
        });
      }
    }
    // Tool calling infrastructure
    this.toolCache = new ToolResultCache({
      enabled: true,
      maxEntries: 512,
      defaultTtlMs: 1_800_000,
    });
    this.semanticCache = resolveSemanticCache(this.config);
    this.singleFlight = new SingleFlightRequestCache({
      enabled: this.config.singleFlight?.enabled ?? true,
      maxInFlight: this.config.singleFlight?.maxInFlight ?? 1000,
    });
    this.geminiCache = new GeminiCacheManager({
      enabled: this.config.geminiCache?.enabled ?? true,
      maxEntries: this.config.geminiCache?.maxEntries ?? 100,
      defaultTtlSeconds: this.config.geminiCache?.defaultTtlSeconds ?? 300,
      fetchTimeoutMs: this.config.geminiCache?.fetchTimeoutMs ?? 30_000,
    });
    this.outputManager = new ToolOutputManager({ enabled: true, turnBudget: 32000 });
    // ToolApproval with configurable approval callback
    // When approval is configured with a custom callback, use it; otherwise auto-approve.
    const approvalCfg = this.config.approval;
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
    const approvalCallback = approvalCfg?.approvalCallback ?? defaultApprovalCallback;
    const toolApproval = new ToolApproval(approvalCallback);
    this.orchestrator = new ToolOrchestrator(
      { enabled: true, maxRetries: 1, circuitBreakerThreshold: 3, useApproval: true },
      toolApproval,
    );
    this.planner = new ToolPlanner();
    this.cycleDetector = new CycleDetector();
    this.contentScanner = createContentScanner();

    // Initialize ConversationStore for FTS5-powered conversation persistence
    try {
      this.conversationStore = getConversationStore();

      // Wire auto-recording of conversations via bus events
      // Every agent.started → startSession(), every agent.completed/failed → endSession().
      // Uses a runId→sessionId map instead of payload mutation because bus event
      // payloads are separate objects for started/completed/failed.
      const bus = getMessageBus();
      const store = this.conversationStore;
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
            store
              .addTurn({
                sessionId: session.id,
                role: 'user',
                content: goal,
              })
              .catch(() => {});
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
            .addTurn({
              sessionId,
              role: 'assistant',
              content: (summary || '').slice(0, 5000),
            })
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

      // Lazy init — the store initializes on first access
    } catch (e) {
      getGlobalLogger().warn('AgentRuntime', 'Failed to initialize conversation store', {
        error: (e as Error)?.message,
      });
    }

    // Wire compensation event subscriber for observability logging/metrics/traces
    this.compensationEventSubscriber = new CompensationEventSubscriber();
    try {
      this.compensationEventSubscriber.start(getMessageBus(), this.traceStore);
    } catch (e) {
      getGlobalLogger().warn('AgentRuntime', 'Failed to start compensation event subscriber', {
        error: (e as Error)?.message,
      });
    }

    // Auto-register adaptive parameter controller
    // Process any due compensations from the durable queue on startup
    try {
      this.compensationRegistry
        .processQueue()
        .then((n) => {
          if (n > 0)
            getGlobalLogger().info(
              'AgentRuntime',
              `Processed ${n} queued compensations on startup`,
            );
        })
        .catch(() => {});
    } catch {
      /* best-effort */
    }

    // Schedule periodic compensation queue processing (every 5 minutes)
    this.queueTimer = setInterval(
      () => {
        try {
          this.compensationRegistry.processQueue().catch(() => {});
        } catch {
          /* best-effort */
        }
      },
      5 * 60 * 1000,
    );
    if (typeof this.queueTimer.unref === 'function') this.queueTimer.unref();

    getHookManager()
      .register(createParameterControllerPlugin())
      .catch((e) =>
        getGlobalLogger().debug('AgentRuntime', 'Hook registration', {
          error: (e as Error)?.message,
        }),
      );

    // Tier 1.2: Bind lease manager to checkpointer for run recovery validation
    this.checkpointer.setLeaseManager(this.leaseManager);

    // Tier 1.1: Install process crash handlers (uncaughtException, unhandledRejection, SIGTERM, SIGINT)
    installProcessCrashHandlers({
      dlq: this.dlq,
      leaseManager: this.leaseManager,
      activeRunIds: () => this.activeRuns,
      leaseTokenFor: (runId: string) => {
        return this.runHandle?.runId === runId
          ? (this.runHandle as RunHandle)?.leaseToken
          : undefined;
      },
      fencingEpochFor: (runId: string) => {
        return this.runHandle?.runId === runId
          ? (this.runHandle as RunHandle)?.fencingEpoch
          : undefined;
      },
      tenantIdFor: () => getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
    });

    // Start security monitoring (best-effort)
    try {
      getSecurityMonitor().start();
    } catch {
      /* best-effort */
    }
  }

  /**
   * Handle a mutation tool failure by generating a rollback plan and triggering compensation.
   * Publishes a 'tool.compensation_planned' bus event with plan metadata.
   * For safe plans, auto-executes compensation via SagaCoordinator.
   */
  private async handleMutationToolFailure(
    toolName: string,
    args: Record<string, unknown>,
    error: string,
  ): Promise<void> {
    const bus = getMessageBus();

    // Build rollback plan from mutations that occurred before this failure
    const input: PlanInput = {
      plannedCalls: this.executedMutations,
      failure: { toolName, args, error },
    };
    const plan = generateRollbackPlan(input);

    // Record each compensation step in the registry
    for (const step of plan.steps) {
      this.compensationRegistry.recordAction({
        actionId:
          step.forwardAction.actionId ??
          `comp-${step.forwardAction.toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        toolName: step.forwardAction.toolName,
        args: step.forwardAction.args,
        description: step.description,
        tags: ['tool', 'compensation', step.forwardAction.toolName],
        runId: this.ledgerCtx?.runId ?? 'unknown',
        agentId: 'system',
      });
    }

    bus.publish('tool.compensation_planned', 'runtime', {
      runId: this.ledgerCtx?.runId ?? 'unknown',
      toolName,
      stepCount: plan.steps.length,
      risk: plan.risk,
    });

    // Auto-execute safe plans immediately
    if (plan.risk === 'safe' && plan.steps.length > 0) {
      await this.compensateViaSaga(plan);
    }
  }

  /**
   * Execute a compensation plan by iterating through steps and calling
   * compensationRegistry.compensate() for each recorded action.
   */
  private async compensateViaSaga(plan: CompensationPlan): Promise<void> {
    const bus = getMessageBus();
    const totalSteps = plan.steps.length;

    // Execute each plan step sequentially using the compensation registry
    for (let stepIndex = 0; stepIndex < totalSteps; stepIndex++) {
      const step = plan.steps[stepIndex];
      const actionId = step.forwardAction.actionId;
      if (!actionId) continue;

      const stepPayload = {
        runId: this.ledgerCtx?.runId ?? 'unknown',
        toolName: step.forwardAction.toolName,
        actionId,
        stepIndex,
        totalSteps,
      };

      bus.publish('tool.compensation_step', 'runtime', {
        ...stepPayload,
        status: 'started' as const,
      });

      try {
        const STEP_TIMEOUT_MS = 30_000;
        const MAX_ATTEMPTS = 3;
        let lastError: string | undefined;
        let lastResult: { success: boolean; error?: string } | undefined;
        let successfulAttempt = 0;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const ac = new AbortController();
          const timeoutId = setTimeout(() => ac.abort(), STEP_TIMEOUT_MS);
          const compensationPromise = this.compensationRegistry
            .compensate(actionId)
            .finally(() => clearTimeout(timeoutId));
          try {
            const result = await Promise.race<
              { success: boolean; error?: string } | { _aborted: true; reason: string }
            >([
              compensationPromise,
              new Promise<{ _aborted: true; reason: string }>((resolve) => {
                ac.signal.addEventListener('abort', () =>
                  resolve({ _aborted: true, reason: 'compensation_timeout' }),
                );
              }),
            ]);
            if ('_aborted' in result) {
              lastError = `Compensation timed out after ${STEP_TIMEOUT_MS}ms`;
            } else {
              lastResult = result;
              if (result.success) {
                successfulAttempt = attempt;
                break;
              }
              lastError = result.error;
            }
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
          }
          // Drain the dangling compensation promise after the race outcome is captured
          // so late resolve/reject is consumed without leaking an unhandled rejection.
          await compensationPromise.catch(() => undefined);
          if (attempt < MAX_ATTEMPTS) {
            const backoffMs = 200 * Math.pow(2, attempt - 1); // 200, 400, 800
            await new Promise<void>((r) => setTimeout(r, backoffMs));
          }
        }
        const finalAttempt = successfulAttempt > 0 ? successfulAttempt : MAX_ATTEMPTS;
        if (lastResult?.success) {
          bus.publish('tool.compensation_step', 'runtime', {
            ...stepPayload,
            status: 'completed' as const,
            attempt: finalAttempt,
          });
        } else {
          bus.publish('tool.compensation_step', 'runtime', {
            ...stepPayload,
            status: 'failed' as const,
            error: lastError,
            attempt: finalAttempt,
          });
          getGlobalLogger().debug('AgentRuntime', 'Compensation step failed', {
            actionId,
            toolName: step.forwardAction.toolName,
            error: lastError,
            attempt: finalAttempt,
          });
          try {
            this.dlq.enqueue({
              category: 'compensation',
              operationName: 'compensation.exhausted',
              errorMessage: lastError ?? 'unknown',
              tags: [step.forwardAction.toolName, `attempt:${finalAttempt}`],
              failureMode: 'compensation_exhausted',
              failureModeNumber: 12,
            });
          } catch { /* best-effort */ }
        }
      }
      catch (err) {
        // Surface as system.alert (visibly visible in dashboards) AND debug-log
        // for forensics. Re-throw so callers can detect partial-failure rather
        // than proceed as if rollback succeeded silently.
        try {
          bus.publish('system.alert', 'runtime', {
            type: 'compensation_saga_threw',
            error: err instanceof Error ? err.message : String(err),
            totalSteps,
            runId: this.ledgerCtx?.runId ?? 'unknown',
          });
        } catch { /* best-effort */ }
        getGlobalLogger().debug('AgentRuntime', 'Compensation via saga threw unexpectedly', {
          error: err instanceof Error ? err.message : String(err),
          totalSteps,
          runId: this.ledgerCtx?.runId ?? 'unknown',
        });
        throw err;
      }
    }
  }

  /** Invalidate read caches after mutation tools succeed */
  private invalidateMutationCache(toolName: string): void {
    if (toolName.startsWith('file_')) {
      this.toolCache.invalidatePattern('file_read');
    } else if (toolName.startsWith('memory_')) {
      this.toolCache.invalidatePattern('memory_recall');
      this.toolCache.invalidatePattern('memory_list');
    } else if (toolName === 'git_push' || toolName === 'git_commit') {
      this.toolCache.invalidateTool('git');
    } else if (toolName === 'shell_execute' || toolName === 'python_execute') {
      // Shell commands may mutate filesystem; invalidate file_read broadly
      this.toolCache.invalidatePattern('file_read');
    }
  }

  /**
   * Check if the same tool+args pattern appears ≥3 times in recent calls.
   * Uses stable (alphabetically-sorted) JSON.stringify for deterministic keys.
   * On detection, publishes system.alert, increments metrics, and writes intent log.
   * Returns { retryLoopDetected, count } — caller should break the execution loop.
   */
  private checkRetryLoop(
    toolName: string,
    args: Record<string, unknown>,
    patterns: string[],
    runId: string,
    tenantId: string | undefined,
    toolLoopCount: number,
  ): { detected: boolean; count: number } {
    // Stable key ordering: sort object keys so {a:1,b:2} and {b:2,a:1} match.
    const canonicalArgs = JSON.stringify(args, [...Object.keys(args)].sort());
    const pattern = `${toolName}:${canonicalArgs}`;
    patterns.push(pattern);
    if (patterns.length > 20) patterns.shift();
    const count = patterns.filter((p) => p === pattern).length;
    if (count >= 3) {
      const bus = getMessageBus();
      bus.publish('system.alert', 'runtime', {
        type: 'retry_loop_detected',
        toolName,
        pattern: `${toolName}:${canonicalArgs.slice(0, 200)}`,
        consecutiveCalls: count,
        toolLoopCount,
      });
      try {
        getMetricsCollector().incrementCounter(
          'retry_loops_detected_total',
          'Retry loops detected',
          1,
          [{ name: 'tool', value: toolName }],
        );
      } catch {
        /* best-effort */
      }
      try {
        getIntentLog(tenantId).write({
          schemaVersion: 1,
          runId,
          capturedAt: new Date().toISOString(),
          stage: 'agentRuntime.tool_loop',
          decision: 'retry_loop_detected',
          reason: `${toolName} called ${count} times with identical arguments`,
          payload: { toolName, calls: count, toolLoopCount },
        });
      } catch {
        /* best-effort */
      }
      return { detected: true, count };
    }
    return { detected: false, count: 0 };
  }

  registerProvider(name: string, provider: LLMProvider): void {
    this.providers.set(name, provider);
  }

  registerTool(name: string, tool: Tool): void {
    this.tools.set(name, tool);
  }

  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  getSmartRouter(): SmartModelRouter | null {
    return this.smartRouter;
  }

  /**
   * Live toggle for SmartModelRouter participation. When false, the runtime
   * falls back to the legacy `routeWithCascade` path even if a smart router
   * instance exists. Default ON at construction. Idempotent.
   */
  setSmartModelRouterEnabled(enabled: boolean): void {
    this.smartRouterActive = enabled;
  }

  /** Current state of the SmartModelRouter toggle (for diagnostics). */
  isSmartModelRouterEnabled(): boolean {
    return this.smartRouterActive;
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getConfig(): AgentRuntimeConfig {
    return { ...this.config };
  }

  /** Access the persistent memory store (SqliteMemoryStore, JsonMemoryStore, etc.) or null if using default in-memory. */
  getMemoryStore(): MemoryStore | null {
    return this.memoryStore;
  }

  /** Access the state checkpointer for crash recovery and run inspection. */
  getCheckpointer(): StateCheckpointer {
    return this.checkpointer;
  }

  getInbox(): AgentInbox {
    return this.agentInbox;
  }
  getTeamRegistry(): TeamRegistry {
    return this.teamRegistry;
  }
  getHandoff(): AgentHandoff {
    return this.agentHandoff;
  }
  getExecutionScheduler() {
    return getExecutionScheduler();
  }
  getCompensationRegistry(): CompensationRegistry {
    return this.compensationRegistry;
  }

  /** Cancel all in-flight steps managed by the StepTimeoutManager.
   *  Used during graceful shutdown to abort hung tool executions. */
  cancelAllSteps(): number {
    return this.stepTimeout.cancelAll();
  }

  /** Access the step timeout manager for shutdown coordination. */
  getStepTimeoutManager(): StepTimeoutManager {
    return this.stepTimeout;
  }

  /**
   * Resolve tenant context: enforce rate limits, concurrency limits, and set up
   * tenant-scoped storage instances. Returns overrides that must be restored in finally.
   */
  private resolveTenantContext(
    tenantId: string | undefined,
    tenantCfg: TenantConfig | undefined,
    runId: string,
    agentId: string,
    missionId?: string,
  ): TenantResolutionResult {
    if (!tenantId || !tenantCfg?.enabled) {
      return { allowed: true };
    }

    // Enforce per-tenant rate limit
    if (tenantCfg.maxRunsPerMinute > 0) {
      if (this.tenantRateLimits.size > 100) {
        const now = Date.now();
        for (const [tid, entry] of this.tenantRateLimits) {
          if (now > entry.resetAt) this.tenantRateLimits.delete(tid);
        }
      }
      const rateEntry = this.tenantRateLimits.get(tenantId);
      const now = Date.now();
      if (rateEntry && now < rateEntry.resetAt && rateEntry.count >= tenantCfg.maxRunsPerMinute) {
        return {
          allowed: false,
          error: 'TENANT_RATE_LIMIT: too many runs per minute',
        };
      }
      if (!rateEntry || now > rateEntry.resetAt) {
        this.tenantRateLimits.set(tenantId, { count: 1, resetAt: now + 60_000 });
      } else {
        rateEntry.count++;
      }
    }

    // Enforce per-tenant concurrency limit
    if (tenantCfg.maxConcurrency > 0) {
      const current = this.tenantRunningCounts.get(tenantId) ?? 0;
      if (current >= tenantCfg.maxConcurrency) {
        return {
          allowed: false,
          error: 'TENANT_CONCURRENCY_LIMIT: too many concurrent runs',
        };
      }
      this.tenantRunningCounts.set(tenantId, current + 1);
    }

    // Save original values for restore
    const overrides: TenantOverrides = {
      origSamplesStore: this.samplesStore,
      origTraceStore: this.traceStore,
      origCheckpointer: this.checkpointer,
      origMemory: this.memory,
      origGovernor: this.governor,
    };

    // Evict oldest tenant stores if too many accumulate
    const MAX_TENANT_STORES = 50;
    if (
      this.tenantSamplesStores.size >= MAX_TENANT_STORES &&
      !this.tenantSamplesStores.has(tenantId)
    ) {
      const oldestKey = this.tenantSamplesStores.keys().next().value;
      if (oldestKey) {
        this.tenantSamplesStores.delete(oldestKey);
        this.tenantTraceStores.delete(oldestKey);
        this.tenantCheckpointers.delete(oldestKey);
      }
    }
    if (!this.tenantSamplesStores.has(tenantId)) {
      this.tenantSamplesStores.set(tenantId, new SamplesStore(undefined, tenantId));
    }
    if (!this.tenantTraceStores.has(tenantId)) {
      this.tenantTraceStores.set(tenantId, new PersistentTraceStore(undefined, tenantId));
    }
    if (!this.tenantCheckpointers.has(tenantId)) {
      this.tenantCheckpointers.set(tenantId, new StateCheckpointer(undefined, tenantId));
    }
    this.samplesStore = this.tenantSamplesStores.get(tenantId)!;
    this.traceStore = this.tenantTraceStores.get(tenantId)!;
    this.checkpointer = this.tenantCheckpointers.get(tenantId)!;
    this.memory = getGlobalMemoryRegistry().getOrCreate(tenantId);

    return { allowed: true, overrides };
  }

  /**
   * Restore tenant overrides after run completes or fails.
   */
  private restoreTenantOverrides(
    overrides: TenantOverrides | undefined,
    tenantId: string | undefined,
  ): void {
    if (!overrides) return;
    this.samplesStore = overrides.origSamplesStore;
    this.traceStore = overrides.origTraceStore;
    this.checkpointer = overrides.origCheckpointer;
    this.memory = overrides.origMemory;
    this.governor = overrides.origGovernor;
  }

  /**
   * Execute an agent task end-to-end.
   * Wraps entire body in try/finally to guarantee cleanup (GAP-02, GAP-05).
   * Enforces maxConcurrency via semaphore (GAP-07).
   */
  async execute(ctx: AgentExecutionContext): Promise<AgentExecutionResult> {
    await this.acquireSlot();

    const runId = generateId();
    const bus = getMessageBus();
    const tracer = getTraceRecorder();
    const startTime = Date.now();

    const tenantId = getGlobalTenantProvider().getCurrentTenantId() ?? ctx.tenantId ?? undefined;
    const tenantCfg = tenantId ? this.tenantProvider.getTenantConfig(tenantId) : undefined;

    const tenantResolution = this.resolveTenantContext(
      tenantId,
      tenantCfg,
      runId,
      ctx.agentId,
      ctx.missionId,
    );
    if (!tenantResolution.allowed) {
      this.releaseSlot();
      return {
        runId,
        agentId: ctx.agentId,
        missionId: ctx.missionId,
        status: 'failed',
        summary: tenantResolution.error!,
        steps: [],
        totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        totalDurationMs: 0,
        error: tenantResolution.error!,
      };
    }
    const tenantOverrides = tenantResolution.overrides;

    // Execution Lane: acquire a lane slot (concurrent execution isolation)
    let currentLane: string;
    try {
      currentLane = await getLaneManager().acquireSlot({
        tenantId: getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
        agentId: ctx.agentId,
        runId,
        args: ctx.lane ? { lane: ctx.lane } : undefined,
      });
    } catch {
      // Decrement tenant running count on lane acquisition failure
      if (tenantId && tenantCfg?.enabled) {
        const c = (this.tenantRunningCounts.get(tenantId) ?? 1) - 1;
        if (c <= 0) this.tenantRunningCounts.delete(tenantId);
        else this.tenantRunningCounts.set(tenantId, c);
      }
      this.releaseSlot();
      return {
        runId,
        agentId: ctx.agentId,
        missionId: ctx.missionId,
        status: 'failed',
        summary: 'Failed to acquire lane slot',
        steps: [],
        totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        totalDurationMs: 0,
        error: 'LANE_ACQUISITION_FAILED',
      };
    }

    this.activeRuns.add(runId);
    tracer.startRun(runId, ctx.agentId, ctx.missionId, undefined, {
      tenantId: ctx.tenantId,
      parentRunId: ctx.parentRunId,
      subAgentDepth: ctx.subAgentDepth,
      subAgentRole: ctx.subAgentRole,
    });
    try {
      getIntentLog(ctx.tenantId).write({
        schemaVersion: 1,
        runId,
        capturedAt: new Date().toISOString(),
        stage: 'agentRuntime.execute',
        decision: 'start',
        reason: 'execute() entered',
        payload: {
          agentId: ctx.agentId,
          goal: ctx.goal.slice(0, 200),
          parentRunId: ctx.parentRunId,
          subAgentDepth: ctx.subAgentDepth,
        },
      });
    } catch {
      /* best-effort */
    }
    getMetricsCollector().setGauge('active_runs', 'Active concurrent runs', this.activeRuns.size);
    let circuitReleased = false;

    // Phase 3: register this run with the centralized ExecutionScheduler
    try {
      this.runHandle = getExecutionScheduler().beginRun({
        runId,
        goal: ctx.goal,
        tenantId: getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
        metadata: { agentId: ctx.agentId, missionId: ctx.missionId },
        holder: 'agent-runtime',
      });
    } catch (e) {
      getGlobalLogger().warn('AgentRuntime', 'Failed to register run with execution scheduler', {
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        runId,
        agentId: ctx.agentId,
        missionId: ctx.missionId,
        status: 'failed',
        summary: 'Failed to register run with execution scheduler',
        steps: [],
        totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        totalDurationMs: 0,
        error: 'SCHEDULER_REGISTRATION_FAILED',
      };
    }

    let execResult: AgentExecutionResult | undefined;
    try {
      execResult = await runWithTenant(
        getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
        async () => {
          // ── Late-stage override — lift CLI-provided routing hints from
          //    contextData into top-level ctx fields so the routing block,
          //    samplesStore manifest, smart router, and tracer all see them.
          //    Without this lift, --model/--tier flags injected into
          //    contextData never reach `ctx.preferredModel` /
          //    `ctx.preferredModelTier` which is what every downstream
          //    consumer reads. (Audit P0-2 follow-up.)
          const cd = (
            ctx as unknown as { contextData?: Record<string, unknown> }
          ).contextData;
          if (cd?.preferredModel && typeof cd.preferredModel === 'string') {
            (
              ctx as unknown as { preferredModel?: string }
            ).preferredModel = cd.preferredModel;
          }
          if (cd?.preferredModelTier && typeof cd.preferredModelTier === 'string') {
            (
              ctx as unknown as { preferredModelTier?: ModelTier }
            ).preferredModelTier = cd.preferredModelTier as ModelTier;
          }
          if (cd?.cascadeEnabled === true) {
            this.smartRouterActive = true;
          } else if (cd?.cascadeEnabled === false) {
            this.smartRouterActive = false;
          }
          // qualityThreshold is applied via orchestrator.setQualityGateThreshold()
          // before execute() — not here, because the orchestrator owns the gate
          // config and is constructed at the CLI layer.

          // Record run manifest (provenance, config, params)
          this.samplesStore.recordRunManifest(runId, {
            ...captureProvenance(),
            agentId: ctx.agentId,
            missionId: ctx.missionId,
            goal: ctx.goal.slice(0, 500),
            tokenBudget: ctx.tokenBudget,
            availableTools: ctx.availableTools,
            modelId: this.router.route(ctx, undefined, ctx.preferredModelTier).modelId,
            config: { ...this.config },
            timestamp: new Date().toISOString(),
          });

          // Per-run governor to prevent concurrent run corruption (was shared instance)
          this.governor = new TokenGovernor({
            totalBudget: ctx.tokenBudget || this.config.budgetHardCapTokens || 200000,
          });
          // Detect task type for strategy selection
          const taskType = detectTaskType(ctx.goal);
          this.governor.setTaskCategory(
            taskType === 'code'
              ? 'code'
              : taskType === 'search'
                ? 'search'
                : taskType === 'analysis'
                  ? 'analysis'
                  : taskType === 'structured'
                    ? 'structured'
                    : 'general',
          );

          // 0. Pre-execution budget check (hard enforcement, not advisory)
          if (
            this.config.budgetHardCapTokens > 0 &&
            ctx.tokenBudget > this.config.budgetHardCapTokens
          ) {
            const msg = `BUDGET_EXCEEDED: requested ${ctx.tokenBudget} > hard cap ${this.config.budgetHardCapTokens}`;
            tracer.recordDecision(runId, msg, 0);
            bus.publish('agent.failed', ctx.agentId, { runId, error: msg });
            return {
              runId,
              agentId: ctx.agentId,
              missionId: ctx.missionId,
              status: 'cancelled',
              summary: msg,
              steps: [],
              totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              totalDurationMs: 0,
              error: msg,
            };
          }

          // 1. Route to optimal model with FrugalGPT cascade awareness
          //    In tight/critical budget: start with cheapest model, escalate on failure
          //    In relaxed/moderate: start with optimal model (standard routing)
          let routing: RoutingDecision;
          let currentEscalationChain: ModelConfig[];

          if (this.smartRouter && this.smartRouterActive) {
            const smartResult = this.smartRouter.route(ctx, {
              governorPhase: this.governor.getState().phase,
              registeredProviders: new Set(this.providers.keys()),
              preferredTier: ctx.preferredModelTier,
            });
            routing = smartResult;
            currentEscalationChain = (smartResult.escalationChain ?? []).map(
              (id) =>
                this.router.getModel(id) ?? {
                  id,
                  provider: 'unknown',
                  tier: 'standard' as ModelTier,
                  costPer1KInput: 0,
                  costPer1KOutput: 0,
                  capabilities: [],
                  contextWindow: 128000,
                  priority: 0,
                },
            );
          } else {
            const { initial: cascadeInitial, escalationChain } = this.router.routeWithCascade(
              ctx,
              this.governor.getState().phase,
              ctx.preferredModelTier,
            );
            routing = cascadeInitial;
            currentEscalationChain = escalationChain;
          }

          // P0-4: Batch API routing for non-time-sensitive tasks (50% cost savings).
          // OpenAI, Anthropic, and Google all offer batch at 50% discount for tasks
          // that can tolerate 24h turnaround. Eligible tasks: evaluation runs, data
          // labeling, document processing, nightly analysis, embedding backfills.
          // Not eligible: interactive chat, real-time code fixes, sequential
          // multi-turn tool chains requiring immediate feedback.
          let batchRouting: import('./types').RoutingDecision | undefined;
          if (ModelRouter.isBatchEligible(ctx) && this.governor.getState().phase !== 'critical') {
            const batchModel = this.router.routeBatch(ctx, routing.tier);
            if (batchModel) {
              const estimatedInputTokens = Math.ceil(ctx.goal.length / 4) + 2048;
              const estimatedOutputTokens = Math.min(
                ctx.tokenBudget,
                batchModel.contextWindow - estimatedInputTokens,
              );
              batchRouting = {
                modelId: batchModel.id,
                tier: batchModel.tier,
                provider: batchModel.provider,
                reasoning: [
                  ...routing.reasoning,
                  `batch_api: 50% cost savings via ${batchModel.provider}/${batchModel.id}`,
                  `batch_max_batch_size: ${batchModel.maxBatchSize ?? 'unlimited'}`,
                ],
                estimatedCost:
                  (estimatedInputTokens / 1000) * batchModel.costPer1KInput +
                  (estimatedOutputTokens / 1000) * batchModel.costPer1KOutput,
                maxTokens: Math.min(estimatedOutputTokens, 200000),
              };
              tracer.recordDecision(
                runId,
                `batch_routing: ${batchModel.id} (${batchModel.tier}) — 50% cost savings via batch API`,
                0,
              );
              bus.publish('system.alert', 'runtime', {
                type: 'batch_routing_selected',
                model: batchModel.id,
                provider: batchModel.provider,
                tier: batchModel.tier,
                estimatedSavings: `${Math.round(batchRouting.estimatedCost * 100) / 100}`,
              });
              try {
                getMetricsCollector().incrementCounter(
                  'batch_routing_total',
                  'Batch API routing selections',
                  1,
                  [
                    { name: 'provider', value: batchModel.provider },
                    { name: 'tier', value: batchModel.tier },
                  ],
                );
              } catch {
                /* best-effort */
              }
              try {
                getIntentLog(ctx.tenantId).write({
                  schemaVersion: 1,
                  runId,
                  capturedAt: new Date().toISOString(),
                  stage: 'agentRuntime.batch',
                  decision: 'batch_routing',
                  reason: `Batch API selected: ${batchModel.id} (${batchModel.tier}) for 50% savings`,
                  payload: {
                    model: batchModel.id,
                    provider: batchModel.provider,
                    tier: batchModel.tier,
                    estimatedCost: batchRouting.estimatedCost,
                  },
                });
              } catch {
                /* best-effort */
              }
            }
          }

          tracer.recordDecision(
            runId,
            `routed to ${routing.modelId} (${routing.tier}) cascade=${currentEscalationChain.length > 0}${batchRouting ? ' [BATCH]' : ''}`,
            0,
          );

          // ── Privacy Routing ────────────────────────────────────────────────
          // Before sending anything to a cloud provider, scan the user's goal for
          // sensitive content (API keys, internal IPs, PII, secrets). If found,
          // either block execution or re-route to a local model (Ollama/vLLM).
          // This is the Local-First Fallback pattern for enterprise compliance.
          try {
            const privacy = getPrivacyRouter();
            const decision = await privacy.checkContent(ctx.goal, {
              agentId: ctx.agentId,
              runId,
            });

            if (decision.blocked) {
              // Critical secrets detected — abort execution entirely
              const summary = `PRIVACY_BLOCKED: ${decision.reason}`;
              tracer.recordDecision(runId, summary, 0);
              bus.publish('agent.failed', ctx.agentId, { runId, error: summary });
              try {
                getMetricsCollector().incrementCounter(
                  'privacy_blocks_total',
                  'Privacy blocks',
                  1,
                  [],
                );
              } catch {
                /* best-effort */
              }
              return {
                runId,
                agentId: ctx.agentId,
                missionId: ctx.missionId,
                status: 'cancelled',
                summary,
                steps: [],
                totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                totalDurationMs: 0,
                error: summary,
              };
            }

            if (decision.route === 'local') {
              // Sensitive content detected — override routing to use a local model
              const origModel = routing.modelId;
              routing = privacy.applyRouting(routing, decision);
              tracer.recordDecision(
                runId,
                `privacy_routing: ${origModel} → ${routing.modelId} (${routing.provider}) — ${decision.reason}`,
                0,
              );
              bus.publish('system.alert', 'runtime', {
                type: 'privacy_routing_local',
                originalModel: origModel,
                routedModel: routing.modelId,
                provider: routing.provider,
                matchCount: decision.matches.length,
              });
              try {
                getMetricsCollector().incrementCounter(
                  'privacy_routes_local_total',
                  'Privacy routes to local model',
                  1,
                  [],
                );
              } catch {
                /* best-effort */
              }
            }
          } catch (e) {
            getGlobalLogger().warn('AgentRuntime', 'Privacy check failed', {
              error: (e as Error)?.message,
            });
            // Best-effort: proceed with cloud routing on privacy check failure
          }

          // 1a. Pre-run cost estimation: predict cost and log for observability
          const costEstimator = getCostEstimator();
          const costEstimate: CostEstimate = costEstimator.estimateBeforeRun(
            ctx,
            routing,
            this.router.getModel(routing.modelId),
          );
          tracer.recordDecision(
            runId,
            `cost_estimate: $${costEstimate.predictedCostUsd} (${costEstimate.predictedTotalTokens}t, confidence=${(costEstimate.confidence * 100).toFixed(0)}%, samples=${costEstimate.sampleCount})`,
            0,
          );
          try {
            getMetricsCollector().setGauge(
              'pre_run_cost_estimate_usd',
              'Pre-run cost estimate in USD',
              costEstimate.predictedCostUsd,
              [
                { name: 'task_category', value: costEstimate.taskCategory },
                { name: 'model_tier', value: costEstimate.modelTier },
                { name: 'model', value: routing.modelId },
              ],
            );
            getMetricsCollector().setGauge(
              'pre_run_token_estimate',
              'Pre-run token estimate',
              costEstimate.predictedTotalTokens,
              [
                { name: 'task_category', value: costEstimate.taskCategory },
                { name: 'model_tier', value: costEstimate.modelTier },
              ],
            );
          } catch {
            /* best-effort */
          }

          // 2. Build LLM request with cache-optimized prompt structure
          //    Stable content (system, tools) FIRST for maximum cache hits.
          //    Variable content (user message) LAST.
          // --- Two-Tier Tool Loading (Lazy Schema Loading) ---
          // Research (arXiv:2604.21816): Eager schema injection costs 10k-60k tokens/turn.
          // Two-tier loading: Tier 1 (full schema for top-N) + Tier 2 (compact registry for rest).
          // Estimated savings: 60-80% of tool-related token cost.

          const allToolDefs = ctx.availableTools
            .map((name) => this.tools.get(name)?.definition)
            .filter((t): t is ToolDefinition => t !== undefined);

          const maxActiveTools = this.config.toolRetrieval?.maxTools ?? 8;
          const twoTier = buildTwoTierTools(ctx.goal, allToolDefs, maxActiveTools);

          const contextPromotions = detectContextPromotions(ctx.goal, twoTier.registry);
          if (contextPromotions.length > 0) {
            const toolMap = new Map(allToolDefs.map((t) => [t.name, t]));
            for (const toolName of contextPromotions) {
              const tool = toolMap.get(toolName);
              if (tool) {
                twoTier.active.push(tool);
                twoTier.registry = twoTier.registry.filter((r) => r.name !== toolName);
              }
            }
          }

          const tierMetrics = calculateTierMetrics(twoTier, allToolDefs.length);

          // Log token savings
          if (tierMetrics.registryCount > 0) {
            getGlobalLogger().debug(
              'AgentRuntime',
              `Two-tier tools: ${tierMetrics.activeCount} active (${tierMetrics.activeTokenEstimate} tok), ${tierMetrics.registryCount} registry (~${tierMetrics.registryTokenEstimate} tok), ~${tierMetrics.savingsPercent}% savings`,
            );
          }

          // Tier 1: Active tools with full schema
          let toolDefs = twoTier.active;
          // Track promoted tools for hallucination rejection gate
          this.promotedTools = new Set(twoTier.active.map((t) => t.name));
          this.promotedTools.add('request_tool'); // always allow request_tool

          // Compact active tool schemas: strip verbose descriptions/examples.
          // Parameter-name minification is off for active tools so validation stays simple.
          const TIER_TO_COMPACT: Record<string, 'low' | 'medium' | 'high'> = {
            eco: 'low',
            standard: 'medium',
            power: 'high',
            consensus: 'high',
          };
          const compactConfig = getCompactConfigForTier(
            TIER_TO_COMPACT[this.config.defaultModelTier] ?? 'high',
          );
          toolDefs = compactToolDefs(toolDefs, compactConfig);

          // Register request_tool for Tier 2 tools (if there are registry tools)
          if (twoTier.registry.length > 0) {
            const registryNames = twoTier.registry.map((t) => t.name);
            const requestTool = createRequestToolTool((name) => {
              const found = allToolDefs.find((t) => t.name === name);
              return found ? compactToolDef(found, compactConfig) : undefined;
            }, registryNames);
            // Add request_tool to active tools
            toolDefs = [...toolDefs, requestTool.definition];
            // Register for execution
            this.tools.set('request_tool', requestTool);
          }

          // Build registry summary for system prompt
          const registrySummary = buildRegistrySummary(twoTier.registry);

          // Load project context once per run. This is cached by file mtime and
          // injected into the stable prefix so it participates in KV-cache reuse.
          const projectContext = loadProjectContext();

          const systemPrompt = buildSystemPrompt(
            ctx,
            routing,
            this.config,
            this.tools,
            this.governor,
            registrySummary,
            twoTier.active.map((t) => t.name),
            taskType,
            projectContext,
          );

          // KV-cache: track whether the stable system-prompt prefix changed
          // since the prior call. The prefix is tool-list + governance +
          // registry summary + max-steps + task-type + project-context — all cacheable across requests.
          // A hit lets the provider reuse prefix tokens, cutting cost and
          // latency (Anthropic reports 5x cost reduction on cached prefixes).
          const activeToolNames = twoTier.active.map((t) => t.name);
          const newPrefixKey = computePrefixCacheKey(
            this.config,
            this.tools,
            this.governor,
            registrySummary,
            activeToolNames,
            taskType,
            projectContext.cacheKey,
          );
          const cacheHit =
            this.lastPrefixCacheKey !== undefined && this.lastPrefixCacheKey === newPrefixKey;
          this.lastPrefixCacheKey = newPrefixKey;
          try {
            getMetricsCollector().recordPromptPrefixCache(cacheHit, ctx.tenantId);
            getMetricsCollector().setPromptPrefixCacheKey(newPrefixKey, ctx.tenantId);
          } catch {
            /* best-effort */
          }

          // Cache configuration: enable caching for system prompt + tools on providers that support it
          // 1h TTL is 2x write premium — only worth it on multi-step/long sessions, and the governor
          // forces 5m in 'critical' phase to avoid paying the write premium on tight budgets.
          const governorPhase = this.governor.getState().phase;
          const cacheTtl: '5m' | '1h' =
            this.config.promptCacheTtl === '1h' && governorPhase !== 'critical' ? '1h' : '5m';
          const cacheConfig: CacheConfig = {
            cacheSystemPrompt: true,
            cacheTools: toolDefs.length > 0,
            useCacheControl: true,
            cacheTtl,
            promptCacheKey: this.config.promptCacheKey ?? derivePromptCacheKey(ctx, tenantId),
            isBatch: !!batchRouting,
          };

          // Strip internal @tier suffix (eco/standard/power/consensus) before sending to provider
          const apiModel = (routing.modelId || '').replace(/@\w+$/, '') || routing.modelId;
          const selectedModelCfg = this.router.getModel(routing.modelId);
          const baseRequest: LLMRequest = {
            model: apiModel,
            // Order: [system (stable, cacheable), user (variable)]
            messages: [
              {
                role: 'system',
                content: systemPrompt,
              },
              {
                role: 'user',
                content: buildCacheAwareUserPrompt(ctx, routing, this.governor, this.config),
              },
            ],
            maxTokens: routing.maxTokens,
            tools: toolDefs,
            cacheConfig,
          };

          // Wire provider-native structured output when an output schema is supplied.
          if (ctx.outputSchema && selectedModelCfg) {
            if (selectedModelCfg.supportsStructuredOutput) {
              baseRequest.responseFormat = {
                type: 'json_schema',
                schema: ctx.outputSchema,
                name: 'structured_output',
              };
            } else if (selectedModelCfg.supportsJSONMode) {
              baseRequest.responseFormat = { type: 'json_object' };
            }
            // Anthropic / unsupported providers fall through to tool-use fallback in their provider.
          }

          // Apply parameter controller (eval profile, reasoning config, adaptive params)
          const request = applyControllerParams(baseRequest, ctx.goal, baseRequest.messages, 0);

          // Pre-LLM tool provisioning: detect tool needs and inject results before LLM sees the question
          try {
            const provisioned = await provisionTools(ctx.goal, request, this.tools, this.toolCache);
            if (provisioned) {
              bus.publish('system.alert', 'runtime', { type: 'tool_provisioned' });
            }
          } catch (e) {
            getGlobalLogger().debug('AgentRuntime', 'Tool provisioning failed (best-effort)', {
              error: (e as Error)?.message,
            });
          }

          this.checkpointer.checkpoint({
            runId,
            agentId: ctx.agentId,
            missionId: ctx.missionId,
            timestamp: now(),
            phase: 'started',
            stepNumber: 0,
            attemptNumber: 0,
            messages: request.messages,
            tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            stepDurations: [],
            context: {
              agentId: ctx.agentId,
              missionId: ctx.missionId,
              projectId: ctx.projectId,
              goal: ctx.goal,
              availableTools: ctx.availableTools,
              maxSteps: ctx.maxSteps,
              tokenBudget: ctx.tokenBudget,
              projectContextCacheKey: projectContext.cacheKey,
              projectContextFiles: projectContext.filesRead,
            },
            totalDurationMs: 0,
          });

          // Context injection with token budget cap to prevent pre-prompt bloat.
          // Cap injected context at 20% of total budget to leave room for actual execution.
          // Cache-stable context injection: consolidate all dynamic context into a single system message.
          // Research: Anthropic/OpenAI prompt caching requires stable prefixes for cache hits.
          // Multiple splice operations create variable-length arrays, reducing cache hit rates.
          // Solution: build a single context block and insert it once.
          const contextTokenCap = Math.max(2000, Math.floor((ctx.tokenBudget || 200000) * 0.2));
          let injectedContextTokens = 0;
          const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
          const contextParts: string[] = [];

          // Check agent inbox for pending messages before execution
          const inboxMessages = this.agentInbox.pollInbox(ctx.agentId);
          if (inboxMessages.length > 0) {
            const inboxBlock = inboxMessages
              .map((m) => `[from:${m.from}] ${m.subject}: ${m.body.slice(0, 300)}`)
              .join('\n');
            const inboxTokens = estimateTokens(inboxBlock);
            if (injectedContextTokens + inboxTokens < contextTokenCap) {
              contextParts.push(
                `## Pending Messages\n${inboxBlock}\n\nAddress these messages as part of your execution.`,
              );
              injectedContextTokens += inboxTokens;
            }
            for (const msg of inboxMessages) {
              this.agentInbox.acknowledge(ctx.agentId, msg.id);
            }
          }

          if (this.memory) {
            try {
              const keywords = ctx.goal
                .split(/\s+/)
                .filter((w) => w.length > 4)
                .slice(0, 8);
              if (keywords.length > 0) {
                const memories = this.memory.query({
                  keywords,
                  limit: 5,
                  importanceThreshold: 0.3,
                });
                if (memories.length > 0) {
                  const memoryBlock = memories
                    .map(
                      (m) =>
                        `[${m.layer}] ${m.content.slice(0, 300)} (importance:${m.importance.toFixed(2)}, tags:${m.tags.join(',')})`,
                    )
                    .join('\n');
                  const memoryTokens = estimateTokens(memoryBlock);
                  if (injectedContextTokens + memoryTokens < contextTokenCap) {
                    contextParts.push(
                      `## Relevant Past Experiences\n${memoryBlock}\n\nLearn from these past experiences when working on the current task.`,
                    );
                    injectedContextTokens += memoryTokens;
                  }
                }
              }
            } catch (e) {
              getGlobalLogger().debug('AgentRuntime', 'Memory initialization failed', {
                error: (e as Error)?.message,
              });
            }
          }

          // Inject skills catalog (Level 0) into context
          try {
            const { SkillInjector, getSkillSystem } = await import('../skills');
            const injector = new SkillInjector(getSkillSystem().manager);
            const skillsBlock = await injector.buildSkillsBlock(ctx.goal, 0);
            const instructions = injector.buildSkillUsageInstructions();
            if (skillsBlock) {
              const skillsTokens = estimateTokens(skillsBlock + instructions);
              if (injectedContextTokens + skillsTokens < contextTokenCap) {
                contextParts.push(`${skillsBlock}\n\n${instructions}`);
                injectedContextTokens += skillsTokens;
              }
            }
          } catch (e) {
            getGlobalLogger().debug('AgentRuntime', 'Skills injection failed', {
              error: (e as Error)?.message,
            });
          }

          // Inject auto-extracted skill recall — check SkillExtractor for matching past successes
          try {
            const { getSkillExtractor } = await import('../intelligence/skillExtractor');
            const skillExtractor = getSkillExtractor();
            const matchingSkill = skillExtractor.findMatchingSkill(ctx.goal);
            if (matchingSkill && matchingSkill.confidence >= 0.5) {
              try {
                getMetricsCollector().recordSkillRecallHit(true, ctx.tenantId);
              } catch {
                /* best-effort */
              }
              const skillLines = [
                '## Auto-Recalled Skill',
                `You've successfully handled a similar task before. Use this proven pattern:`,
                ``,
                `**${matchingSkill.name}** (${(matchingSkill.successRate * 100).toFixed(0)}% success, used ${matchingSkill.usageCount}×)`,
                `Description: ${matchingSkill.description}`,
              ];
              if (matchingSkill.steps.length > 0) {
                skillLines.push(`Steps: ${matchingSkill.steps.join(' → ')}`);
              }
              if (matchingSkill.tools.length > 0) {
                skillLines.push(`Recommended tools: ${matchingSkill.tools.join(', ')}`);
              }
              skillLines.push(
                ``,
                `Reuse this pattern if applicable. Adapt based on the current context.`,
              );
              const skillBlock = skillLines.join('\n');
              const skillTokens = estimateTokens(skillBlock);
              if (injectedContextTokens + skillTokens < contextTokenCap) {
                contextParts.push(skillBlock);
                injectedContextTokens += skillTokens;
              }
            } else {
              try {
                getMetricsCollector().recordSkillRecallHit(false, ctx.tenantId);
              } catch {
                /* best-effort */
              }
            }
          } catch (e) {
            getGlobalLogger().debug('AgentRuntime', 'Skill recall injection failed (best-effort)', {
              error: (e as Error)?.message,
            });
          }

          // Single splice for cache stability — all dynamic context in one system message
          if (contextParts.length > 0) {
            request.messages.splice(request.messages.length - 1, 0, {
              role: 'system' as const,
              content: contextParts.join('\n\n---\n\n'),
            });
          }

          // 3. Emit started event
          bus.publish('agent.started', ctx.agentId, {
            runId,
            missionId: ctx.missionId,
            model: routing.modelId,
            goal: ctx.goal,
          });

          // Fire plugin onAgentStart hooks
          getHookManager()
            .fireOnAgentStart({ ctx, runId })
            .catch((e) =>
              getGlobalLogger().debug('AgentRuntime', 'onAgentStart hook failed', {
                error: (e as Error)?.message,
              }),
            );

          // 4. Execute with retry and circuit breaker
          let lastError: string | undefined;
          let lastErrorIsPermanent = false;
          const steps: AgentExecutionStep[] = [];
          let totalTokens: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
          // Track content written by file_write tool calls for artifact propagation
          let largestFileWriteContent = '';
          let largestFileWritePath = '';
          // Cumulative evidence for SubAgentGuard progress tracking (persists across retries)
          let cumulativeEvidence = 0;

          // Per-run sliding window instance to prevent concurrent run corruption
          this.slidingWindow = new SlidingWindowOrchestrator();

          // Resolve evaluator provider for verification pipeline (echo chamber breaker)
          if (this.config.evaluatorProviderName) {
            const evalProvider = this.providers.get(this.config.evaluatorProviderName);
            if (evalProvider) {
              this.verificationPipeline.setEvaluatorProvider(evalProvider);
            }
          }

          // Check circuit breaker before first attempt
          if (!this.circuitBreaker.isAvailable()) {
            const msg = 'CIRCUIT_OPEN: Too many recent failures. Cooling down.';
            tracer.recordDecision(runId, msg, 0);
            bus.publish('agent.failed', ctx.agentId, { runId, error: msg });
            return {
              runId,
              agentId: ctx.agentId,
              missionId: ctx.missionId,
              status: 'cancelled',
              summary: msg,
              steps: [],
              totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              totalDurationMs: 0,
              error: msg,
            };
          }

          for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            const llmCtx = { request, agentId: ctx.agentId, runId };
            let llmRequest = await getHookManager().fireBeforeLLMCall(llmCtx);
            let response = await this.callWithTimeout(llmRequest, routing);
            await getHookManager().fireAfterLLMCall({
              request: llmRequest,
              response,
              agentId: ctx.agentId,
              runId,
            });
            const stepDuration = Date.now() - startTime;

            // Enforce sub-agent step limits (only when ctx.guard is set by subAgentExecutor)
            ctx.guard?.check(0);

            if (response) {
              // Accumulate token usage
              totalTokens.promptTokens += response.usage.promptTokens;
              totalTokens.completionTokens += response.usage.completionTokens;
              totalTokens.totalTokens += response.usage.totalTokens;
              this.governor.reportUsage(response.usage.totalTokens);
              ctx.guard?.recordTokens(response.usage.totalTokens);

              const traceEventId = tracer.recordLLMCall(
                runId,
                routing.modelId,
                routing.provider,
                routing.tier,
                request,
                response,
                response.usage,
                stepDuration,
                undefined,
                { taskCategory: costEstimate.taskCategory },
              );
              getMetricsCollector().recordLLMCall(
                routing.modelId,
                routing.provider,
                response.usage.totalTokens,
                stepDuration,
                undefined,
                tenantId,
              );

              // Record actual cost for estimator learning (per-step)
              try {
                const modelCfg = this.router.getModel(routing.modelId);
                const stepCostUsd =
                  costEstimator.estimateForModel(
                    ctx,
                    modelCfg ?? {
                      id: routing.modelId,
                      provider: routing.provider,
                      tier: routing.tier,
                      costPer1KInput: 0.003,
                      costPer1KOutput: 0.01,
                      capabilities: [],
                      contextWindow: 128000,
                      priority: 0,
                    },
                  ).costUsd *
                  (response.usage.totalTokens / (costEstimate.predictedTotalTokens || 1));
                costEstimator.recordActualCost(
                  costEstimate.taskCategory,
                  routing.tier,
                  response.usage.promptTokens,
                  response.usage.completionTokens,
                  stepCostUsd,
                  stepDuration,
                  true,
                );
                // Record model performance for cross-session learning
                this.router.recordOutcome(
                  routing.modelId,
                  costEstimate.taskCategory,
                  true,
                  stepDuration,
                  response.usage.totalTokens,
                );
                try {
                  getModelPerformanceStore().record({
                    modelId: routing.modelId,
                    taskType: costEstimate.taskCategory,
                    success: true,
                    durationMs: stepDuration,
                    tokensUsed: response.usage.totalTokens,
                    timestamp: Date.now(),
                  });
                } catch {
                  /* best-effort */
                }
              } catch {
                /* best-effort learning */
              }

              // Record step
              const stepNumber = steps.length + 1;
              const step: AgentExecutionStep = {
                stepNumber,
                timestamp: now(),
                type: 'response',
                content:
                  response.content ||
                  (response as { reasoning_content?: string }).reasoning_content ||
                  '',
                tokenUsage: response.usage,
                durationMs: stepDuration,
              };

              // ── Hook: onStepStart ──
              getHookManager()
                .fireOnStepStart({
                  runId,
                  agentId: ctx.agentId,
                  stepNumber,
                  type: 'response',
                  content: response.content,
                })
                .catch((e) =>
                  getGlobalLogger().debug('AgentRuntime', 'onStepStart hook failed', {
                    error: (e as Error)?.message,
                  }),
                );

              steps.push(step);

              const anomalyDetector = getAnomalyDetector();
              anomalyDetector.recordUsage(ctx.agentId, response.usage.totalTokens);
              const anomaly = anomalyDetector.checkForAnomaly(
                ctx.agentId,
                runId,
                stepNumber,
                response.usage.totalTokens,
              );
              if (anomaly) {
                bus.publish('system.alert', 'runtime', {
                  type: 'token_usage_anomaly',
                  ...anomaly,
                });
              }

              if (response.content) {
                const stagnation = this.cycleDetector.checkOutput(response.content);
                if (stagnation.detected) {
                  bus.publish('system.alert', 'runtime', {
                    ...stagnation,
                    runId,
                    agentId: ctx.agentId,
                    stepNumber,
                  });
                  getGlobalLogger().warn('AgentRuntime', 'Semantic stagnation detected', {
                    stepNumber,
                    similarity: stagnation.similarity,
                  });
                }
              }

              // Entropy gating: if model is confident with no tool calls, skip verification
              // to save tokens. Evidence: arXiv 2602.02050 — high-quality tool calls reduce
              // model entropy; confident responses need no verification.
              let earlyExit = false;
              if (!response.toolCalls || response.toolCalls.length === 0) {
                if (isConfidentResponse(response)) {
                  bus.publish('system.alert', 'runtime', {
                    type: 'entropy_gate',
                    reason: 'confident_no_tool_calls',
                  });
                  // Skip verification when model is confident — saves ~500-2000 tokens per skip
                  earlyExit = true;
                  getMetricsCollector().incrementCounter(
                    'early_exits_total',
                    'Early exits due to confident responses',
                    1,
                    [{ name: 'reason', value: 'confident_no_tools' }],
                  );
                }
                // Attempt structured output extraction for potential JSON answers.
                // Prefer provider-native parsed output, then fall back to content parsing.
                if (response.parsed) {
                  step.content = JSON.stringify(response.parsed);
                } else {
                  const structured = parseStructuredOutput(response.content);
                  if (structured) {
                    step.content =
                      typeof structured === 'string' ? structured : JSON.stringify(structured);
                  }
                }
              }

              // Process tool calls in a loop — with caching, planning, cycle detection, and output management
              const maxIterations = Math.max(ctx.maxSteps || 10, 20);
              let toolLoopCount = 0;
              this.cycleDetector.reset();
              this.executedMutations = [];
              // Track recent tool call patterns for retry-loop detection.
              // A retry loop is when the same tool is called with identical
              // arguments >= 3 times within a short window (last 20 calls).
              const recentToolPatterns: string[] = [];
              let retryLoopDetected = false;
              let retryLoopCount = 0;
              let cycleDetected = false;
              let interruptData: { reason: string; value: unknown } | null = null;
              while (
                response.toolCalls &&
                response.toolCalls.length > 0 &&
                toolLoopCount < maxIterations &&
                !cycleDetected &&
                !retryLoopDetected &&
                this.governor.getState().phase !== 'critical'
              ) {
                toolLoopCount++;

                // Reset output manager turn budget (governor-aware: shrink under pressure)
                this.outputManager.resetTurn();
                this.outputManager.adjustBudgetForPressure(this.governor.getState().pressure);

                // Check cache for all tool calls first (zero-cost on hit)
                const calls = response.toolCalls;
                const uncachedCalls: typeof calls = [];
                const cachedResults: Array<{
                  toolCallId: string;
                  name: string;
                  output: string;
                  error?: string;
                  durationMs: number;
                }> = [];

                for (const tc of calls) {
                  const cached = this.toolCache.get(tc, tenantId);
                  if (cached) {
                    cachedResults.push({
                      toolCallId: tc.id,
                      name: tc.name,
                      output: cached.output,
                      error: cached.error,
                      durationMs: 0,
                    });
                  } else {
                    uncachedCalls.push(tc);
                  }
                }

                // Plan execution for uncached calls using dependency-aware planner
                const executionPlan = this.planner.plan(uncachedCalls, this.tools);
                const rawResults: Array<{
                  toolCallId: string;
                  name: string;
                  output: string;
                  error?: string;
                  durationMs: number;
                }> = [];

                // Execute each stage (parallel within stage, sequential across stages)
                for (const stage of executionPlan.stages) {
                  if (stage.toolCalls.length === 0) continue;

                  // Apply descending scheduler if enabled (broad exploration first)
                  const stageCalls = this.config.enableDescendingScheduler
                    ? descendingToolOrder(stage.toolCalls)
                    : stage.toolCalls;

                  // Check orchestration plan (circuit breakers, approvals)
                  const planResult = await this.orchestrator.planExecution(stageCalls, this.tools);
                  const approvedCalls = [...planResult.concurrent, ...planResult.serial];

                  // Log skipped/circuit-broken tools
                  for (const s of planResult.skipped) {
                    bus.publish('tool.blocked', ctx.agentId, {
                      runId,
                      toolName: s.toolCall.name,
                      reason: 'orchestrator_skipped',
                      detail: s.reason,
                    });
                    rawResults.push({
                      toolCallId: s.toolCall.id,
                      name: s.toolCall.name,
                      output: '',
                      error: s.reason,
                      durationMs: 0,
                    });
                  }
                  for (const cb of planResult.circuitBroken) {
                    bus.publish('tool.blocked', ctx.agentId, {
                      runId,
                      toolName: cb.toolCall.name,
                      reason: 'circuit_broken',
                      detail: cb.toolName,
                    });
                    rawResults.push({
                      toolCallId: cb.toolCall.id,
                      name: cb.toolCall.name,
                      output: '',
                      error: `CIRCUIT_OPEN: ${cb.toolName}`,
                      durationMs: 0,
                    });
                  }

                  // Partition approved calls: concurrent-safe first, then serial
                  const concurrencyMap = approvedCalls.map((tc) => {
                    const tool = this.tools.get(tc.name);
                    return { tc, isSafe: tool?.isConcurrencySafe === true };
                  });
                  const safeCalls = concurrencyMap.filter((c) => c.isSafe).map((c) => c.tc);
                  const serialCalls = concurrencyMap.filter((c) => !c.isSafe).map((c) => c.tc);

                  // Run concurrent-safe tools in parallel with sibling abort
                  if (safeCalls.length > 0) {
                    const siblingAbort = new AbortController();
                    const concurrentResults = await Promise.allSettled(
                      safeCalls.map(async (tc) => {
                        // Check HookManager beforeToolCall
                        const hookCtx = {
                          toolName: tc.name,
                          args: tc.arguments,
                          agentId: ctx.agentId,
                          runId,
                        };
                        const hookResult = await getHookManager().fireBeforeToolCall(hookCtx);
                        if (hookResult !== null) {
                          bus.publish('tool.blocked', ctx.agentId, {
                            runId,
                            toolName: tc.name,
                            reason: 'hook_denied',
                            detail: hookResult.error ?? '',
                          });
                          return {
                            toolCallId: tc.id,
                            name: tc.name,
                            output: '',
                            error: `Hook blocked: ${hookResult.error || 'denied'}`,
                            durationMs: 0,
                          };
                        }

                        if (siblingAbort.signal.aborted) {
                          return {
                            toolCallId: tc.id,
                            name: tc.name,
                            output: '',
                            error: 'Cancelled: sibling tool error',
                            durationMs: 0,
                          };
                        }
                        // Retry-loop detection: canonicalized args for deterministic matching
                        const rlCheck = this.checkRetryLoop(
                          tc.name,
                          tc.arguments as Record<string, unknown>,
                          recentToolPatterns,
                          runId,
                          ctx.tenantId,
                          toolLoopCount,
                        );
                        if (rlCheck.detected) {
                          retryLoopDetected = true;
                          retryLoopCount = rlCheck.count;
                          return {
                            toolCallId: tc.id,
                            name: tc.name,
                            output: '',
                            error: `Retry loop detected: ${tc.name}`,
                            durationMs: 0,
                          };
                        }
                        const cycleCheck = this.cycleDetector.check(
                          tc.name,
                          tc.arguments,
                          toolLoopCount,
                        );
                        if (cycleCheck.detected) {
                          bus.publish('system.alert', 'runtime', {
                            type: 'cycle_detected',
                            toolName: tc.name,
                            description: cycleCheck.description,
                          });
                          bus.publish('tool.blocked', ctx.agentId, {
                            runId,
                            toolName: tc.name,
                            reason: 'cycle_detected',
                            detail: cycleCheck.description,
                          });
                          cycleDetected = true;
                          return {
                            toolCallId: tc.id,
                            name: tc.name,
                            output: '',
                            error: `Cycle detected: ${cycleCheck.description}`,
                            durationMs: 0,
                          };
                        }

                        // Catch InterruptError before StepErrorBoundary — it's a signal, not an error
                        let toolResult: ToolResult;
                        try {
                          toolResult = await this.executeTool(
                            runId,
                            tc,
                            ctx.agentId,
                            tenantId,
                            ctx.availableTools,
                          );
                        } catch (err) {
                          if (err instanceof InterruptError) {
                            // Signal interrupt — the tool loop will break after this iteration
                            interruptData = { reason: err.reason, value: err.value };
                            bus.publish('agent.interrupted', ctx.agentId, {
                              runId,
                              reason: err.reason,
                            });
                            return {
                              toolCallId: tc.id,
                              name: tc.name,
                              output: `Interrupted: ${err.reason}`,
                              error: undefined,
                              durationMs: 0,
                            };
                          }
                          throw err; // Re-throw non-interrupt errors for StepErrorBoundary
                        }

                        toolResult = await getHookManager().fireAfterToolCall({
                          toolName: tc.name,
                          args: tc.arguments,
                          result: toolResult,
                          agentId: ctx.agentId,
                          runId,
                        });
                        if (
                          toolResult.error &&
                          (tc.name === 'shell_execute' || tc.name === 'bash')
                        ) {
                          siblingAbort.abort();
                        }
                        if (!toolResult.error) {
                          this.toolCache.set(tc, toolResult, tenantId);
                          this.invalidateMutationCache(tc.name);
                          if (isMutationTool(tc.name)) {
                            this.executedMutations.push({
                              toolName: tc.name,
                              args: tc.arguments as Record<string, unknown>,
                            });
                          }
                        }
                        // Capture file_write content for artifact propagation
                        if (tc.name === 'file_write' && !toolResult.error) {
                          const writtenContent = String(tc.arguments?.content ?? '');
                          if (writtenContent.length > largestFileWriteContent.length) {
                            largestFileWriteContent = writtenContent;
                            largestFileWritePath = String(tc.arguments?.path ?? '');
                          }
                        }
                        return {
                          toolCallId: tc.id,
                          name: tc.name,
                          output: toolResult.output,
                          error: toolResult.error,
                          durationMs: toolResult.durationMs,
                        };
                      }),
                    );
                    for (let i = 0; i < concurrentResults.length; i++) {
                      const r = concurrentResults[i];
                      if (r.status === 'fulfilled') {
                        if (r.status === 'fulfilled' && !r.value.error) cumulativeEvidence++;
                        rawResults.push(r.value);
                      } else {
                        rawResults.push({
                          toolCallId: safeCalls[i].id,
                          name: safeCalls[i].name,
                          output: '',
                          error: r.reason?.toString() || 'Execution failed',
                          durationMs: 0,
                        });
                      }
                    }
                  }

                  // Run serial tools in order
                  for (const tc of serialCalls) {
                    const hookCtx = {
                      toolName: tc.name,
                      args: tc.arguments,
                      agentId: ctx.agentId,
                      runId,
                    };
                    const hookResult = await getHookManager().fireBeforeToolCall(hookCtx);
                    if (hookResult !== null) {
                      bus.publish('tool.blocked', ctx.agentId, {
                        runId,
                        toolName: tc.name,
                        reason: 'hook_denied',
                        detail: hookResult.error ?? '',
                      });
                      rawResults.push({
                        toolCallId: tc.id,
                        name: tc.name,
                        output: '',
                        error: `Hook blocked: ${hookResult.error || 'denied'}`,
                        durationMs: 0,
                      });
                      continue;
                    }
                    // Retry-loop detection: canonicalised args for deterministic matching
                    const rlCheck = this.checkRetryLoop(
                      tc.name,
                      tc.arguments as Record<string, unknown>,
                      recentToolPatterns,
                      runId,
                      ctx.tenantId,
                      toolLoopCount,
                    );
                    if (rlCheck.detected) {
                      retryLoopDetected = true;
                      retryLoopCount = rlCheck.count;
                      rawResults.push({
                        toolCallId: tc.id,
                        name: tc.name,
                        output: '',
                        error: `Retry loop detected: ${tc.name}`,
                        durationMs: 0,
                      });
                      break;
                    }
                    const cycleCheck = this.cycleDetector.check(
                      tc.name,
                      tc.arguments,
                      toolLoopCount,
                    );
                    if (cycleCheck.detected) {
                      bus.publish('system.alert', 'runtime', {
                        type: 'cycle_detected',
                        toolName: tc.name,
                        description: cycleCheck.description,
                      });
                      bus.publish('tool.blocked', ctx.agentId, {
                        runId,
                        toolName: tc.name,
                        reason: 'cycle_detected',
                        detail: cycleCheck.description,
                      });
                      rawResults.push({
                        toolCallId: tc.id,
                        name: tc.name,
                        output: '',
                        error: `Cycle detected: ${cycleCheck.description}`,
                        durationMs: 0,
                      });
                      cycleDetected = true;
                      break;
                    }
                    let toolResult = await this.executeTool(
                      runId,
                      tc,
                      ctx.agentId,
                      tenantId,
                      ctx.availableTools,
                    );
                    toolResult = await getHookManager().fireAfterToolCall({
                      toolName: tc.name,
                      args: tc.arguments,
                      result: toolResult,
                      agentId: ctx.agentId,
                      runId,
                    });
                    if (!toolResult.error) {
                      this.toolCache.set(tc, toolResult, tenantId);
                      this.invalidateMutationCache(tc.name);
                      if (isMutationTool(tc.name)) {
                        this.executedMutations.push({
                          toolName: tc.name,
                          args: tc.arguments as Record<string, unknown>,
                        });
                      }
                    }
                    // Capture file_write content for artifact propagation
                    if (tc.name === 'file_write' && !toolResult.error) {
                      const writtenContent = String(tc.arguments?.content ?? '');
                      if (writtenContent.length > largestFileWriteContent.length) {
                        largestFileWriteContent = writtenContent;
                        largestFileWritePath = String(tc.arguments?.path ?? '');
                      }
                    }
                    if (!toolResult.error) cumulativeEvidence++;
                    rawResults.push({
                      toolCallId: tc.id,
                      name: tc.name,
                      output: toolResult.output,
                      error: toolResult.error,
                      durationMs: toolResult.durationMs,
                    });
                  }
                }

                // Merge cached + raw results, reorder to match original request order
                const allResults = [...cachedResults, ...rawResults];
                const resultMap = new Map(allResults.map((r) => [r.toolCallId, r]));
                const orderedResults = calls.map((tc) => resultMap.get(tc.id)!).filter(Boolean);

                // Output management: cap, truncate, persist per-turn budget
                const managedOutputs = this.outputManager.manageBatch(
                  orderedResults.map((r, i) => ({
                    toolCall: calls[i],
                    result: {
                      toolCallId: r.toolCallId,
                      name: r.name,
                      output: r.output,
                      error: r.error,
                      durationMs: r.durationMs,
                    },
                  })),
                );

                // Governor-driven observation masking: adjust window based on budget pressure
                const maskDecision = this.governor.shouldApply('observation_mask');
                const effectiveWindow = maskDecision.apply
                  ? Math.max(
                      2,
                      Math.floor(
                        this.config.observationMaskWindow * (1 - maskDecision.intensity * 0.7),
                      ),
                    )
                  : this.config.observationMaskWindow;
                const maskedResults = await applyObservationMask(
                  orderedResults.map((r, i) => ({
                    ...r,
                    output: managedOutputs[i]?.output ?? r.output,
                  })),
                  effectiveWindow,
                );

                // Governor-driven tool output truncation: truncate verbose outputs under budget pressure
                const truncateDecision = this.governor.shouldApply('tool_output_truncate');
                const truncLimit = truncateDecision.apply
                  ? Math.max(200, Math.floor(2000 * (1 - truncateDecision.intensity * 0.8)))
                  : 0;

                for (const masked of maskedResults) {
                  let finalOutput = masked.output;
                  // Defense-in-depth: scan tool outputs for injection patterns before they enter the LLM context.
                  // Lightweight regex check — blocks known injection patterns without LLM cost.
                  try {
                    const injectionScan = scanToolOutputForInjection(finalOutput);
                    if (injectionScan.blocked) {
                      finalOutput = `[Tool output filtered: ${injectionScan.reason}] (Original output length: ${finalOutput.length} chars)`;
                      bus.publish('system.alert', 'runtime', {
                        type: 'tool_output_injection_blocked',
                        toolCallId: masked.toolCallId,
                        reason: injectionScan.reason,
                      });
                      try {
                        getMetricsCollector().incrementCounter(
                          'tool_output_injection_blocked_total',
                          'Tool outputs blocked for injection patterns',
                          1,
                          [{ name: 'reason', value: injectionScan.reason ?? 'unknown' }],
                        );
                      } catch {
                        /* best-effort */
                      }
                    }
                  } catch {
                    /* best-effort defense */
                  }
                  // Apply truncation if governor says so and output is verbose
                  if (truncLimit > 0 && finalOutput.length > truncLimit) {
                    finalOutput =
                      finalOutput.slice(0, truncLimit) +
                      `\n...[truncated: ${masked.output.length - truncLimit} chars]`;
                  }
                  const tsNum = steps.length + 1;
                  const toolStep: AgentExecutionStep = {
                    stepNumber: tsNum,
                    timestamp: now(),
                    type: 'tool_result',
                    content: masked.output,
                    durationMs: masked.durationMs,
                  };

                  // ── Hook: onStepComplete ──
                  getHookManager()
                    .fireOnStepComplete({
                      runId,
                      agentId: ctx.agentId,
                      stepNumber: tsNum,
                      type: 'tool_result',
                      content: masked.output,
                    })
                    .catch((e) =>
                      getGlobalLogger().debug('AgentRuntime', 'onStepComplete hook failed', {
                        error: (e as Error)?.message,
                      }),
                    );

                  steps.push(toolStep);

                  const assistantMsg: import('./types').LLMMessage = {
                    role: 'assistant',
                    content: response.content,
                    ...(response.reasoning_content
                      ? { reasoning_content: response.reasoning_content }
                      : {}),
                    ...(response.toolCalls
                      ? {
                          tool_calls: response.toolCalls.map((tc) => ({
                            id: tc.id,
                            type: 'function' as const,
                            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                          })),
                        }
                      : {}),
                  };
                  request.messages.push(assistantMsg, {
                    role: 'tool',
                    content: masked.output,
                    tool_call_id: masked.toolCallId,
                  });
                }

                // ── Sliding Window + Memory Solidification ──
                // Before the follow-up LLM call, increment the turn counter,
                // solidify completed turns to episodic memory (if due),
                // enforce the window boundary, and retrieve relevant context.
                this.slidingWindow.incrementTurn();

                if (this.memory) {
                  // 1. Solidify completed turns to memory (every N turns)
                  try {
                    const solidifyResult = await this.slidingWindow.solidifyCompletedTurns(
                      request.messages,
                      this.memory,
                      ctx.goal,
                      runId,
                    );
                    if (solidifyResult.turnsSolidified > 0) {
                      bus.publish('system.alert', 'runtime', {
                        type: 'sliding_window_solidify',
                        turnsSolidified: solidifyResult.turnsSolidified,
                        tokensFreed: solidifyResult.tokensFreed,
                      });
                    }
                  } catch (e) {
                    getGlobalLogger().debug(
                      'AgentRuntime',
                      'Sliding window solidify failed (best-effort)',
                      {
                        error: (e as Error)?.message,
                      },
                    );
                  }

                  // 2. Apply sliding window (enforce max turns in context)
                  // request.messages is mutated in-place, so the subsequent
                  // followUpRequest will automatically reference the updated array.
                  try {
                    const windowResult = this.slidingWindow.applyWindow(request.messages);
                    if (windowResult.applied) {
                      bus.publish('system.alert', 'runtime', {
                        type: 'sliding_window_applied',
                        turnsDropped: windowResult.turnsDropped,
                        tokensFreed: windowResult.tokensFreed,
                      });
                    }
                  } catch (e) {
                    getGlobalLogger().debug(
                      'AgentRuntime',
                      'Sliding window apply failed (best-effort)',
                      {
                        error: (e as Error)?.message,
                      },
                    );
                  }

                  // 3. Retrieve relevant context from memory and inject
                  try {
                    const retrievalResult = this.slidingWindow.retrieveContext(
                      this.memory,
                      ctx.goal,
                      request.messages,
                    );
                    if (
                      retrievalResult.entriesRetrieved > 0 &&
                      retrievalResult.injectedContext.length > 0
                    ) {
                      // Inject as a system message before the last user message
                      // This keeps prompt-cache stability (injected before variable content)
                      request.messages.splice(request.messages.length - 1, 0, {
                        role: 'system' as const,
                        content: retrievalResult.injectedContext,
                      });

                      bus.publish('system.alert', 'runtime', {
                        type: 'sliding_window_retrieval',
                        entriesRetrieved: retrievalResult.entriesRetrieved,
                        injectedTokens: retrievalResult.injectedTokens,
                      });
                    }
                  } catch (e) {
                    getGlobalLogger().debug(
                      'AgentRuntime',
                      'Sliding window retrieval failed (best-effort)',
                      {
                        error: (e as Error)?.message,
                      },
                    );
                  }
                }

                // Resume the model with tool results
                // followUpRequest is created fresh from the mutated request object,
                // so it correctly sees the updated messages array.
                const followUpCtx = { request, agentId: ctx.agentId, runId };
                let followUpRequest = await getHookManager().fireBeforeLLMCall(followUpCtx);
                const followUp = await this.callWithTimeout(followUpRequest, routing);
                await getHookManager().fireAfterLLMCall({
                  request: followUpRequest,
                  response: followUp,
                  agentId: ctx.agentId,
                  runId,
                });
                if (!followUp) break;
                totalTokens.promptTokens += followUp.usage.promptTokens;
                totalTokens.completionTokens += followUp.usage.completionTokens;
                totalTokens.totalTokens += followUp.usage.totalTokens;
                this.governor.reportUsage(followUp.usage.totalTokens);
                ctx.guard?.recordTokens(followUp.usage.totalTokens);
                response = followUp;

                // Enforce sub-agent step and progress limits at each tool loop iteration
                ctx.guard?.check(cumulativeEvidence);

                // Context compaction: check every iteration after the first.
                // The compactor's own layer thresholds (60%/70%/82%/92% full) decide whether to act.
                // This prevents context bloat before the LLM call that would waste tokens.
                if (toolLoopCount > 1) {
                  const tokensBefore = this.compactor.getUsage(request.messages).total;
                  const tt = detectTaskType(ctx.goal);
                  const taskType: CompactTaskType = tt === 'creative' ? 'general' : tt;

                  // ── Hook: beforeContextCompaction ──
                  getHookManager()
                    .fireBeforeContextCompaction({
                      messageCount: request.messages.length,
                      totalTokens: tokensBefore,
                      budgetTokens: this.config.budgetHardCapTokens || 128000,
                      agentId: ctx.agentId,
                      runId,
                    })
                    .catch((e) =>
                      getGlobalLogger().debug(
                        'AgentRuntime',
                        'beforeContextCompaction hook failed',
                        { error: (e as Error)?.message },
                      ),
                    );

                  const compactResult = this.compactor.compact(
                    request.messages,
                    undefined,
                    taskType,
                  );
                  if (compactResult.action.droppedCount > 0) {
                    request.messages = compactResult.messages;
                    this.governor.recordOutcome(
                      'context_compaction',
                      tokensBefore,
                      this.compactor.getUsage(request.messages).total,
                    );
                    bus.publish('system.alert', 'runtime', {
                      type: 'context_compaction',
                      layer: compactResult.action.layer,
                      droppedCount: compactResult.action.droppedCount,
                      tokensSaved: compactResult.action.tokensSaved,
                    });

                    // ── Hook: afterContextCompaction ──
                    getHookManager()
                      .fireAfterContextCompaction({
                        messageCount: request.messages.length,
                        totalTokens: this.compactor.getUsage(request.messages).total,
                        budgetTokens: this.config.budgetHardCapTokens || 128000,
                        agentId: ctx.agentId,
                        runId,
                      })
                      .catch((e) =>
                        getGlobalLogger().debug(
                          'AgentRuntime',
                          'afterContextCompaction hook failed',
                          { error: (e as Error)?.message },
                        ),
                      );
                  }
                }
              }

              // Interrupt check: if a tool requested human input, pause execution
              if (interruptData) {
                const id = interruptData as { reason: string; value: unknown };
                const totalDurationMs = Date.now() - startTime;
                const result: AgentExecutionResult = {
                  runId,
                  agentId: ctx.agentId,
                  missionId: ctx.missionId,
                  status: 'interrupted',
                  summary: `Interrupted: ${id.reason}`,
                  steps,
                  totalTokenUsage: totalTokens,
                  totalDurationMs,
                  interrupt: id,
                };
                this.checkpointer.terminalCheckpoint({
                  runId,
                  agentId: ctx.agentId,
                  missionId: ctx.missionId,
                  timestamp: now(),
                  phase: 'interrupted',
                  stepNumber: steps.length,
                  attemptNumber: attempt,
                  messages: request.messages,
                  tokenUsage: { ...totalTokens },
                  stepDurations: steps.map((s) => s.durationMs),
                  context: {
                    agentId: ctx.agentId,
                    missionId: ctx.missionId,
                    projectId: ctx.projectId,
                    goal: ctx.goal,
                    availableTools: ctx.availableTools,
                    maxSteps: ctx.maxSteps,
                    tokenBudget: ctx.tokenBudget,
                  },
                  totalDurationMs,
                });
                tracer.recordDecision(runId, `Interrupted: ${id.reason}`, steps.length);
                bus.publish('agent.interrupted', ctx.agentId, { runId, reason: id.reason });
                try {
                  getMetricsCollector().recordSubAgentOutcome(
                    ctx.agentId,
                    'interrupted',
                    ctx.subAgentDepth ?? 0,
                    ctx.tenantId,
                  );
                } catch {
                  /* best-effort */
                }
                return result;
              }

              // Early exit: skip verification when model is confident and has no tool calls.
              // This saves the verification token cost (~500-2000 tokens) and avoids
              // unnecessary retries on confident responses.
              if (earlyExit) {
                const safeContent =
                  response.content ||
                  (response as { reasoning_content?: string }).reasoning_content ||
                  '';
                const totalDurationMs = Date.now() - startTime;
                const result: AgentExecutionResult = {
                  runId,
                  agentId: ctx.agentId,
                  missionId: ctx.missionId,
                  status: 'success',
                  summary: safeContent || '[Early exit: confident response]',
                  steps,
                  totalTokenUsage: totalTokens,
                  totalDurationMs,
                };

                this.checkpointer.terminalCheckpoint({
                  runId,
                  agentId: ctx.agentId,
                  missionId: ctx.missionId,
                  timestamp: now(),
                  phase: 'completed_early_exit',
                  stepNumber: steps.length,
                  attemptNumber: attempt,
                  messages: request.messages,
                  tokenUsage: { ...totalTokens },
                  stepDurations: steps.map((s) => s.durationMs),
                  context: {
                    agentId: ctx.agentId,
                    missionId: ctx.missionId,
                    projectId: ctx.projectId,
                    goal: ctx.goal,
                    availableTools: ctx.availableTools,
                    maxSteps: ctx.maxSteps,
                    tokenBudget: ctx.tokenBudget,
                  },
                  totalDurationMs,
                });

                if (this.memory) {
                  try {
                    this.memory.add(
                      `[EARLY_EXIT] ${ctx.goal.slice(0, 200)}`,
                      'episodic',
                      `run:${runId}|tokens:${totalTokens.totalTokens}|dur:${totalDurationMs}ms|steps:${steps.length}`,
                      0.6,
                      ['execution', 'early_exit', ...ctx.availableTools.slice(0, 3)],
                      {
                        runId,
                        goal: ctx.goal.slice(0, 500),
                        tokenUsage: totalTokens,
                        durationMs: totalDurationMs,
                      },
                    );
                  } catch {
                    /* best-effort */
                  }
                }

                getMetricsCollector().recordRunComplete(
                  'success_early_exit',
                  totalDurationMs,
                  steps.length,
                  tenantId,
                );
                bus.publish('agent.completed', ctx.agentId, {
                  runId,
                  status: 'success',
                  summary: safeContent.slice(0, 200),
                  tokenUsage: totalTokens,
                  durationMs: totalDurationMs,
                });

                // Record final cost for estimator learning
                try {
                  const modelCfg = this.router.getModel(routing.modelId);
                  const totalCostUsd = costEstimator.estimateForModel(
                    ctx,
                    modelCfg ?? {
                      id: routing.modelId,
                      provider: routing.provider,
                      tier: routing.tier,
                      costPer1KInput: 0.003,
                      costPer1KOutput: 0.01,
                      capabilities: [],
                      contextWindow: 128000,
                      priority: 0,
                    },
                  ).costUsd;
                  costEstimator.recordActualCost(
                    costEstimate.taskCategory,
                    routing.tier,
                    totalTokens.promptTokens,
                    totalTokens.completionTokens,
                    totalCostUsd,
                    totalDurationMs,
                    true,
                  );
                } catch {
                  /* best-effort */
                }

                return result;
              }

              // ── Hook: onSessionArchive (before checkpoint) ──
              getHookManager()
                .fireOnSessionArchive({
                  runId,
                  phase: 'tool_execution',
                  stepNumber: steps.length,
                  tokenUsage: { totalTokens: totalTokens.totalTokens },
                })
                .catch((e) =>
                  getGlobalLogger().debug('AgentRuntime', 'onSessionArchive hook failed', {
                    error: (e as Error)?.message,
                  }),
                );

              // Count successful tool results for sub-agent progress tracking
              const evidenceCount = steps.filter(
                (s) =>
                  s.type === 'tool_result' &&
                  !s.content?.startsWith('error:') &&
                  !s.content?.startsWith('TOOL_'),
              ).length;

              this.checkpointer.checkpoint({
                runId,
                agentId: ctx.agentId,
                missionId: ctx.missionId,
                timestamp: now(),
                phase: 'tool_execution',
                stepNumber: steps.length,
                attemptNumber: attempt,
                messages: request.messages,
                tokenUsage: { ...totalTokens },
                stepDurations: steps.map((s) => s.durationMs),
                context: {
                  agentId: ctx.agentId,
                  missionId: ctx.missionId,
                  projectId: ctx.projectId,
                  goal: ctx.goal,
                  availableTools: ctx.availableTools,
                  maxSteps: ctx.maxSteps,
                  tokenBudget: ctx.tokenBudget,
                },
                totalDurationMs: Date.now() - startTime,
              });

              // Enforce sub-agent progress and step limits
              ctx.guard?.check(evidenceCount);

              // Unified Verification Pipeline: tiered zero-cost-first verification
              // Governor strategy: skip LLM verification when budget is tight and model is confident
              const verifSkipDecision = this.governor.shouldApply('verification_skip');
              const shouldSkipVerification =
                verifSkipDecision.apply &&
                verifSkipDecision.intensity > 0.7 &&
                (!response.toolCalls || response.toolCalls.length === 0) &&
                isConfidentResponse(response);

              let verifReport;
              if (shouldSkipVerification) {
                // Skip verification to save tokens (500-2000 tokens saved)
                verifReport = {
                  passed: true,
                  confidence: 0.85,
                  signals: [],
                  tokensUsed: 0,
                  stagesRun: [],
                  taskType: detectTaskType(ctx.goal),
                  skipped: true,
                  skipReason: 'verification_skip_governor',
                };
                try {
                  getMetricsCollector().incrementCounter(
                    'verification_skipped_total',
                    'Verifications skipped by governor',
                    1,
                    [{ name: 'reason', value: 'governor_skip' }],
                  );
                } catch {
                  /* best-effort */
                }
              } else {
                const verifCtx: UVPTaskContext = {
                  goal: ctx.goal,
                  output: response.content,
                  language:
                    typeof ctx.goal === 'string'
                      ? ctx.goal.toLowerCase().includes('python')
                        ? 'python'
                        : undefined
                      : undefined,
                  schema: ctx.outputSchema,
                  toolsUsed: ctx.availableTools,
                  tokenBudgetRemaining: this.governor.getState().remainingTokens,
                  previousFailures: lastError ? [lastError] : undefined,
                };
                const verifStart = Date.now();
                verifReport = await this.verificationPipeline.verify(verifCtx);
                this.governor.reportUsage(verifReport.tokensUsed);
                try {
                  getMetricsCollector().recordStepLatency(
                    'verification',
                    Date.now() - verifStart,
                    getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
                  );
                } catch {
                  /* best-effort */
                }
                if (!verifReport.passed) {
                  this.recordCostByFailureMode('verification', response);
                }
              }

              // Record verification result to samples store
              this.samplesStore.recordVerification(ctx.goal, response.content, {
                passed: verifReport.passed,
                confidence: verifReport.confidence,
                signalCount: verifReport.signals.length,
                tokensUsed: verifReport.tokensUsed,
                stagesRun: verifReport.stagesRun,
                skipReason: verifReport.skipReason,
              });
              tracer.recordVerification(
                runId,
                verifReport.passed,
                verifReport.confidence,
                verifReport.signals.length,
                verifReport.tokensUsed > 0 ? 1 : 0,
              );
              try {
                getMetricsCollector().recordVerificationResult(
                  verifReport.confidence,
                  verifReport.passed,
                  verifReport.signals.length,
                  verifReport.signals.map(
                    (s) =>
                      (s as { type?: string }).type ?? (s as { name?: string }).name ?? 'unknown',
                  ),
                  getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
                );
              } catch {
                /* best-effort */
              }
              try {
                getVerificationReportStore(ctx.tenantId).write({
                  schemaVersion: 1,
                  runId,
                  agentId: ctx.agentId,
                  capturedAt: new Date().toISOString(),
                  attempt,
                  passed: verifReport.passed,
                  confidence: verifReport.confidence,
                  skipReason: verifReport.skipReason,
                  outputPrefix: response.content.slice(0, 5000),
                  goal: ctx.goal.slice(0, 1000),
                  report: verifReport,
                });
              } catch {
                /* best-effort */
              }

              this.checkpointer.checkpoint({
                runId,
                agentId: ctx.agentId,
                missionId: ctx.missionId,
                timestamp: now(),
                phase: 'verification',
                stepNumber: steps.length,
                attemptNumber: attempt,
                messages: request.messages,
                tokenUsage: { ...totalTokens },
                stepDurations: steps.map((s) => s.durationMs),
                context: {
                  agentId: ctx.agentId,
                  missionId: ctx.missionId,
                  projectId: ctx.projectId,
                  goal: ctx.goal,
                  availableTools: ctx.availableTools,
                  maxSteps: ctx.maxSteps,
                  tokenBudget: ctx.tokenBudget,
                },
                lastError,
                totalDurationMs: Date.now() - startTime,
              });

              // Tier 3.2: Record reflection from this verification attempt so future
              // retries can learn from prior outcomes (Reflexion: Shinn et al., 2023).
              const reflectionInsight: ReflectionEntry = verifReport.passed
                ? {
                    id: `${runId}-${attempt}-ok`,
                    insight: `Attempt ${attempt + 1} passed verification with confidence ${verifReport.confidence.toFixed(2)}.`,
                    type: 'success',
                    timestamp: Date.now(),
                  }
                : {
                    id: `${runId}-${attempt}-fail`,
                    insight: `Attempt ${attempt + 1} failed verification: ${(verifReport.signals[0] && ((verifReport.signals[0] as { type?: string }).type ?? (verifReport.signals[0] as { name?: string }).name)) || 'unknown'} signal.`,
                    type: 'failure',
                    timestamp: Date.now(),
                  };
              this.reflexionInjector.addReflection(reflectionInsight);

              // Semantic circuit breaker: track consecutive verification failures.
              // When verification repeatedly fails, the circuit breaker can trigger
              // semantic-level intervention (e.g., escalate to stronger model).
              if (!verifReport.passed) {
                this.circuitBreaker.recordSemanticFailure(
                  `verification_failed: ${(verifReport.signals[0] && ((verifReport.signals[0] as { type?: string }).type ?? (verifReport.signals[0] as { name?: string }).name)) || 'unknown'}`,
                );
              } else {
                this.circuitBreaker.recordSemanticSuccess();
              }

              if (!verifReport.passed && attempt < this.config.maxRetries) {
                const maxReflexion = this.config.reflexionMaxIterations ?? 2;

                // Tier 3.2 (RFC v2): explicit reflection-driven self-correction loop for
                // low-confidence verification failures. Heuristic-only generation avoids
                // an extra LLM call; cap iterations to prevent runaway cost.
                if (verifReport.confidence < 0.5 && maxReflexion > 0) {
                  let reflexionAttempt = 0;
                  let currentFeedback = this.verificationPipeline.toFeedback(verifReport);

                  while (
                    reflexionAttempt < maxReflexion &&
                    currentFeedback &&
                    !verifReport.passed
                  ) {
                    reflexionAttempt++;

                    const firstSignal = verifReport.signals[0];
                    const reflexionCtx: ReflexionContext = {
                      goal: ctx.goal,
                      attemptedAction: 'LLM response generation',
                      actionResult: response.content,
                      error:
                        (firstSignal &&
                          ((firstSignal as { message?: string }).message ??
                            (firstSignal as { name?: string }).name)) ||
                        'verification failed',
                      errorClass: 'permanent',
                      attemptNumber: reflexionAttempt,
                    };

                    const reflexion = await this.reflexionGenerator.generate(reflexionCtx);

                    this.reflexionInjector.addReflection({
                      id: `${runId}-${attempt}-reflexion-${reflexionAttempt}`,
                      insight: ReflexionGenerator.formatForContext(reflexionCtx, reflexion),
                      type: 'failure',
                      timestamp: Date.now(),
                    });

                    request.messages.push({
                      role: 'system',
                      content: `[Reflexion guidance ${reflexionAttempt}/${maxReflexion}]\n${ReflexionGenerator.formatForContext(reflexionCtx, reflexion)}`,
                    });
                    request.messages.push({ role: 'user', content: currentFeedback });

                    const reflexionStart = Date.now();
                    const reflexionResponse = await this.callWithTimeout(request, routing, attempt);
                    if (!reflexionResponse) break;

                    response = reflexionResponse;
                    totalTokens.promptTokens += reflexionResponse.usage.promptTokens;
                    totalTokens.completionTokens += reflexionResponse.usage.completionTokens;
                    totalTokens.totalTokens += reflexionResponse.usage.totalTokens;
                    this.governor.reportUsage(reflexionResponse.usage.totalTokens);

                    verifReport = await this.verificationPipeline.verify({
                      goal: ctx.goal,
                      output: response.content,
                      language:
                        typeof ctx.goal === 'string'
                          ? ctx.goal.toLowerCase().includes('python')
                            ? 'python'
                            : undefined
                          : undefined,
                      schema: ctx.outputSchema,
                      toolsUsed: ctx.availableTools,
                      tokenBudgetRemaining: this.governor.getState().remainingTokens,
                      previousFailures: lastError ? [lastError] : undefined,
                    });
                    this.governor.reportUsage(verifReport.tokensUsed);

                    try {
                      getMetricsCollector().recordStepLatency(
                        'reflexion',
                        Date.now() - reflexionStart,
                        getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
                      );
                    } catch {
                      /* best-effort */
                    }

                    if (!verifReport.passed) {
                      currentFeedback = this.verificationPipeline.toFeedback(verifReport);
                    }
                  }
                }

                const feedback = this.verificationPipeline.toFeedback(verifReport);
                if (feedback && !verifReport.passed) {
                  this.recordCostByFailureMode('verification', response);
                  lastError = feedback;
                  tracer.recordDecision(
                    runId,
                    `verification (attempt ${attempt + 1}, confidence ${verifReport.confidence.toFixed(2)}): ${feedback.slice(0, 100)}`,
                    0,
                  );

                  // Compact context before retry to avoid replaying bloated history.
                  // First, record which messages correlated with this verification failure
                  // so the compactor can prune failure-prone context first.
                  const failureSignal =
                    (verifReport.signals[0] &&
                      ((verifReport.signals[0] as { type?: string }).type ??
                        (verifReport.signals[0] as { name?: string }).name)) ||
                    undefined;
                  this.compactor.recordFailureCorrelation(runId, request.messages, failureSignal);

                  const tokensBeforeRetry = this.compactor.getUsage(request.messages).total;
                  const tt = detectTaskType(ctx.goal);
                  const taskType: CompactTaskType = tt === 'creative' ? 'general' : tt;
                  const retryCompact = this.compactor.compact(
                    request.messages,
                    undefined,
                    taskType,
                  );
                  if (retryCompact.action.droppedCount > 0) {
                    request.messages = retryCompact.messages;
                    this.governor.recordOutcome(
                      'context_compaction',
                      tokensBeforeRetry,
                      this.compactor.getUsage(request.messages).total,
                    );
                    bus.publish('system.alert', 'runtime', {
                      type: 'context_compaction',
                      layer: retryCompact.action.layer,
                      droppedCount: retryCompact.action.droppedCount,
                      tokensSaved: retryCompact.action.tokensSaved,
                    });
                  }

                  // Cascade escalation: try a more capable model on verification failure
                  // FrugalGPT pattern: escalate to stronger model when quality is insufficient
                  // Uses the escalation chain from routeWithCascade if available, otherwise falls back to getFallbackModel
                  let fallbackModel: ModelConfig | undefined;
                  if (this.smartRouter && currentEscalationChain.length > 0) {
                    const nextId = this.smartRouter.getNextEscalation(
                      routing.modelId,
                      currentEscalationChain.map((m) => m.id),
                    );
                    fallbackModel = nextId
                      ? (this.router.getModel(nextId.id) ?? undefined)
                      : undefined;
                  } else {
                    fallbackModel =
                      currentEscalationChain.length > 0
                        ? this.router.getNextEscalation(routing.modelId, currentEscalationChain)
                        : this.router.getFallbackModel(routing.modelId, tt);
                  }
                  if (fallbackModel && fallbackModel.tier !== routing.tier) {
                    const newRouting: RoutingDecision = {
                      modelId: fallbackModel.id,
                      tier: fallbackModel.tier,
                      provider: fallbackModel.provider,
                      reasoning: [
                        ...routing.reasoning,
                        `cascade_escalation: ${routing.modelId} → ${fallbackModel.id} (verification failed)`,
                      ],
                      estimatedCost: routing.estimatedCost * 1.5,
                      maxTokens: routing.maxTokens,
                    };
                    routing = newRouting;
                    // Remove the escalated model from the chain so we don't escalate to it again
                    currentEscalationChain = currentEscalationChain.filter(
                      (m) => m.id !== fallbackModel.id,
                    );
                    request.model =
                      (fallbackModel.id || '').replace(/@\w+$/, '') || fallbackModel.id;
                    tracer.recordDecision(
                      runId,
                      `cascade escalation: ${routing.modelId} (${routing.tier}) chain_remaining=${currentEscalationChain.length}`,
                      0,
                    );
                    bus.publish('system.alert', 'runtime', {
                      type: 'cascade_escalation',
                      from: routing.modelId,
                      to: fallbackModel.id,
                    });
                    try {
                      getMetricsCollector().recordCascadeEscalation(
                        routing.modelId,
                        fallbackModel.id,
                        'verification_failed',
                        getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
                      );
                    } catch {
                      /* best-effort */
                    }
                    try {
                      getIntentLog(ctx.tenantId).write({
                        schemaVersion: 1,
                        runId,
                        capturedAt: new Date().toISOString(),
                        stage: 'agentRuntime.cascade',
                        decision: 'escalate',
                        reason: 'verification_failed',
                        payload: { from: routing.modelId, to: fallbackModel.id },
                      });
                    } catch {
                      /* best-effort */
                    }
                  }

                  const reflections = this.reflexionInjector.getRecentReflections(3);
                  const augmentedFeedback =
                    reflections.length > 0
                      ? `${feedback}\n\n[Recent reflections — use these to avoid repeating mistakes]:\n${reflections.map((r, i) => `${i + 1}. ${r.insight}`).join('\n')}`
                      : feedback;
                  request.messages.push({ role: 'user', content: augmentedFeedback });
                  continue;
                }
              }

              // Content safety scan before returning result
              // Reasoning models (MiMo, DeepSeek-R) put output in reasoning_content.
              // Merge so downstream code (synthesis, summary) can read it.
              let safeContent =
                response.content ||
                (response as { reasoning_content?: string }).reasoning_content ||
                '';
              try {
                const scanResult = await this.contentScanner.scan(safeContent);
                if (!scanResult.isSafe) {
                  const criticalThreats = scanResult.threats.filter(
                    (t) => t.severity === 'HIGH' || t.severity === 'CRITICAL',
                  );
                  if (criticalThreats.length > 0) {
                    bus.publish('system.alert', 'runtime', {
                      type: 'content_threat_blocked',
                      threats: criticalThreats.map((t) => `${t.type}:${t.severity}`),
                    });
                    safeContent = `[Content blocked: ${criticalThreats.length} security threat(s) detected. Review and resubmit.]`;
                  }
                }
              } catch (e) {
                getGlobalLogger().warn('AgentRuntime', 'Content scan failed (best-effort)', {
                  error: (e as Error)?.message,
                });
              }

              // Output format: apply configurable formatting preference to the summary
              // - 'concise': truncate verbose responses to first paragraph
              // - 'structured': if response looks like JSON, pass through; otherwise no transformation
              // - 'freeform' and 'auto': pass through without transformation
              const outputFormat = this.config.outputFormat ?? 'auto';
              if (outputFormat === 'concise' && safeContent && safeContent.length > 500) {
                const firstParagraph = safeContent.split('\n\n')[0];
                if (firstParagraph && firstParagraph.length > 50) {
                  safeContent = firstParagraph;
                }
              } else if (outputFormat === 'structured' && safeContent) {
                try {
                  JSON.parse(safeContent);
                } catch {
                  // Not JSON — no transformation applied
                }
              }

              // If the final response has no text content (tool_call-only response),
              // find the last text response from the step history for the summary.
              if (!safeContent || safeContent.length === 0) {
                for (let si = steps.length - 1; si >= 0; si--) {
                  const s = steps[si];
                  if (s.type === 'response' && s.content && !s.content.includes('<tool_call>')) {
                    safeContent = s.content;
                    break;
                  }
                }
              }

              // If still empty, use the last tool result or provisioning data as summary
              if (!safeContent || safeContent.length === 0) {
                // Look for the last system message with tool results (provisioning injected)
                for (let mi = request.messages.length - 1; mi >= 0; mi--) {
                  const msg = request.messages[mi];
                  if (msg.role === 'system' && msg.content?.startsWith('[Tool:')) {
                    safeContent = msg.content.slice(0, 2000);
                    break;
                  }
                }
              }

              // Last resort: use the last step's content (even if tool result)
              if (!safeContent || safeContent.length === 0) {
                for (let si = steps.length - 1; si >= 0; si--) {
                  const s = steps[si];
                  if (s.content && s.content.length > 0) {
                    safeContent = s.content.slice(0, 2000);
                    break;
                  }
                }
              }

              // Absolute last resort: reflect the goal
              if (!safeContent || safeContent.length === 0) {
                safeContent = `[No text response generated by agent] Goal: ${ctx.goal.slice(0, 200)}`;
              }

              const totalDurationMs = Date.now() - startTime;
              const result: AgentExecutionResult = {
                runId,
                agentId: ctx.agentId,
                missionId: ctx.missionId,
                status: 'success',
                summary: safeContent,
                steps,
                totalTokenUsage: totalTokens,
                totalDurationMs,
                artifactContent: largestFileWriteContent || undefined,
              };

              // Record final actual cost for estimator learning
              try {
                const modelCfg = this.router.getModel(routing.modelId);
                const totalCostUsd = costEstimator.estimateForModel(
                  ctx,
                  modelCfg ?? {
                    id: routing.modelId,
                    provider: routing.provider,
                    tier: routing.tier,
                    costPer1KInput: 0.003,
                    costPer1KOutput: 0.01,
                    capabilities: [],
                    contextWindow: 128000,
                    priority: 0,
                  },
                ).costUsd;
                costEstimator.recordActualCost(
                  costEstimate.taskCategory,
                  routing.tier,
                  totalTokens.promptTokens,
                  totalTokens.completionTokens,
                  totalCostUsd,
                  totalDurationMs,
                  true,
                );
                // Log prediction accuracy for observability
                const accuracy =
                  costEstimate.predictedTotalTokens > 0
                    ? Math.min(
                        2,
                        Math.max(0.1, totalTokens.totalTokens / costEstimate.predictedTotalTokens),
                      )
                    : 1.0;
                getMetricsCollector().setGauge(
                  'cost_prediction_accuracy',
                  'Ratio of actual to predicted tokens (1.0 = perfect)',
                  accuracy,
                  [
                    { name: 'task_category', value: costEstimate.taskCategory },
                    { name: 'model_tier', value: routing.tier },
                  ],
                );
              } catch {
                /* best-effort learning */
              }

              this.checkpointer.terminalCheckpoint({
                runId,
                agentId: ctx.agentId,
                missionId: ctx.missionId,
                timestamp: now(),
                phase: 'completed',
                stepNumber: steps.length,
                attemptNumber: attempt,
                messages: request.messages,
                tokenUsage: { ...totalTokens },
                stepDurations: steps.map((s) => s.durationMs),
                context: {
                  agentId: ctx.agentId,
                  missionId: ctx.missionId,
                  projectId: ctx.projectId,
                  goal: ctx.goal,
                  availableTools: ctx.availableTools,
                  maxSteps: ctx.maxSteps,
                  tokenBudget: ctx.tokenBudget,
                },
                totalDurationMs,
              });

              if (this.memory) {
                try {
                  this.memory.add(
                    `[SUCCESS] ${ctx.goal.slice(0, 200)}`,
                    'episodic',
                    `run:${runId}|tokens:${totalTokens.totalTokens}|dur:${totalDurationMs}ms|steps:${steps.length}`,
                    0.7,
                    ['execution', 'success', ...ctx.availableTools.slice(0, 3)],
                    {
                      runId,
                      goal: ctx.goal.slice(0, 500),
                      tokenUsage: totalTokens,
                      durationMs: totalDurationMs,
                    },
                  );
                } catch (e) {
                  getGlobalLogger().warn('AgentRuntime', 'Failed to record success memory', {
                    error: (e as Error)?.message,
                  });
                }
              }

              // Fire plugin onAgentComplete hooks
              getHookManager()
                .fireOnAgentComplete({ result, runId })
                .catch((e) =>
                  getGlobalLogger().debug('AgentRuntime', 'onAgentComplete hook failed', {
                    error: (e as Error)?.message,
                  }),
                );

              // Emit completed event
              getMetricsCollector().recordRunComplete(
                'success',
                totalDurationMs,
                steps.length,
                tenantId,
              );
              bus.publish('agent.completed', ctx.agentId, {
                runId,
                missionId: ctx.missionId,
                summary: result.summary,
                tokenUsage: totalTokens,
                durationMs: totalDurationMs,
              });

              this.circuitBreaker.onSuccess();
              circuitReleased = true;
              if (this.runHandle) {
                try {
                  getExecutionScheduler().commitRun({
                    runId,
                    leaseToken: this.runHandle.leaseToken,
                    fencingEpoch: this.runHandle.fencingEpoch,
                    tenantId: getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
                  });
                } catch (e) {
                  getGlobalLogger().debug('AgentRuntime', 'Scheduler commitRun failed', {
                    runId,
                    error: (e as Error).message,
                  });
                }
              }
              return result;
            }

            // Handle failure with error classification
            const ce = classifyLLMError(new Error(lastError || 'Unknown error'));
            lastError = ce.message;
            lastErrorIsPermanent = !ce.retryable;
            tracer.recordError(runId, `${ce.errorClass}: ${ce.message}`, Date.now() - startTime);

            if (ce.retryable && attempt < this.config.maxRetries) {
              const delayMs = ce.retryAfter ?? computeBackoff(attempt, this.config.retryDelayMs);
              await delay(delayMs);
            } else if (!ce.retryable) {
              this.circuitBreaker.onFailure();
              circuitReleased = true;
              break; // Don't retry permanent errors
            }
          }

          // All attempts failed
          tracer.recordError(
            runId,
            `All ${this.config.maxRetries + 1} attempts failed`,
            Date.now() - startTime,
          );

          // Record final actual cost for failed run (for estimator learning)
          try {
            const modelCfg = this.router.getModel(routing.modelId);
            const totalCostUsd = costEstimator.estimateForModel(
              ctx,
              modelCfg ?? {
                id: routing.modelId,
                provider: routing.provider,
                tier: routing.tier,
                costPer1KInput: 0.003,
                costPer1KOutput: 0.01,
                capabilities: [],
                contextWindow: 128000,
                priority: 0,
              },
            ).costUsd;
            costEstimator.recordActualCost(
              costEstimate.taskCategory,
              routing.tier,
              totalTokens.promptTokens,
              totalTokens.completionTokens,
              totalCostUsd,
              Date.now() - startTime,
              false,
            );
            // Record model performance failure for cross-session learning
            this.router.recordOutcome(
              routing.modelId,
              costEstimate.taskCategory,
              false,
              Date.now() - startTime,
              totalTokens.totalTokens,
            );
            try {
              getModelPerformanceStore().record({
                modelId: routing.modelId,
                taskType: costEstimate.taskCategory,
                success: false,
                durationMs: Date.now() - startTime,
                tokensUsed: totalTokens.totalTokens,
                timestamp: Date.now(),
              });
            } catch {
              /* best-effort */
            }
          } catch {
            /* best-effort learning */
          }

          // Fire plugin onError hooks
          getHookManager()
            .fireOnError({ error: lastError ?? 'Unknown error', runId, agentId: ctx.agentId })
            .catch((e) =>
              getGlobalLogger().debug('AgentRuntime', 'onError hook failed', {
                error: (e as Error)?.message,
              }),
            );

          this.checkpointer.terminalCheckpoint({
            runId,
            agentId: ctx.agentId,
            missionId: ctx.missionId,
            timestamp: now(),
            phase: 'failed',
            stepNumber: steps.length,
            attemptNumber: this.config.maxRetries,
            messages: request.messages,
            tokenUsage: { ...totalTokens },
            stepDurations: steps.map((s) => s.durationMs),
            context: {
              agentId: ctx.agentId,
              missionId: ctx.missionId,
              projectId: ctx.projectId,
              goal: ctx.goal,
              availableTools: ctx.availableTools,
              maxSteps: ctx.maxSteps,
              tokenBudget: ctx.tokenBudget,
            },
            lastError,
            totalDurationMs: Date.now() - startTime,
          });

          if (this.memory) {
            try {
              this.memory.add(
                `[FAIL] ${ctx.goal.slice(0, 200)}`,
                'episodic',
                `run:${runId}|error:${(lastError ?? 'unknown').slice(0, 100)}|dur:${Date.now() - startTime}ms`,
                0.5 + (lastErrorIsPermanent ? 0.3 : 0),
                ['execution', 'failure', ...ctx.availableTools.slice(0, 3)],
                { runId, goal: ctx.goal.slice(0, 500), error: lastError },
              );
            } catch (e) {
              getGlobalLogger().warn('AgentRuntime', 'Failed to record failure memory', {
                error: (e as Error)?.message,
              });
            }
          }

          getMetricsCollector().recordRunComplete(
            'failed',
            Date.now() - startTime,
            steps.length,
            tenantId,
          );
          bus.publish('agent.failed', ctx.agentId, {
            runId,
            missionId: ctx.missionId,
            error: lastError,
          });

          return {
            runId,
            agentId: ctx.agentId,
            missionId: ctx.missionId,
            status: 'failed',
            summary: lastError ?? 'Unknown error',
            steps,
            totalTokenUsage: totalTokens,
            totalDurationMs: Date.now() - startTime,
            error: lastError,
          };
        },
      );

      // GAP-08: Call scheduler abortRun for failed runs — triggers compensation
      // for any recorded compensable actions and releases the scheduler-level lease.
      // On success, commitRun is called inside the runWithTenant callback (line ~2002).
      if (execResult && execResult.status === 'failed' && this.runHandle) {
        const handle = this.runHandle as RunHandle;
        try {
          await getExecutionScheduler().abortRun({
            runId,
            leaseToken: handle.leaseToken,
            fencingEpoch: handle.fencingEpoch,
            tenantId: getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
            reason: execResult.error ?? 'execution failed',
          });
        } catch (e) {
          getGlobalLogger().debug('AgentRuntime', 'Scheduler abortRun failed', {
            runId,
            error: (e as Error).message,
          });
        }
      }

      return execResult;
    } finally {
      // Release circuit breaker if neither onSuccess nor onFailure was called
      if (!circuitReleased) this.circuitBreaker.release();
      // GAP-02 + GAP-05: Guarantee cleanup on ALL exit paths (normal, error, exception)
      this.activeRuns.delete(runId);
      getMetricsCollector().setGauge('active_runs', 'Active concurrent runs', this.activeRuns.size);
      if (tenantCfg?.enabled && tenantCfg.maxConcurrency > 0 && tenantId) {
        const c = (this.tenantRunningCounts.get(tenantId) ?? 1) - 1;
        if (c <= 0) this.tenantRunningCounts.delete(tenantId);
        else this.tenantRunningCounts.set(tenantId, c);
      }
      getLaneManager().releaseSlot(currentLane);
      this.releaseSlot();
      try {
        tracer.completeRun(runId);
      } catch (e) {
        getGlobalLogger().warn('AgentRuntime', 'Failed to complete trace', {
          runId,
          error: (e as Error)?.message,
        });
      }
      // Export trace to OpenTelemetry if configured
      if (this.otelExporter) {
        try {
          const trace = tracer.getTrace(runId);
          if (trace) {
            const otelSpans = executionTraceToOtlpSpans(trace);
            for (const span of otelSpans) {
              this.otelExporter.exportSpan(span);
            }
          }
        } catch (e) {
          getGlobalLogger().warn('AgentRuntime', 'Failed to export OTel spans', {
            runId,
            error: (e as Error)?.message,
          });
        }
      }
      // Auto-export SOP template on successful execution
      if (execResult?.status === 'success') {
        try {
          const trace = tracer.getTrace(runId);
          if (trace) {
            const sop = exportSOPFromTrace(trace);
            if (sop) {
              const sopDir = path.join(this.config.sopDir || '.commander/sops', ctx.agentId);
              fs.mkdirSync(sopDir, { recursive: true });
              const sopPath = path.join(sopDir, `${runId}.md`);
              fs.writeFileSync(sopPath, formatSOPAsMarkdown(sop), 'utf-8');
              // Also write structured JSON for API retrieval
              const jsonPath = path.join(sopDir, `${runId}.json`);
              fs.writeFileSync(jsonPath, JSON.stringify(sop, null, 2), 'utf-8');
              getGlobalLogger().debug('AgentRuntime', 'SOP auto-exported', {
                runId,
                path: sopPath,
              });
              // Publish bus event for SSE streaming and API visibility
              getMessageBus().publish('sop.generated', ctx.agentId, {
                runId,
                agentId: ctx.agentId,
                goal: sop.goal,
                path: sopPath,
                stepCount: sop.totalSteps,
                status: 'success',
                tags: sop.tags,
              });
            }
          }
        } catch (e) {
          getGlobalLogger().debug('AgentRuntime', 'SOP auto-export failed', {
            runId,
            error: (e as Error)?.message,
          });
        }
      }
      try {
        await this.samplesStore.flush();
      } catch (e) {
        getGlobalLogger().warn('AgentRuntime', 'Failed to flush samples', {
          runId,
          error: (e as Error)?.message,
        });
      }
      try {
        this.traceStore.flushAll();
      } catch (e) {
        getGlobalLogger().warn('AgentRuntime', 'Failed to flush traces', {
          runId,
          error: (e as Error)?.message,
        });
      }
      this.restoreTenantOverrides(tenantOverrides, tenantId);
    }
  }

  private async callWithTimeout(
    request: LLMRequest,
    routing: RoutingDecision,
    attemptNumber: number = 0,
    taskId?: string,
  ): Promise<LLMResponse | null> {
    // Build fallback chain: primary provider first, then all others as backups.
    // ProviderFallbackChain handles circuit-breaker-aware sequential failover.
    const primaryProvider = this.providers.get(routing.provider);
    const entries: ProviderEntry<import('./types').LLMResponse>[] = [];

    if (primaryProvider) {
      entries.push({
        name: routing.provider,
        attempt: () =>
          this.callProviderOrThrow(
            primaryProvider,
            routing.provider,
            request,
            attemptNumber,
            taskId,
          ),
      });
    }

    for (const [name, provider] of this.providers) {
      if (name === routing.provider) continue;
      entries.push({
        name,
        attempt: () => this.callProviderOrThrow(provider, name, request, attemptNumber, taskId),
      });
    }

    if (entries.length === 0) {
      this.samplesStore.recordLLMCall(request, null, {
        provider: 'none',
        durationMs: 0,
        attemptNumber,
        error: 'No provider available',
      });
      return null;
    }

    try {
      const { result } = await this.fallbackChain.tryProviders(entries);
      return result;
    } catch (err) {
      if (err instanceof FallbackChainExhaustedError) {
        this.samplesStore.recordLLMCall(request, null, {
          provider: 'fallback_exhausted',
          durationMs: 0,
          attemptNumber,
          error: err.message,
        });
      }
      getGlobalLogger().warn('AgentRuntime', 'All providers exhausted in fallback chain', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Thin forwarder that adapts callProvider's nullable return for ProviderFallbackChain.
   *  ProviderFallbackChain treats non-throwing returns as success, so we throw on null. */
  private async callProviderOrThrow(
    provider: LLMProvider,
    providerName: string,
    request: LLMRequest,
    attemptNumber: number,
    taskId?: string,
  ): Promise<import('./types').LLMResponse> {
    const result = await this.callProvider(provider, providerName, request, attemptNumber, taskId);
    if (!result) {
      throw new Error(`Provider "${providerName}" returned null (likely timeout or unavailable)`);
    }
    return result;
  }

  private async callProvider(
    provider: LLMProvider,
    providerName: string,
    request: LLMRequest,
    attemptNumber: number,
    taskId?: string,
  ): Promise<LLMResponse | null> {
    const startMs = Date.now();
    try {
      const cached = await this.semanticCache.lookup(request);
      if (cached) {
        try {
          getMetricsCollector().recordSemanticCacheEvent(
            'hit',
            0,
            getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
          );
        } catch {
          /* best-effort */
        }
        return cached;
      }
      try {
        getMetricsCollector().recordSemanticCacheEvent(
          'miss',
          0,
          getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
        );
      } catch {
        /* best-effort */
      }

      // Google Gemini cachedContent wiring: when the provider is Google and the request carries
      // a system prompt, try to attach a server-side cached content name. Failures fall through
      // (cachedContent is a cost optimization, not a correctness requirement).
      if (providerName === 'google' && request.cacheConfig) {
        const systemMsg = request.messages.find((m) => m.role === 'system');
        const tenantForGemini = getGlobalTenantProvider().getCurrentTenantId() ?? undefined;
        try {
          const lookup = await this.geminiCache.getOrCreate({
            systemInstruction: systemMsg?.content,
            tools: request.tools,
            model: request.model,
            apiKey: process.env.GOOGLE_API_KEY ?? '',
            baseUrl: process.env.GOOGLE_BASE_URL,
            tenantId: tenantForGemini,
          });
          if (lookup.cachedContentName) {
            request.cacheConfig.geminiCachedContentName = lookup.cachedContentName;
            try {
              getMetricsCollector().recordGeminiCacheEvent(
                lookup.createdNow ? 'create' : 'hit',
                tenantForGemini,
              );
            } catch {
              /* best-effort */
            }
          }
        } catch {
          try {
            getMetricsCollector().recordGeminiCacheEvent('error', tenantForGemini);
          } catch {
            /* best-effort */
          }
        }
      }

      const tenantIdForFlight = getGlobalTenantProvider().getCurrentTenantId() ?? undefined;
      const flightKey = SingleFlightRequestCache.computeKey(request, tenantIdForFlight);
      const evictionsBefore = this.singleFlight.getStats().evictions;
      const inflightBefore = this.singleFlight.inflightCount();
      let result: LLMResponse;
      const llmTimeoutMs = this.config.llmTimeoutMs ?? 120000;
      result = await this.singleFlight.dedupe(
        flightKey,
        async () => {
          return this.stepTimeout.wrap(provider.call(request), {
            timeoutMs: llmTimeoutMs,
            stepId: `llm-${providerName}-${attemptNumber}-${taskId ?? 'main'}`,
          });
        },
        tenantIdForFlight,
      );
      const recentEvictionDelta = this.singleFlight.getStats().evictions - evictionsBefore;
      const wasHit = this.singleFlight.inflightCount() === inflightBefore;
      try {
        getMetricsCollector().recordSingleFlightEvent(wasHit ? 'hit' : 'miss', tenantIdForFlight);
      } catch {
        /* best-effort */
      }
      if (recentEvictionDelta > 0) {
        try {
          getMetricsCollector().recordSingleFlightEvent('eviction', tenantIdForFlight);
        } catch {
          /* best-effort */
        }
      }
      this.semanticCache.store(request, result);
      try {
        getMetricsCollector().recordSemanticCacheEvent(
          'store',
          0,
          getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
        );
      } catch {
        /* best-effort */
      }

      this.samplesStore.recordLLMCall(request, result, {
        provider: providerName,
        durationMs: Date.now() - startMs,
        attemptNumber,
        taskId,
      });
      return result;
    } catch (err) {
      this.samplesStore.recordLLMCall(request, null, {
        provider: providerName,
        durationMs: Date.now() - startMs,
        attemptNumber,
        error: String(err),
        taskId,
      });
      getGlobalLogger().error('AgentRuntime', 'Provider call failed', err as Error);
      return null;
    }
  }

  /** Tier 4.4 helper: estimate cost of a failed step and attribute it to a failure mode. */
  private recordCostByFailureMode(mode: string, response?: LLMResponse | null): void {
    if (!response) return;
    try {
      const costUsd = getCostEstimator().estimateCostFromUsage(
        response.model,
        response.usage.promptTokens,
        response.usage.completionTokens,
      );
      getMetricsCollector().recordCostByFailureMode(
        mode,
        costUsd,
        getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
      );
    } catch {
      /* best-effort */
    }
  }

  /**
   * Execute a tool call and return STRUCTURED error context to the model.
   * Instead of silently logging errors, the model receives enough context
   * to reason about the failure and decide next steps.
   */
  private async executeTool(
    runId: string,
    toolCall: ToolCall,
    agentId: string,
    tenantId?: string,
    allowedTools?: string[],
    agentCtx?: AgentExecutionContext,
  ): Promise<ToolResult> {
    const tracer = getTraceRecorder();
    const bus = getMessageBus();
    const startTime = Date.now();
    try {
      // Sub-agent tool whitelist enforcement: if an allowlist is provided,
      // reject any tool call outside the allowed set.
      if (allowedTools && !allowedTools.includes(toolCall.name)) {
        const errorMsg = `TOOL_NOT_ALLOWED: "${toolCall.name}" is not in the allowed tools list for this agent. Allowed: ${allowedTools.join(', ')}`;
        bus.publish('tool.blocked', agentId, {
          runId,
          toolName: toolCall.name,
          reason: 'not_allowed',
          detail: errorMsg,
        });
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: errorMsg,
          error: errorMsg,
          durationMs: 0,
        };
      }

      const reversibility = this.compensationRegistry.assessReversibility(toolCall.name);
      if (reversibility === 'non_reversible') {
        bus.publish('system.alert', 'runtime', {
          type: 'non_reversible_tool',
          tool: toolCall.name,
          runId,
          agentId,
        });
      }

      // ── Hook: beforeToolResolve (can block by returning ToolResult) ──
      const resolveBlock = await getHookManager().fireBeforeToolResolve({
        toolName: toolCall.name,
        args: toolCall.arguments,
        agentId,
        runId,
      });
      if (resolveBlock !== null) {
        bus.publish('tool.blocked', agentId, {
          runId,
          toolName: toolCall.name,
          reason: 'hook_blocked',
          detail: resolveBlock.error ?? '',
        });
        return resolveBlock;
      }

      const tool = this.tools.get(toolCall.name);
      const toolFound = !!tool;

      // ── Hook: afterToolResolve ──
      getHookManager()
        .fireAfterToolResolve({
          toolName: toolCall.name,
          args: toolCall.arguments,
          tool: tool
            ? { name: tool.definition.name, category: tool.definition.category }
            : undefined,
          notFound: !toolFound,
          agentId,
          runId,
        })
        .catch((e) =>
          getGlobalLogger().debug('AgentRuntime', 'afterToolResolve hook failed', {
            error: (e as Error)?.message,
          }),
        );

      if (!tool) {
        const error = `TOOL_NOT_FOUND: "${toolCall.name}" is not registered. Available: ${Array.from(this.tools.keys()).join(', ')}`;
        tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, '', 0, error);
        // Record to DLQ for dead-letter analysis
        this.dlq.record({
          id: this.generateActionId(),
          category: 'tool',
          runId,
          agentId,
          timestamp: new Date().toISOString(),
          errorClass: 'permanent',
          errorMessage: error,
          retryable: false,
          attemptNumber: 0,
          operationName: toolCall.name,
          inputSnapshot: JSON.stringify(toolCall.arguments).slice(0, 500),
          compensated: false,
          recovered: false,
          tags: ['tool_not_found', 'mode:1'],
        });
        const errorMsg = `error: ${error}\nadvice: Check the tool name and try again with a registered tool.`;
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: errorMsg,
          error: errorMsg,
          durationMs: 0,
        };
      }

      // Hallucination rejection gate (arXiv:2604.21816):
      // If the tool was not promoted to Tier 1 (full schema), the model shouldn't call it directly.
      // Reject with guidance to use request_tool first. This prevents hallucinated tool calls.
      if (this.promotedTools.size > 0 && !this.promotedTools.has(toolCall.name)) {
        const available = Array.from(this.promotedTools)
          .filter((n) => n !== 'request_tool')
          .join(', ');
        const errorMsg = `TOOL_NOT_PROMOTED: "${toolCall.name}" was not in the active tool set for this turn. Use request_tool to load it first, or use one of: ${available}`;
        getGlobalLogger().debug(
          'AgentRuntime',
          `Hallucination gate: rejected call to non-promoted tool "${toolCall.name}"`,
        );
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: errorMsg,
          error: errorMsg,
          durationMs: 0,
        };
      }

      // Record compensable action for mutation tools before execution
      const isMutation = isMutationTool(toolCall.name);
      const actionId = this.generateActionId();
      if (isMutation) {
        this.compensationRegistry.recordAction({
          actionId,
          toolName: toolCall.name,
          args: toolCall.arguments as Record<string, unknown>,
          description: `${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`,
          tags: ['tool', toolCall.name],
          runId,
          agentId,
        });
        const filePath = toolCall.arguments.filePath ?? toolCall.arguments.path;
        if (typeof filePath === 'string' && toolCall.name !== 'file_delete') {
          try {
            const fs = await import('fs');
            if (fs.existsSync(filePath)) {
              fs.copyFileSync(filePath, `${filePath}.atr-snapshot.${actionId}`);
            }
          } catch (err) {
            getGlobalLogger().debug('AgentRuntime', 'Snapshot pre-mutation failed', {
              filePath,
              actionId,
              error: (err as Error).message,
            });
          }
        }
      }

      const effectiveTimeout = tool.timeout ?? this.config.timeoutMs;

      // Validate and repair tool call arguments before execution
      const { args: repairedArgs, repairs } = repairToolCallArguments(
        toolCall.arguments,
        toolCall.name,
      );
      const schema = tool.compiledSchema ?? ToolRegistry.getCompiledSchema(toolCall.name);
      let validatedArgs = repairedArgs;
      if (schema) {
        const validation = validateToolCall(repairedArgs, schema);
        if (!validation.valid) {
          const errorFeedback = formatValidationErrors(validation.errors, toolCall.name, repairs);
          const structuredFeedback = formatValidationErrorsJson(
            validation.errors,
            toolCall.name,
            validation.repairs ?? repairs,
            validation.repairedArgs,
          );
          structuredFeedback.errors = structuredFeedback.errors.map((e, i) => ({
            ...e,
            suggestion:
              e.suggestion ??
              suggestRepairsForValidationErrors([validation.errors[i]])[0] ??
              `Adjust '${e.path}' to match the expected schema.`,
          }));
          tracer.recordToolExecution(
            runId,
            toolCall.name,
            toolCall.arguments,
            errorFeedback,
            0,
            errorFeedback,
          );
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: JSON.stringify(structuredFeedback),
            error: errorFeedback,
            durationMs: Date.now() - startTime,
          };
        }
        validatedArgs = validation.repairedArgs ?? repairedArgs;
      }

      // C2/Phase 3: Schedule tool call through ExecutionScheduler for idempotency + replay
      let schedulerActionId: string | null = null;
      if (this.runHandle) {
        try {
          const idempotencyKey = generateIdempotencyKey({
            externalSystem: tool.externalSystem ?? toolCall.name,
            toolName: toolCall.name,
            args: validatedArgs as Record<string, unknown>,
            intentHash: this.runHandle.intentHash,
            runId,
            stepId: toolCall.id ?? actionId,
          });
          const scheduleResult = getExecutionScheduler().scheduleAction({
            runId,
            leaseToken: this.runHandle.leaseToken,
            fencingEpoch: this.runHandle.fencingEpoch,
            toolName: toolCall.name,
            externalSystem: tool.externalSystem ?? toolCall.name,
            args: validatedArgs as Record<string, unknown>,
            idempotencyKey,
            compensable: isMutation,
            tags: ['tool_execution', toolCall.name],
            description: `${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`,
            tenantId,
          });
          if (scheduleResult) {
            schedulerActionId = scheduleResult.actionId;
            if (scheduleResult.replayed) {
              const durationMs = Date.now() - startTime;
              const cachedOutput = scheduleResult.cachedResult;
              if (cachedOutput !== undefined) {
                tracer.recordToolExecution(
                  runId,
                  toolCall.name,
                  toolCall.arguments,
                  cachedOutput,
                  durationMs,
                );
                getMetricsCollector().recordToolCall(
                  toolCall.name,
                  durationMs,
                  undefined,
                  tenantId,
                );
                bus.publish('tool.completed', agentId, {
                  runId,
                  toolName: toolCall.name,
                  durationMs,
                });
                return {
                  toolCallId: toolCall.id,
                  name: toolCall.name,
                  output: cachedOutput,
                  durationMs,
                };
              }
              const cachedError = scheduleResult.cachedError;
              if (cachedError) {
                tracer.recordToolExecution(
                  runId,
                  toolCall.name,
                  toolCall.arguments,
                  '',
                  durationMs,
                  cachedError,
                );
                getMetricsCollector().recordToolCall(
                  toolCall.name,
                  durationMs,
                  cachedError,
                  tenantId,
                );
                return {
                  toolCallId: toolCall.id,
                  name: toolCall.name,
                  output: '',
                  error: cachedError,
                  durationMs,
                };
              }
            }
          }
        } catch (e) {
          getGlobalLogger().debug(
            'AgentRuntime',
            'Scheduler scheduleAction failed; running without ATR ledger',
            { runId, toolName: toolCall.name, error: (e as Error).message },
          );
        }
      }

      // ExecPolicy gate: evaluate shell/Python commands before execution
      // Research backing: Codex CLI command safety classification, Claude Code deny-first evaluation
      if (toolCall.name === 'shell_execute' || toolCall.name === 'python_execute') {
        const command = String(validatedArgs.command ?? validatedArgs.code ?? '');
        if (command) {
          try {
            const { ExecPolicyEngine } = await import('../sandbox/execPolicy');
            const policy = new ExecPolicyEngine();
            const decision = policy.evaluate(command);
            if (decision.decision === 'forbidden') {
              const errorMsg = `EXEC_POLICY_FORBIDDEN: Command blocked by security policy. Rule: ${decision.rule?.id ?? 'unknown'}. Justification: ${decision.rule?.justification ?? 'dangerous command'}`;
              bus.publish('tool.blocked', agentId, {
                runId,
                toolName: toolCall.name,
                reason: 'exec_policy_forbidden',
                detail: errorMsg,
              });
              return {
                toolCallId: toolCall.id,
                name: toolCall.name,
                output: errorMsg,
                error: errorMsg,
                durationMs: 0,
              };
            }
            if (decision.decision === 'prompt') {
              // Log the policy decision but allow execution (approval system handles prompting)
              getGlobalLogger().debug(
                'AgentRuntime',
                `ExecPolicy: "${command.slice(0, 80)}..." requires approval (rule: ${decision.rule?.id})`,
              );
            }
          } catch (e) {
            // Policy engine load failure — proceed without gating (fail-open for availability)
            getGlobalLogger().warn(
              'AgentRuntime',
              'ExecPolicy load failed, proceeding without gate',
              { error: (e as Error)?.message },
            );
          }
        }
      }

      bus.publish('tool.started', agentId, {
        runId,
        toolName: toolCall.name,
        args: toolCall.arguments,
      });

      const boundary = new StepErrorBoundary(
        runId,
        agentId,
        this.dlq,
        undefined,
        {
          maxRetries: 1,
          retryDelayMs: this.config.retryDelayMs,
          onExhausted: 'skip',
          onPermanent: 'abort',
        },
        this.reflexionGenerator,
      );

      // Guardian security check
      try {
        const intervention = getGuardianAgent().monitor({
          agentId,
          runId,
          timestamp: Date.now(),
          type: 'tool_call',
          content: `${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`,
          metadata: { args: toolCall.arguments },
        });
        if (intervention) {
          const errorMsg = `GUARDIAN_BLOCKED: ${intervention} by security guardian for ${toolCall.name}`;
          const durationMs = Date.now() - startTime;
          bus.publish('tool.blocked', agentId, {
            runId,
            toolName: toolCall.name,
            reason: 'guardian_blocked',
            detail: errorMsg,
          });
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: errorMsg,
            error: errorMsg,
            durationMs,
          };
        }
      } catch { /* best-effort */ }

      let latestReflexion: Reflexion | null = null;
      let lastReflexionAttempt = 0;

      const boundaryResult = await boundary.execute<string>(
        toolCall.name,
        'tool',
        async () => {
          return this.stepTimeout.wrap(tool.execute(validatedArgs, agentCtx), {
            timeoutMs: effectiveTimeout,
            stepId: toolCall.id || toolCall.name,
          });
        },
        {
          tags: ['tool_execution', toolCall.name],
          inputSnapshot: JSON.stringify(toolCall.arguments).slice(0, 1000),
          onReflexion: (reflexion: Reflexion, ctx: ReflexionContext) => {
            latestReflexion = reflexion;
            lastReflexionAttempt = ctx.attemptNumber;
          },
        },
      );

      if (boundaryResult.recovered) {
        bus.publish('tool.retry', agentId, {
          runId,
          toolName: toolCall.name,
          attempts: boundaryResult.attempts,
        });
      }

      if (!boundaryResult.success) {
        const durationMs = Date.now() - startTime;
        const errorMsg = boundaryResult.error ?? 'Unknown tool error';

        tracer.recordToolExecution(
          runId,
          toolCall.name,
          toolCall.arguments,
          '',
          durationMs,
          errorMsg,
        );
        getMetricsCollector().recordToolCall(toolCall.name, durationMs, errorMsg, tenantId);
        getMetricsCollector().recordError(boundaryResult.errorClass, tenantId);

        // Detect timeout from both legacy format and StepTimeoutManager
        if (errorMsg.includes('TOOL_TIMEOUT') || errorMsg.includes('exceeded timeout')) {
          bus.publish('tool.timeout', agentId, {
            runId,
            toolName: toolCall.name,
            timeoutMs: effectiveTimeout,
            durationMs,
          });
        }

        // Fire handleMutationToolFailure for mutation tools (generates rollback plan, publishes event, auto-executes safe plans)
        if (isMutationTool(toolCall.name)) {
          try {
            await this.handleMutationToolFailure(
              toolCall.name,
              toolCall.arguments as Record<string, unknown>,
              errorMsg,
            );
          } catch (innerErr) {
            getGlobalLogger().debug(
              'AgentRuntime',
              'handleMutationToolFailure threw (best-effort)',
              { actionId, error: (innerErr as Error).message },
            );
          }
        }

        // Compensate side-effects from prior mutation tools in this run
        let compensateResult = await this.compensationRegistry.compensate(actionId);
        if (!compensateResult.success) {
          compensateResult = await this.compensationRegistry.compensate(actionId);
        }
        if (!compensateResult.success) {
          getGlobalLogger().debug('AgentRuntime', 'Compensation failed after retry', {
            actionId,
            error: compensateResult.error,
          });
        }

        if (schedulerActionId && this.runHandle) {
          try {
            getExecutionScheduler().recordError({
              runId,
              leaseToken: this.runHandle.leaseToken,
              fencingEpoch: this.runHandle.fencingEpoch,
              actionId: schedulerActionId,
              error: errorMsg,
              tenantId,
            });
          } catch (e) {
            getGlobalLogger().debug('AgentRuntime', 'Scheduler recordError failed', {
              runId,
              toolName: toolCall.name,
              error: (e as Error).message,
            });
          }
        }

        const structuredError = [
          `tool_error: "${toolCall.name}" failed after ${durationMs}ms`,
          `  reason: ${errorMsg}`,
          `  errorClass: ${boundaryResult.errorClass}`,
          `  args: ${JSON.stringify(toolCall.arguments)}`,
          ...(latestReflexion
            ? [
                ReflexionGenerator.formatForContext(
                  {
                    goal: '',
                    attemptedAction: toolCall.name,
                    actionResult: '',
                    error: errorMsg,
                    errorClass: boundaryResult.errorClass,
                    attemptNumber: lastReflexionAttempt,
                  },
                  latestReflexion,
                ),
              ]
            : []),
          `advice: `,
          `  - If this is a transient error, retry the call`,
          `  - If the arguments are invalid, correct them and retry`,
          `  - If the tool is unavailable, try a different approach`,
        ].join('\n');

        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: '',
          error: structuredError,
          durationMs,
        };
      }

      let output = boundaryResult.value as string;
      const durationMs = Date.now() - startTime;

      // Result budgeting: persist large outputs to disk, return reference
      // Token-aware truncation: keep head (first ~60%) + tail (last ~40%) for maximum informational value.
      // The head preserves context/setup; the tail preserves results/errors.
      const maxSize = tool.maxOutputSize ?? this.config.observationMaskWindow * 1000;
      if (typeof output === 'string' && output.length > maxSize && maxSize > 0) {
        const hash = crypto.createHash('md5').update(output).digest('hex').slice(0, 8);
        const resultDir = path.join(process.cwd(), '.commander_results');
        try {
          await fs.promises.mkdir(resultDir, { recursive: true });
          const resultFile = path.join(resultDir, `${toolCall.name}-${hash}.txt`);
          await fs.promises.writeFile(resultFile, output, 'utf-8');
          const headSize = Math.floor(maxSize * 0.6);
          const tailSize = maxSize - headSize;
          const head = output.slice(0, headSize);
          const tail = output.length > headSize ? output.slice(-tailSize) : '';
          output = `[Large output: ${output.length} chars. Saved to ${resultFile}.]\n${head}\n... [truncated, omitted ${output.length - maxSize} chars] ...\n${tail}\n[End. Full output at ${resultFile}]`;
        } catch (e) {
          getGlobalLogger().warn('AgentRuntime', 'Failed to persist large output', {
            error: (e as Error)?.message,
          });
          // Fall through with truncated output
          const headSize = Math.floor(maxSize * 0.6);
          const head = output.slice(0, headSize);
          const tail = output.length > headSize ? output.slice(-(maxSize - headSize)) : '';
          output = `${head}\n... [truncated, omitted ${output.length - maxSize} chars] ...\n${tail}`;
        }
      }

      tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, output, durationMs);
      getMetricsCollector().recordToolCall(toolCall.name, durationMs, undefined, tenantId);
      bus.publish('tool.executed', agentId, { toolName: toolCall.name, durationMs });
      bus.publish('tool.completed', agentId, { runId, toolName: toolCall.name, durationMs });

      if (schedulerActionId && this.runHandle) {
        try {
          getExecutionScheduler().recordResult({
            runId,
            leaseToken: this.runHandle.leaseToken,
            fencingEpoch: this.runHandle.fencingEpoch,
            actionId: schedulerActionId,
            result: output,
            tenantId,
          });
        } catch (e) {
          getGlobalLogger().debug('AgentRuntime', 'Scheduler recordResult failed', {
            runId,
            toolName: toolCall.name,
            error: (e as Error).message,
          });
        }
      }

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: typeof output === 'string' ? output : JSON.stringify(output),
        durationMs,
      };
    } finally {
      const durationMs = Date.now() - startTime;
      try {
        getMetricsCollector().recordStepLatency('tool_execution', durationMs, tenantId);
      } catch {
        /* best-effort */
      }
    }
  }

  /** Register default compensation handlers for mutation tools */
  private registerDefaultCompensation(): void {
    const reg = this.compensationRegistry;
    const restoreFromSnapshot = async (action: {
      actionId: string;
      args: Record<string, unknown>;
    }) => {
      const filePath = action.args.filePath ?? action.args.path;
      if (typeof filePath !== 'string') return { success: true };
      const snapshotPath = `${filePath}.atr-snapshot.${action.actionId}`;
      try {
        const fs = await import('fs');
        if (!fs.existsSync(snapshotPath)) {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          return { success: true };
        }
        const original = fs.readFileSync(snapshotPath, 'utf-8');
        fs.writeFileSync(filePath, original, 'utf-8');
        fs.unlinkSync(snapshotPath);
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    };
    reg.register('file_write', restoreFromSnapshot);
    reg.register('file_edit', restoreFromSnapshot);
    reg.register('apply_patch', restoreFromSnapshot);
    reg.register('code_fixer', restoreFromSnapshot);
    reg.register('code_refiner', restoreFromSnapshot);
    reg.register('file_delete', restoreFromSnapshot);
    reg.register('mkdir', async (action) => {
      const dir = action.args.path ?? action.args.dir;
      if (typeof dir !== 'string') return { success: true };
      try {
        const fs = await import('fs');
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir);
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });
    reg.register('memory_store', async (action) => {
      const key = action.args.key;
      if (typeof key !== 'string') return { success: true };
      try {
        const fs = await import('fs');
        const path = await import('path');
        const memoryPath = path.join(process.cwd(), '.commander', 'memory.json');
        if (!fs.existsSync(memoryPath)) return { success: true };
        const data = JSON.parse(fs.readFileSync(memoryPath, 'utf-8')) as Array<{ key: string }>;
        const filtered = data.filter((e) => e.key !== key);
        fs.writeFileSync(memoryPath, JSON.stringify(filtered, null, 2), 'utf-8');
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });
  }

  private generateActionId(): string {
    return `act_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  // ---------------------------------------------------------------------------
  // Concurrency semaphore (GAP-07)
  // ---------------------------------------------------------------------------

  private async acquireSlot(): Promise<void> {
    if (this.runningCount < this.config.maxConcurrency) {
      this.runningCount++;
      return;
    }
    // Wait for a slot to free up
    return new Promise<void>((resolve) => {
      this.waitingQueue.push(() => {
        this.runningCount++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.runningCount--;
    const next = this.waitingQueue.shift();
    if (next) next();
  }

  // ---------------------------------------------------------------------------
  // Auto-resume (GAP-03)
  // ---------------------------------------------------------------------------

  /**
   * List runs that crashed (have checkpoints but no terminal state).
   * Callers can use this to present a resume UI or auto-resume.
   */
  listUnfinishedRuns(): Array<{ runId: string; phase: string; timestamp: string }> {
    return this.checkpointer
      .listCheckpoints()
      .filter((cp) => cp.phase !== 'completed' && cp.phase !== 'failed');
  }

  /** Tier 1.2: Resume a crashed run using the full RunRecovery pipeline.
   *  Validates the lease, reconstructs completedToolCallIds from checkpoint
   *  messages, and returns a result suitable for continuing from the last step.
   *  Returns null if the checkpoint is not found or the lease was lost.
   */
  async resume(runId: string, tenantId?: string): Promise<RunRecoveryResult | null> {
    const recovery = new RunRecovery(this.checkpointer, this.leaseManager);
    const result = await recovery.attempt(runId, { tenantId });
    if (result.status === 'not_found' || result.status === 'lease_lost') {
      getGlobalLogger().warn('AgentRuntime', 'Run recovery failed', {
        runId,
        status: result.status,
      });
      return null;
    }
    getGlobalLogger().info('AgentRuntime', 'Run recovered', {
      runId,
      resumeFromStep: result.resumeFromStep,
      completedToolCalls: result.completedToolCallIds.size,
    });
    return result;
  }

  /** List all runs that have recoverable checkpoints (non-terminal phases). */
  listResumableRuns(): Array<{ runId: string; phase: string; timestamp: string }> {
    return this.checkpointer.listCheckpoints().map((entry) => ({
      runId: entry.runId,
      phase: entry.phase,
      timestamp: entry.timestamp,
    }));
  }

  /**
   * Signal a running execution to pause at the next checkpoint boundary.
   * Returns true if the run was active and pause was signaled, false otherwise.
   */
  pauseRun(runId: string): boolean {
    if (!this.activeRuns.has(runId)) {
      return false;
    }
    this.pausedRuns.add(runId);
    return true;
  }

  /**
   * Clear the pause flag for a run (e.g., after resume).
   */
  unpauseRun(runId: string): void {
    this.pausedRuns.delete(runId);
  }

  isPaused(runId: string): boolean {
    return this.pausedRuns.has(runId);
  }

  /**
   * List all active runs with their pause state.
   * Returns an array of { runId, paused, checkpointPhase }.
   */
  getActiveRuns(): Array<{ runId: string; paused: boolean; checkpointPhase?: string }> {
    return Array.from(this.activeRuns).map((runId) => {
      const checkpoint = this.checkpointer.resume(runId);
      return {
        runId,
        paused: this.pausedRuns.has(runId),
        checkpointPhase: checkpoint?.phase,
      };
    });
  }

  getActiveRunCount(): number {
    return this.activeRuns.size;
  }

  isRunActive(runId: string): boolean {
    return this.activeRuns.has(runId);
  }

  getSemanticCacheStats() {
    return this.semanticCache.getStats();
  }

  getSingleFlightStats(): SingleFlightStats {
    return this.singleFlight.getStats();
  }

  getGeminiCacheStats(): GeminiCacheStats {
    return this.geminiCache.getStats();
  }

  getCostEstimatorHistory() {
    return getCostEstimator().exportHistory();
  }

  /** Tier 4.3: Return a per-provider health snapshot for the dashboard. */
  getProviderHealth(): Array<{
    provider: string;
    state: string;
    errorRate: number;
    requestCount: number;
    lastFailureAt: number;
  }> {
    const breakerStats = this.circuitBreaker.getStats();
    const health: Array<{
      provider: string;
      state: string;
      errorRate: number;
      requestCount: number;
      lastFailureAt: number;
    }> = [];
    for (const [name] of this.providers) {
      const success = getMetricsCollector().getCounter('llm_success_total', [
        { name: 'provider', value: name },
      ]);
      const errors = getMetricsCollector().getCounter('llm_errors_total', [
        { name: 'provider', value: name },
      ]);
      const total = success + errors;
      health.push({
        provider: name,
        state: breakerStats.state,
        errorRate: total > 0 ? errors / total : 0,
        requestCount: total,
        lastFailureAt: breakerStats.lastFailureTime,
      });
    }
    return health;
  }

  /** Dispose sub-resources (timers, file handles) when this runtime is discarded */
  dispose(): void {
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
    this.toolCache.dispose();
    try {
      getModelPerformanceStore().dispose();
    } catch {
      /* best-effort */
    }
    this.agentInbox.dispose();
    // Shutdown trace store to flush pending buffers
    if (typeof this.traceStore.shutdown === 'function') this.traceStore.shutdown();
    // Stop OpenTelemetry exporter if running
    if (this.otelExporter) {
      this.otelExporter.stop().catch((err) => {
        getGlobalLogger().debug('AgentRuntime', 'OTel exporter stop failed (non-critical)', {
          error: (err as Error)?.message,
        });
      });
    }
    // Dispose tenant-scoped stores
    for (const store of this.tenantSamplesStores.values()) {
      try {
        store.flush();
      } catch (e) {
        getGlobalLogger().warn(
          'AgentRuntime',
          'Failed to flush tenant samples store during dispose',
          { error: (e as Error)?.message },
        );
      }
    }
    for (const store of this.tenantTraceStores.values()) {
      try {
        store.shutdown();
      } catch (e) {
        getGlobalLogger().warn(
          'AgentRuntime',
          'Failed to shutdown tenant trace store during dispose',
          { error: (e as Error)?.message },
        );
      }
    }
    this.tenantSamplesStores.clear();
    this.tenantTraceStores.clear();
    this.tenantCheckpointers.clear();
  }
}

function resolveSemanticCache(config: AgentRuntimeConfig): SemanticCache {
  const cfg = config.semanticCache;
  if (!cfg?.enabled) {
    return new SemanticCache(new MockEmbeddingFunction(), { enabled: false, pruneIntervalMs: 0 });
  }
  const apiKey = cfg.openaiApiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Fall back to local embeddings (no API key needed)
    getGlobalLogger().debug(
      'AgentRuntime',
      `Semantic cache enabled with local embeddings (threshold=${cfg.similarityThreshold ?? 0.92}). Set OPENAI_API_KEY for higher-quality OpenAI embeddings.`,
    );
    return new SemanticCache(new LocalEmbeddingFunction(), {
      enabled: true,
      similarityThreshold: cfg.similarityThreshold ?? 0.92,
      maxEntries: cfg.maxEntries ?? 10_000,
      defaultTtlMs: cfg.defaultTtlMs ?? 86_400_000,
      maxBucketSize: cfg.maxBucketSize ?? 64,
      cacheStochastic: cfg.cacheStochastic ?? false,
      cacheToolCalls: cfg.cacheToolCalls ?? false,
      pruneIntervalMs: cfg.pruneIntervalMs ?? 60_000,
    });
  }
  getGlobalLogger().debug(
    'AgentRuntime',
    `Semantic cache enabled with OpenAI embeddings (model=${cfg.embeddingModel ?? 'text-embedding-3-small'}, threshold=${cfg.similarityThreshold ?? 0.92})`,
  );
  return new SemanticCache(
    new OpenAIEmbeddingFunction({
      apiKey,
      model: cfg.embeddingModel,
      baseUrl: cfg.embeddingBaseUrl,
    }),
    {
      enabled: true,
      similarityThreshold: cfg.similarityThreshold ?? 0.92,
      maxEntries: cfg.maxEntries ?? 10_000,
      defaultTtlMs: cfg.defaultTtlMs ?? 86_400_000,
      maxBucketSize: cfg.maxBucketSize ?? 64,
      cacheStochastic: cfg.cacheStochastic ?? false,
      cacheToolCalls: cfg.cacheToolCalls ?? false,
      pruneIntervalMs: cfg.pruneIntervalMs ?? 60_000,
    },
  );
}

function derivePromptCacheKey(ctx: AgentExecutionContext, tenantId: string | undefined): string {
  const goal = ctx.goal ?? '';
  let hash = 0;
  for (let i = 0; i < goal.length; i++) {
    hash = ((hash << 5) - hash + goal.charCodeAt(i)) | 0;
  }
  const goalTag = Math.abs(hash).toString(36).slice(0, 12);
  const tenantTag = tenantId ?? 'default';
  const agentTag = ctx.agentId ?? 'shared';
  return `${tenantTag}:${agentTag}:${goalTag}`.slice(0, 64);
}
