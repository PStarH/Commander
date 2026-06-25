/**
 * Agent Runtime — Core execution engine for the Commander agent loop.
 *
 * WARNING: This file is a God object (~3,000-line execute(), 4,571 LOC total).
 * It cannot be tested, reasoned about, or modified safely. Every change risks
 * breaking one of the many intertwined execution paths.
 *
 * Known issues:
 * - Mutable instance fields (slidingWindow, governor, tools) are reassigned
 *   per-run, creating data races under concurrent execute() calls.
 * - 76 getGlobal*() singleton calls make isolation impossible.
 * - 110 catch blocks, 61 marked "best-effort", swallow errors silently.
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
import { reportSilentFailure } from '../silentFailureReporter';
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
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  GOAL_TELEMETRY_MAX_CHARS,
  GOAL_RESULT_MAX_CHARS,
  GOAL_FULL_MAX_CHARS,
  OUTPUT_PREFIX_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  ERROR_MAX_CHARS,
  TOOL_PATTERN_MAX_CHARS,
  RESULT_CONTENT_MAX_CHARS,
  RETRY_LOOP_THRESHOLD,
  RETRY_LOOP_PATTERN_HISTORY,
  DEFAULT_LLM_TIMEOUT_MS,
} from './runtimeConstants';
import type { AgentRuntimeInterface } from './agentRuntimeInterface';
import { ModelRouter, getModelRouter } from './modelRouter';
import { SmartModelRouter, type ModelRouterUserConfig } from './smartModelRouter';
import { getMessageBus } from './messageBus';
import { getTraceRecorder } from './executionTrace';
import { getAnomalyDetector } from '../observability/anomalyDetector';
import { PersistentTraceStore } from './traceStore';
import {
  compactToolDef,
  compactToolDefs,
  getCompactConfigForTier,
} from './programmaticToolFormatter';
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
import { TokenGovernor } from './tokenGovernor';
import { SamplesStore } from './samplesStore';
import { captureProvenance } from './provenance';
import { getIntentLog } from './intentLog';
import { getVerificationReportStore } from './verificationReportStore';
import { StateCheckpointer } from './stateCheckpointer';
import { installProcessCrashHandlers } from './processCrashSafety';
import { RunRecovery, type RunRecoveryResult } from './runRecovery';
import { StepTimeoutManager } from './stepTimeoutManager';
import {
  ProviderFallbackChain,
  FallbackChainExhaustedError,
  type ProviderEntry,
} from './providerFallbackChain';
import { ReflexionInjector, type ReflectionEntry } from '../memory/reflexionInjector';
import { DeadLetterQueue } from './deadLetterQueue';
import { getMetricsCollector } from './metricsCollector';
import { CompensationRegistry } from './compensationRegistry';
import { ReliabilityEngine } from './reliabilityEngine';
import { AgentInbox } from './agentInbox';
import { TeamRegistry } from './teamRegistry';
import { AgentHandoff } from './agentHandoff';
import { getGlobalThreeLayerMemory } from '../threeLayerMemory';
import { getAgentIntelligence } from '../intelligence/agentIntegration';
import { getMetaLearner } from '../selfEvolution/metaLearner';
import { getFailurePatternLearner } from '../intelligence/failurePatterns';
import { runWithTenant } from './tenantContext';
import { getHookManager } from '../pluginManager';
import { ToolOutputManager } from './toolOutputManager';
import { ToolOrchestrator } from './toolOrchestrator';
import { SyntheticErrorRow, toolErrorRow, type PreToolCallGateResult } from './toolResultShape';
import { ToolApproval } from './toolApproval';
import {
  buildTwoTierTools,
  buildRegistrySummary,
  calculateTierMetrics,
  detectContextPromotions,
} from './toolRetriever';
import { createRequestToolTool } from '../tools/requestToolTool';
import { ToolPlanner } from './toolPlanner';
import { CycleDetector } from './cycleDetector';
import { parseStructuredOutput } from './structuredOutput';
import { getExecutionScheduler, type RunHandle } from '../atr/scheduler';
import { LeaseManager } from '../atr/leaseManager';
import { isConfidentResponse } from './entropyGater';
import { InterruptError } from './interruptError';
import { createContentScanner, type ContentScanner } from '../contentScanner';
import { scanToolOutputForInjection } from '../contentScanner';
import { sanitizeIfNeeded } from '../security/outputSanitizer';
import { getCostGuard } from '../security/costGuard';
import { getSLOManager } from '../observability/sloManager';
import { getPrivacyRouter } from './privacyRouter';
import type { TenantProvider, TenantConfig } from './tenantProvider';
import type { PlannedToolCall } from '../compensation/rollbackPlanner';
import { getGlobalTenantProvider } from './tenantProvider';
import { getLaneManager } from '../sandbox/lane';
import { createMemoryStore } from '../memory';
import type { MemoryStore } from '../memory';
import { getConversationStore } from '../memory/conversationStore';
import { CacheManager } from './cacheManager';
import { ConcurrencyController } from './concurrencyController';
import { RunLifecycleManager } from './runLifecycleManager';
import { TenantManager } from './tenantManager';
import { CompensationService } from './compensationService';
import type { CompensationPlan } from '../compensation/types';
import { SingleFlightRequestCache, type SingleFlightStats } from './singleFlightRequestCache';
import type { GeminiCacheStats } from './geminiCacheManager';
import { ToolExecutionService } from './toolExecutionService';
import {
  OpenTelemetryExporter,
  getOTelExporter,
  executionTraceToOtlpSpans,
} from './openTelemetryExporter';
import { exportSOPFromTrace, formatSOPAsMarkdown } from './sopExport';
import {
  buildSystemPrompt,
  buildCacheAwareUserPrompt,
  computePrefixCacheKey,
} from './promptBuilder';
import { loadProjectContext } from './projectContextLoader';
import { ReflexionGenerator, type ReflexionContext } from './reflexionGenerator';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalLogger } from '../logging';
import { getDataRetentionJanitor } from '../storage/dataRetention';
import type { CompactTaskType } from './contextCompactor';
import { getCostEstimator, type CostEstimate } from './costEstimator';
import { getModelPerformanceStore } from './modelPerformanceStore';
import { getSecurityMonitor } from '../security/securityMonitor';
import {
  SecurityOrchestrator,
  getSecurityOrchestrator,
  type SecurityOrchestratorDecision,
} from './securityOrchestrator';
import type { CrossAgentEvent } from '../security/crossAgentCorrelator';
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

/** Recursively sort object keys for stable JSON comparison of tool arguments. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

export class AgentRuntime implements AgentRuntimeInterface {
  private config: AgentRuntimeConfig;
  private providers: Map<string, LLMProvider> = new Map();
  private tools: Map<string, Tool> = new Map();
  private router: ModelRouter;
  private smartRouter: SmartModelRouter | null = null;
  /** When false, the smart router is bypassed and the legacy routeWithCascade path runs even if a smartRouter instance exists. Default ON. */
  private smartRouterActive: boolean = true;
  private compactor: ContextCompactor;
  private slidingWindow: SlidingWindowOrchestrator;
  private reliabilityEngine!: ReliabilityEngine;
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
  private agentInbox: AgentInbox;
  private teamRegistry: TeamRegistry;
  private agentHandoff: AgentHandoff;
  private outputManager: ToolOutputManager;
  private memoryStore: MemoryStore | null = null;
  private otelExporter: OpenTelemetryExporter | null = null;
  private orchestrator: ToolOrchestrator;
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
  private contentScanner: ContentScanner;
  // SecurityOrchestrator: unified runtime defense facade
  private securityOrch: SecurityOrchestrator;
  // Conversation store (FTS5-powered session persistence)
  private conversationStore: import('../memory/conversationStore').ConversationStore | null = null;

  // Extracted services (shrink the god object)
  private cacheManager: CacheManager;
  private concurrencyController: ConcurrencyController;
  private runLifecycle: RunLifecycleManager;
  private tenantManager: TenantManager;
  private compensationService: CompensationService;
  private toolExecutionService: ToolExecutionService;

  // Tenant config provider (kept for direct lookups in execute())
  private tenantProvider: TenantProvider;

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
    this.reliabilityEngine = new ReliabilityEngine({
      circuitThreshold: 5,
      circuitRecoveryMs: 30_000,
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
          reportSilentFailure(err, 'agentRuntime:334');
          /* best-effort */
        }
      },
    });
    this.circuitBreaker = this.reliabilityEngine.getCircuitBreaker();
    this.dlq = this.reliabilityEngine.getDeadLetterQueue();
    this.checkpointer = this.reliabilityEngine.getStateCheckpointer();
    this.circuitBreaker.setObservability({
      onTransition: (from, to, provider) => {
        try {
          getMetricsCollector().recordCircuitTransition(from, to, provider ?? 'agentRuntime');
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:347');
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
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:360');
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
          reportSilentFailure(err, 'agentRuntime:374');
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
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:400');
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
        reportSilentFailure(err, 'agentRuntime:414');
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
    this.leaseManager = new LeaseManager();
    this.stepTimeout = new StepTimeoutManager();
    this.fallbackChain = new ProviderFallbackChain<import('./types').LLMResponse>();
    this.compensationService = new CompensationService({
      dlq: this.dlq,
      getRunId: () => this.ledgerCtx?.runId ?? 'unknown',
      traceStore: this.traceStore,
    });
    this.agentInbox = new AgentInbox();
    this.teamRegistry = new TeamRegistry();
    this.agentHandoff = new AgentHandoff(this.agentInbox, this.checkpointer);
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
    // Extracted services (shrink the god object)
    this.cacheManager = new CacheManager({
      semanticCache: this.config.semanticCache,
      singleFlight: this.config.singleFlight,
      geminiCache: this.config.geminiCache,
    });
    this.concurrencyController = new ConcurrencyController(this.config.maxConcurrency);
    this.runLifecycle = new RunLifecycleManager();
    this.tenantManager = new TenantManager();
    this.toolExecutionService = new ToolExecutionService({
      tools: this.tools,
      compensationService: this.compensationService,
      cacheManager: this.cacheManager,
      dlq: this.dlq,
      getRunHandle: () => this.runHandle,
      config: this.config,
      reflexionGenerator: this.reflexionGenerator,
      stepTimeout: this.stepTimeout,
      getPromotedTools: () => this.promotedTools,
      generateActionId: () => this.generateActionId(),
      getBreakerRegistry: () => this.getBreakerRegistry(),
    });

    // Tool calling infrastructure
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
    this.cycleDetector = new CycleDetector({
      enabled: this.config.cycleDetection?.enabled !== false,
    });
    this.contentScanner = createContentScanner();
    this.securityOrch = getSecurityOrchestrator();
    // Benchmarks may intentionally generate high tool-call volumes; let callers
    // disable GuardianAgent monitoring through the runtime config.
    if (this.config.securityMonitor?.enabled === false) {
      this.securityOrch.updateConfig({ enableGuardianAgent: false });
    }

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
              .catch((e) => {
                getGlobalLogger().debug('AgentRuntime', 'Failed to record conversation turn', {
                  error: (e as Error)?.message,
                });
              });
          })
          .catch((e) => {
            getGlobalLogger().warn('AgentRuntime', 'Failed to create conversation session', {
              error: (e as Error)?.message,
            });
          });
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
              content: (summary || '').slice(0, SUMMARY_MAX_CHARS),
            })
            .catch((e) => {
              getGlobalLogger().debug('AgentRuntime', 'Failed to record completion turn', {
                error: (e as Error)?.message,
              });
            });
          store.endSession(sessionId).catch((e) => {
            getGlobalLogger().debug('AgentRuntime', 'Failed to end conversation session', {
              error: (e as Error)?.message,
            });
          });
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
              content: `[Failed] ${(error || '').slice(0, ERROR_MAX_CHARS)}`,
            })
            .catch((e) => {
              getGlobalLogger().debug('AgentRuntime', 'Failed to record failure turn', {
                error: (e as Error)?.message,
              });
            });
          store.endSession(sessionId).catch((e) => {
            getGlobalLogger().debug('AgentRuntime', 'Failed to end session after failure', {
              error: (e as Error)?.message,
            });
          });
        }
      });

      // Lazy init — the store initializes on first access
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

    // Tier 1.2: Bind lease manager to checkpointer for run recovery validation
    this.checkpointer.setLeaseManager(this.leaseManager);

    // Tier 1.1: Install process crash handlers (uncaughtException, unhandledRejection, SIGTERM, SIGINT)
    installProcessCrashHandlers({
      dlq: this.dlq,
      leaseManager: this.leaseManager,
      activeRunIds: () => this.runLifecycle.getActiveRuns(),
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
    }); // SOC 2 C1.2 / GDPR Art 17 disposal — schedule the retention
    // janitor from the runtime constructor so CLI-only paths
    // (which don't go through httpServer.start()) still get the
    // housekeeping tick. The module-level `scheduledRootDirs`
    // dedup set in storage/dataRetention.ts ensures only one
    // setInterval runs across the process regardless of how many
    // AgentRuntime instances exist or in what order surfaces boot.
    try {
      const janitor = getDataRetentionJanitor();
      // `claimed` lets the log disambiguate: true means THIS
      // AgentRuntime instance owns the recurring tick; false means
      // another surface (e.g. httpServer.start) claimed first and
      // the module-level `scheduledRootDirs` Set deduped us. See
      // DataRetentionJanitor.schedule() JSDoc for the full
      // claimed-vs-dedup-catch glossary.
      const claimed = janitor.schedule(60 * 60 * 1000, false);
      getGlobalLogger().info(
        'AgentRuntime',
        claimed
          ? `DataRetentionJanitor scheduled (1h interval) [rootDir=${janitor.rootDir}, claimed]`
          : `DataRetentionJanitor dedup-catch -- tick already owned (rootDir=${janitor.rootDir})`,
      );
    } catch (e) {
      getGlobalLogger().warn('AgentRuntime', 'Failed to schedule retention janitor', {
        error: (e as Error)?.message,
      });
    }

    // Start security monitoring (best-effort, can be disabled for benchmarks)
    if (this.config.securityMonitor?.enabled !== false) {
      try {
        getSecurityMonitor().start();
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:712');
        /* best-effort */
      }
    }
  }

  /**
   * Handle a mutation tool failure by generating a rollback plan and triggering compensation.
   * Publishes a 'tool.compensation_planned' bus event with plan metadata.
   * For safe plans, auto-executes compensation via SagaCoordinator.
   */
  async handleMutationToolFailure(
    toolName: string,
    args: Record<string, unknown>,
    error: string,
  ): Promise<void> {
    return this.compensationService.handleMutationToolFailure(
      toolName,
      args,
      error,
      this.executedMutations,
    );
  }

  /**
   * Execute a compensation plan by iterating through steps and calling
   * compensationRegistry.compensate() for each recorded action.
   */
  async compensateViaSaga(plan: CompensationPlan): Promise<void> {
    return this.compensationService.compensateViaSaga(plan);
  }

  /** Invalidate read caches after mutation tools succeed */
  private invalidateMutationCache(toolName: string): void {
    const toolCache = this.cacheManager.getToolCache();
    if (toolName.startsWith('file_')) {
      toolCache.invalidatePattern('file_read');
    } else if (toolName.startsWith('memory_')) {
      toolCache.invalidatePattern('memory_recall');
      toolCache.invalidatePattern('memory_list');
    } else if (toolName === 'git_push' || toolName === 'git_commit') {
      toolCache.invalidateTool('git');
    } else if (toolName === 'shell_execute' || toolName === 'python_execute') {
      // Shell commands may mutate filesystem; invalidate file_read broadly
      toolCache.invalidatePattern('file_read');
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
    // Stable key ordering: recursively sort object keys so nested arguments
    // (e.g. payload.round) are included deterministically.
    const canonicalArgs = canonicalJson(args);
    const pattern = `${toolName}:${canonicalArgs}`;
    patterns.push(pattern);
    if (patterns.length > RETRY_LOOP_PATTERN_HISTORY) patterns.shift();
    const count = patterns.filter((p) => p === pattern).length;
    if (count >= RETRY_LOOP_THRESHOLD) {
      const bus = getMessageBus();
      bus.publish('system.alert', 'runtime', {
        type: 'retry_loop_detected',
        toolName,
        pattern: `${toolName}:${canonicalArgs.slice(0, TOOL_PATTERN_MAX_CHARS)}`,
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
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:798');
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
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:812');
        /* best-effort */
      }
      return { detected: true, count };
    }
    return { detected: false, count: 0 };
  }

  /**
   * Apply SecurityOrchestrator pre-tool-call checks shared by both the
   * concurrent-safe and the serial execution paths in execute().
   *
   * Previously this 30-line block was duplicated in two places (concurrent
   * Promise.allSettled path and serial for-of path). Extracting into one
   * helper closes the divergence risk where one path could silently drift
   * from the other (e.g. one gets a new correlated event type, the other
   * doesn't), and centralizes the synthetic blocked-result shape so logged
   * errors, tool_call metadata, and tool_result shapes stay consistent
   * across both execution modes.
   *
   * Behavior — must match the original duplicated code byte-for-byte:
   *   1. Calls `onBeforeToolCall(name, args, agentId, runId)` and awaits it.
   *   2. Best-effort emits a `tool_call` CrossAgentEvent into the correlator
   *      (severity stays `low` if allowed, `high` if blocked).
   *   3. When denied, publishes a `tool.blocked` bus event with
   *      reason='security_orchestrator_denied' and blockReason in `detail`.
   *   4. When denied, returns BOTH synthetic result shapes the two callers
   *      need: a raw-result row for the concurrent Promise.allSettled
   *      array, and a ToolResult for the serial for-of path.
   */
  private async applyBeforeToolCallSecurity(
    tc: ToolCall,
    agentId: string,
    runId: string,
  ): Promise<{
    decision: SecurityOrchestratorDecision;
    allowed: boolean;
    /** Synthetic raw-result row for the concurrent parallel-results array. */
    blockedRawResult?: SyntheticErrorRow;
    /** Synthetic ToolResult for the serial execution path. */
    blockedToolResult?: ToolResult;
  }> {
    const decision = await this.securityOrch.onBeforeToolCall(
      tc.name,
      tc.arguments as Record<string, unknown>,
      agentId,
      runId,
    );

    // Feed tool_call event to correlator (DoS detection, lateral movement,
    // collusion). Wrapped in try/catch — Guardian/Correlator sink failures
    // must NEVER block the underlying security decision.
    try {
      this.securityOrch.onAgentEvent({
        id: generateId(),
        agentId,
        runId,
        type: 'tool_call',
        summary: `Tool ${tc.name} (${decision.allowed ? 'allowed' : 'blocked'})`,
        metadata: {
          toolName: tc.name,
          allowed: decision.allowed,
          hitlStrategy: decision.hitlStrategy,
          hitlSources: decision.sources,
        },
        timestamp: Date.now(),
        severity: decision.allowed ? 'low' : 'high',
      } as CrossAgentEvent);
    } catch (err) {
      reportSilentFailure(err, 'agentRuntime:881');
      /* best-effort */
    }

    if (decision.allowed) {
      return { decision, allowed: true };
    }

    // Blocked: publish a tool.blocked bus event FIRST (matching the original
    // duplicated code byte-for-byte — original left this unprotected so a
    // throwing subscriber propagates), then synthesize both result shapes
    // the two callers each need.
    const blockReason = decision.blockReason ?? 'AdaptiveHITL blocked';
    getMessageBus().publish('tool.blocked', agentId, {
      runId,
      toolName: tc.name,
      reason: 'security_orchestrator_denied',
      detail: blockReason,
    });
    const reasonStr = `Security blocked: ${blockReason}`;
    const blockedRawResult = toolErrorRow(tc, reasonStr);
    const blockedToolResult: ToolResult = toolErrorRow(tc, reasonStr);

    return {
      decision,
      allowed: false,
      blockedRawResult,
      blockedToolResult,
    };
  }

  /**
   * Apply the pre-tool-call safety gates that previously ran as ~70 lines
   * of duplicated logic in both the concurrent-safe `Promise.allSettled`
   * path and the serial `for-of` path of execute().
   *
   * Three sequential gates:
   *   1. HookManager.fireBeforeToolCall: plugin deny → action='continue'
   *      (skip just this tc). Original sequence preserves plugin-check before
   *      sibling-abort and before retry/cycle.
   *   2. sibling-abort (concurrent-only): if the sibling AbortSignal is
   *      already fired due to an earlier tool error, action='continue'.
   *      Only meaningful for concurrent paths; serial passes `undefined`.
   *   3. retry-loop detection: this.checkRetryLoop() finds a 3× same
   *      (tool,args) repetition → action='break' (exit all tc iterations).
   *   4. cycle detection: cycleDetector.check() finds a tool-call cycle →
   *      action='break'. Also publishes system.alert + tool.blocked bus
   *      events and increments retry-loop metrics on the way through.
   *
   * All side-effects (bus.publish, metrics, intent log, recentToolPatterns
   * mutation) match the original duplicated code byte-for-byte. Only the
   * orchestration differs: caller inspects `action` to decide whether to
   * `return`, `break`, or `continue` based on execution mode.
   */
  // Discriminated-union return type for applyPreToolCallGates. The helper is
  // a pure decision function: it inspects the four pre-tool-call gates and
  // returns the outcome PLUS minimum context for the caller to format
  // observable side effects (bus publishes, outer-loop flag mutations,
  // synthetic-error rows). All bus.publish calls live at the call site —
  // never inside the helper — so we can spy on the bus to prove that no
  // double-publish path exists.
  private async applyPreToolCallGates(
    tc: ToolCall,
    agentId: string,
    runId: string,
    tenantId: string | undefined,
    recentToolPatterns: string[],
    toolLoopCount: number,
    siblingAbortSignal?: AbortSignal,
  ): Promise<PreToolCallGateResult> {
    // Gate 1: HookManager plugin denial.
    const hookCtx = {
      toolName: tc.name,
      args: tc.arguments,
      agentId,
      runId,
    };
    const hookResult = await getHookManager().fireBeforeToolCall(hookCtx);
    if (hookResult !== null) {
      return { kind: 'hooked', errorMsg: hookResult.error ?? '' };
    }

    // Gate 2: sibling-abort cancellation (concurrent-only).
    // The serial path passes `undefined` for `siblingAbortSignal`, so this
    // branch only fires inside the Promise.allSettled closure.
    if (siblingAbortSignal?.aborted) {
      return {
        kind: 'siblingAbort',
        row: toolErrorRow(tc, 'Cancelled: sibling tool error'),
      };
    }

    // Gate 3: retry-loop detection.
    const rlCheck = this.checkRetryLoop(
      tc.name,
      tc.arguments as Record<string, unknown>,
      recentToolPatterns,
      runId,
      tenantId,
      toolLoopCount,
    );
    if (rlCheck.detected) {
      // The caller will set retryLoopDetected=true and assign retryLoopCount
      // from this count; we surface a count that matches the value the
      // previous helper wired in (which was `toolLoopCount`).
      return { kind: 'retry', count: toolLoopCount };
    }

    // Gate 4: cycle detection.
    const cycleCheck = this.cycleDetector.check(tc.name, tc.arguments, toolLoopCount);
    if (cycleCheck.detected) {
      return { kind: 'cycle', description: cycleCheck.description ?? '' };
    }

    return { kind: 'allowed' };
  }

  registerProvider(name: string, provider: LLMProvider): void {
    this.providers.set(name, provider);
  }

  registerTool(name: string, tool: Tool): void {
    // Normalize OpenAI-style `parameters` to ToolDefinition's `inputSchema` so
    // runtime validation and prompt rendering work for all registered tools.
    type LegacyToolDefinition = ToolDefinition & { parameters?: Record<string, unknown> };
    const def = tool.definition as LegacyToolDefinition;
    if (def.parameters && (!def.inputSchema || Object.keys(def.inputSchema).length === 0)) {
      def.inputSchema = def.parameters;
    }
    if (!tool.compiledSchema && def.inputSchema) {
      try {
        const { compileSchema } = require('./toolCallValidator');
        tool.compiledSchema = compileSchema(def.inputSchema);
      } catch {
        /* best-effort */
      }
    }
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

  /** Number of pending run acquisitions waiting on the concurrency semaphore. */
  getQueueDepth(): number {
    return this.concurrencyController.getQueueDepth();
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

  /** Expose the tool orchestrator's circuit breaker registry for runtime observation. */
  getBreakerRegistry(): import('./circuitBreakerRegistry').CircuitBreakerRegistry {
    return this.orchestrator.getBreakerRegistry();
  }

  /** Flush any buffered dead-letter-queue entries to disk for observation. */
  flushDeadLetterQueue(): void {
    try {
      this.dlq.flush();
    } catch (err) {
      reportSilentFailure(err, 'agentRuntime:1071');
      /* best-effort */
    }
  }

  getExecutionScheduler() {
    return getExecutionScheduler();
  }
  getCompensationRegistry(): CompensationRegistry {
    return this.compensationService.getRegistry();
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
    _runId: string,
    _agentId: string,
    _missionId?: string,
  ): TenantResolutionResult {
    const result = this.tenantManager.resolveTenantContext(tenantId, tenantCfg, {
      samplesStore: this.samplesStore,
      traceStore: this.traceStore,
      checkpointer: this.checkpointer,
      memory: this.memory,
      governor: this.governor,
    });

    if (result.allowed && tenantId && tenantCfg?.enabled) {
      const stores = this.tenantManager.getTenantStores(tenantId);
      this.samplesStore = stores.samplesStore;
      this.traceStore = stores.traceStore;
      this.checkpointer = stores.checkpointer;
      this.memory = stores.memory;
    }

    return result;
  }

  /**
   * Restore tenant overrides after run completes or fails.
   */
  private restoreTenantOverrides(
    overrides: TenantOverrides | undefined,
    _tenantId: string | undefined,
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
    await this.concurrencyController.acquireSlot();

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
      this.concurrencyController.releaseSlot();
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
    } catch (err) {
      reportSilentFailure(err, 'agentRuntime:1188');
      // Decrement tenant running count on lane acquisition failure
      this.tenantManager.releaseTenantConcurrency(tenantId);
      this.concurrencyController.releaseSlot();
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

    this.runLifecycle.addRun(runId);
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
    } catch (err) {
      reportSilentFailure(err, 'agentRuntime:1228');
      /* best-effort */
    }
    getMetricsCollector().setGauge(
      'active_runs',
      'Active concurrent runs',
      this.runLifecycle.getActiveRunCount(),
    );
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
          const cd = (ctx as unknown as { contextData?: Record<string, unknown> }).contextData;
          if (cd?.preferredModel && typeof cd.preferredModel === 'string') {
            (ctx as unknown as { preferredModel?: string }).preferredModel = cd.preferredModel;
          }
          if (cd?.preferredModelTier && typeof cd.preferredModelTier === 'string') {
            (ctx as unknown as { preferredModelTier?: ModelTier }).preferredModelTier =
              cd.preferredModelTier as ModelTier;
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
            modelId: this.router.route(
              ctx,
              undefined,
              ctx.preferredModelTier,
              new Set(this.providers.keys()),
            ).modelId,
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
                (this.smartRouter!.getModel(id) as ModelConfig | undefined) ?? {
                  id,
                  provider: 'unknown',
                  tier: 'standard' as ModelTier,
                  costPer1MInput: 0,
                  costPer1MOutput: 0,
                  capabilities: [],
                  contextWindow: DEFAULT_CONTEXT_WINDOW_TOKENS,
                  priority: 0,
                },
            );
          } else {
            const { initial: cascadeInitial, escalationChain } = this.router.routeWithCascade(
              ctx,
              this.governor.getState().phase,
              ctx.preferredModelTier,
              new Set(this.providers.keys()),
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
                  (estimatedInputTokens / 1_000_000) * batchModel.costPer1MInput +
                  (estimatedOutputTokens / 1_000_000) * batchModel.costPer1MOutput,
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
              } catch (err) {
                reportSilentFailure(err, 'agentRuntime:1439');
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
              } catch (err) {
                reportSilentFailure(err, 'agentRuntime:1458');
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
              } catch (err) {
                reportSilentFailure(err, 'agentRuntime:1495');
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
              } catch (err) {
                reportSilentFailure(err, 'agentRuntime:1535');
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
                ...(tenantId ? [{ name: 'tenant', value: tenantId }] : []),
              ],
            );
            getMetricsCollector().setGauge(
              'pre_run_token_estimate',
              'Pre-run token estimate',
              costEstimate.predictedTotalTokens,
              [
                { name: 'task_category', value: costEstimate.taskCategory },
                { name: 'model_tier', value: costEstimate.modelTier },
                ...(tenantId ? [{ name: 'tenant', value: tenantId }] : []),
              ],
            );
          } catch (err) {
            reportSilentFailure(err, 'agentRuntime:1581');
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
          } catch (err) {
            reportSilentFailure(err, 'agentRuntime:1695');
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
            const provisioned = await provisionTools(
              ctx.goal,
              request,
              this.tools,
              this.cacheManager.getToolCache(),
            );
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
                const rawMemories = this.memory.query({
                  keywords,
                  limit: 5,
                  importanceThreshold: 0.3,
                });
                // DP-sanitize memory entries before sharing across agents
                const dpOutcome = this.securityOrch.sanitizeMemoryShare(rawMemories, ctx.agentId);
                const memories = dpOutcome.result;
                if (memories && memories.length > 0) {
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
              } catch (err) {
                reportSilentFailure(err, 'agentRuntime:1889');
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
              } catch (err) {
                reportSilentFailure(err, 'agentRuntime:1919');
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
          const totalTokens: TokenUsage = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
          };
          // Track content written by file_write tool calls for artifact propagation
          let largestFileWriteContent = '';
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

          // CostGuard: economic attack detection (once per agent turn, not per retry)
          try {
            const estimatedTokens = this.governor.getState().usedTokens + 500;
            const costDecision = getCostGuard().evaluateRequest({
              tokens: estimatedTokens,
              model: routing.modelId,
              source: ctx.tenantId ?? ctx.agentId,
            });
            if (costDecision.action === 'MELT') {
              const msg = `COSTGUARD_MELT: ${costDecision.reason}`;
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
            if (costDecision.action === 'THROTTLE') {
              getGlobalLogger().warn('AgentRuntime', `CostGuard THROTTLE: ${costDecision.reason}`);
            }
          } catch (e) {
            // Fail-closed: CostGuard errors are treated as THROTTLE.
            // The guard may fail due to misconfiguration, memory pressure, or
            // state corruption — in all cases the safe default is to reduce
            // request priority rather than allow unrestricted spending.
            getGlobalLogger().warn(
              'AgentRuntime',
              `CostGuard check failed (fail-closed, throttling): ${(e as Error)?.message}`,
            );
          }

          for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            const llmCtx = { request, agentId: ctx.agentId, runId };
            const llmRequest = await getHookManager().fireBeforeLLMCall(llmCtx);
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
              totalTokens.cacheReadTokens =
                (totalTokens.cacheReadTokens ?? 0) + (response.usage.cacheReadTokens ?? 0);
              this.governor.reportUsage(response.usage.totalTokens);
              ctx.guard?.recordTokens(response.usage.totalTokens);

              const _traceEventId = tracer.recordLLMCall(
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

              // SecurityOrchestrator: feed LLM call into GuardianAgent + CrossAgentCorrelator
              try {
                const llmEvent: CrossAgentEvent = {
                  id: generateId(),
                  agentId: ctx.agentId,
                  runId,
                  type: 'llm_call',
                  summary: `LLM call to ${routing.modelId}: ${response.content?.slice(0, 80) ?? ''}`,
                  metadata: {
                    model: routing.modelId,
                    provider: routing.provider,
                    tier: routing.tier,
                    tokenUsage: response.usage,
                    stepDuration,
                    hasToolCalls: !!(response.toolCalls && response.toolCalls.length > 0),
                  },
                  timestamp: Date.now(),
                  severity: 'low' as const,
                };
                this.securityOrch.onAgentEvent(llmEvent);
              } catch (err) {
                reportSilentFailure(err, 'agentRuntime:2104');
                /* best-effort */
              }

              // Record actual cost for estimator learning (per-step)
              try {
                const modelCfg = this.router.getModel(routing.modelId);
                costEstimator.recordActualCost(
                  costEstimate.taskCategory,
                  routing.tier,
                  response.usage.promptTokens,
                  response.usage.completionTokens,
                  response.usage.cacheReadTokens ?? 0,
                  modelCfg?.costPer1MInput ?? 3,
                  modelCfg?.costPer1MOutput ?? 10,
                  modelCfg?.costPer1MCachedInput,
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
                } catch (err) {
                  reportSilentFailure(err, 'agentRuntime:2141');
                  /* best-effort */
                }
              } catch (err) {
                reportSilentFailure(err, 'agentRuntime:2145');
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
              void 0;
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
                console.warn(
                  `[TOOL LOOP] iteration ${toolLoopCount + 1} calls=${response.toolCalls?.length} phase=${this.governor.getState().phase}`,
                );
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
                  const cached = this.cacheManager.getToolCache().get(tc, tenantId);
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
                        // Pre-tool-call safety gates (hook, sibling-abort, retry, cycle)
                        const gate = await this.applyPreToolCallGates(
                          tc,
                          ctx.agentId,
                          runId,
                          ctx.tenantId,
                          recentToolPatterns,
                          toolLoopCount,
                          siblingAbort.signal,
                        );
                        if (gate.kind !== 'allowed') {
                          console.warn(`[SERIAL] GATE BLOCKED ${tc.name} kind=${gate.kind}`);
                          if (gate.kind === 'retry') {
                            retryLoopDetected = true;
                            return toolErrorRow(tc, `Retry loop detected: ${tc.name}`);
                          }
                          if (gate.kind === 'cycle') {
                            cycleDetected = true;
                            // Publishes live at the call site (no double-fire).
                            // `runId` propagates so Phase 2 Hub Glue
                            // CycleCorrelator can dedup by run instead of
                            // collapsing concurrent runs that hit the same
                            // tool/args within the 5s TTL window.
                            bus.publish('system.alert', 'runtime', {
                              type: 'cycle_detected',
                              toolName: tc.name,
                              description: gate.description,
                              runId,
                            });
                            bus.publish('tool.blocked', ctx.agentId, {
                              runId,
                              toolName: tc.name,
                              reason: 'cycle_detected',
                              detail: gate.description,
                            });
                            return toolErrorRow(tc, `Cycle detected: ${gate.description}`);
                          }
                          if (gate.kind === 'hooked') {
                            bus.publish('tool.blocked', ctx.agentId, {
                              runId,
                              toolName: tc.name,
                              reason: 'hook_denied',
                              detail: gate.errorMsg,
                            });
                            // Cross-agent correlator: record the attempt that
                            // the HookManager denied (the applyBeforeToolCallSecurity
                            // correlator fire only runs on the allowed-path branch,
                            // so this denial path would otherwise leave the
                            // correlator empty). Fires once per hook-denial.
                            try {
                              this.securityOrch.onAgentEvent({
                                id: generateId(),
                                agentId: ctx.agentId,
                                runId,
                                type: 'tool_call',
                                summary: `Tool ${tc.name} (denied by hook)`,
                                metadata: {
                                  toolName: tc.name,
                                  allowed: false,
                                  hookReason: gate.errorMsg,
                                },
                                timestamp: Date.now(),
                                severity: 'high',
                              } as CrossAgentEvent);
                            } catch (err) {
                              reportSilentFailure(err, 'agentRuntime:2430');
                              /* best-effort */
                            }
                            return toolErrorRow(tc, `Hook blocked: ${gate.errorMsg || 'denied'}`);
                          }
                          // gate.kind === 'siblingAbort'
                          return gate.row;
                        }

                        // SecurityOrchestrator: unify ToolApproval + AdaptiveHITL before execution
                        const sec = await this.applyBeforeToolCallSecurity(tc, ctx.agentId, runId);
                        if (!sec.allowed && sec.blockedRawResult) {
                          return sec.blockedRawResult;
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
                          this.cacheManager.getToolCache().set(tc, toolResult, tenantId);
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
                    // Pre-tool-call safety gates (hook, retry, cycle).
                    // Concurrent-only sibling-abort is irrelevant on the
                    // serial path — no Promise.allSettled siblings.
                    const gate = await this.applyPreToolCallGates(
                      tc,
                      ctx.agentId,
                      runId,
                      ctx.tenantId,
                      recentToolPatterns,
                      toolLoopCount,
                    );
                    if (gate.kind !== 'allowed') {
                      let blockingRow: SyntheticErrorRow | null = null;
                      let shouldBreak = false;
                      switch (gate.kind) {
                        case 'hooked':
                          bus.publish('tool.blocked', ctx.agentId, {
                            runId,
                            toolName: tc.name,
                            reason: 'hook_denied',
                            detail: gate.errorMsg,
                          });
                          blockingRow = toolErrorRow(
                            tc,
                            `Hook blocked: ${gate.errorMsg || 'denied'}`,
                          );
                          break;
                        case 'retry':
                          retryLoopDetected = true;
                          blockingRow = toolErrorRow(tc, `Retry loop detected: ${tc.name}`);
                          shouldBreak = true;
                          break;
                        case 'cycle':
                          // `runId` propagates so the Phase 2 Hub Glue
                          // CycleCorrelator can dedup by run (key
                          // `${runId}:${toolName}:${description}`) instead
                          // of false-correlating concurrent runs that trigger the
                          // same gate. Mirrors the concurrent-path edit in the
                          // Promise.allSettled closure.
                          bus.publish('system.alert', 'runtime', {
                            type: 'cycle_detected',
                            toolName: tc.name,
                            description: gate.description,
                            runId,
                          });
                          bus.publish('tool.blocked', ctx.agentId, {
                            runId,
                            toolName: tc.name,
                            reason: 'cycle_detected',
                            detail: gate.description,
                          });
                          cycleDetected = true;
                          blockingRow = toolErrorRow(tc, `Cycle detected: ${gate.description}`);
                          shouldBreak = true;
                          break;
                        case 'siblingAbort':
                          // serial path does not consume siblingAbort — kept
                          // defensive so a future regression that lets it fire
                          // here still pushes the synthetic row instead of
                          // silently dropping the cancellation.
                          blockingRow = gate.row;
                          break;
                      }
                      if (blockingRow) rawResults.push(blockingRow);
                      if (shouldBreak) break;
                    }
                    // SecurityOrchestrator: unify ToolApproval + AdaptiveHITL before execution
                    const sec = await this.applyBeforeToolCallSecurity(tc, ctx.agentId, runId);
                    if (!sec.allowed && sec.blockedToolResult) {
                      console.warn(
                        `[SERIAL] BLOCKED ${tc.name} by security: ${sec.decision.blockReason ?? 'unknown'}`,
                      );
                    }
                    let toolResult: ToolResult;
                    if (!sec.allowed && sec.blockedToolResult) {
                      toolResult = sec.blockedToolResult;
                    } else {
                      console.warn(`[SERIAL] EXECUTING ${tc.name} toolLoopCount=${toolLoopCount}`);
                      toolResult = await this.executeTool(
                        runId,
                        tc,
                        ctx.agentId,
                        tenantId,
                        ctx.availableTools,
                      );
                    }
                    toolResult = await getHookManager().fireAfterToolCall({
                      toolName: tc.name,
                      args: tc.arguments,
                      result: toolResult,
                      agentId: ctx.agentId,
                      runId,
                    });
                    if (!toolResult.error) {
                      this.cacheManager.getToolCache().set(tc, toolResult, tenantId);
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
                      } catch (err) {
                        reportSilentFailure(err, 'agentRuntime:2712');
                        /* best-effort */
                      }
                    }
                  } catch (err) {
                    reportSilentFailure(err, 'agentRuntime:2717');
                    /* best-effort defense */
                  }
                  // Output sanitization: redact credentials, API keys, PII before tool results
                  // enter the LLM context. This prevents credential leakage via tool outputs.
                  try {
                    const sanitizeResult = sanitizeIfNeeded(finalOutput, {
                      agentId: ctx.agentId,
                      runId,
                      source: `tool:${masked.name}`,
                    });
                    if (sanitizeResult.wasRedacted) {
                      finalOutput = sanitizeResult.output;
                      bus.publish('system.alert', 'runtime', {
                        type: 'tool_output_sanitized',
                        toolCallId: masked.toolCallId,
                        categories: sanitizeResult.categories,
                      });
                    }
                  } catch (err) {
                    reportSilentFailure(err, 'agentRuntime:2737');
                    /* best-effort sanitization */
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
                    content: finalOutput,
                    durationMs: masked.durationMs,
                  };

                  // ── Hook: onStepComplete ──
                  getHookManager()
                    .fireOnStepComplete({
                      runId,
                      agentId: ctx.agentId,
                      stepNumber: tsNum,
                      type: 'tool_result',
                      content: finalOutput,
                    })
                    .catch((e) =>
                      getGlobalLogger().debug('AgentRuntime', 'onStepComplete hook failed', {
                        error: (e as Error)?.message,
                      }),
                    );

                  steps.push(toolStep);

                  // SecurityOrchestrator: feed tool result into GuardianAgent + CrossAgentCorrelator
                  try {
                    const toolEvent: CrossAgentEvent = {
                      id: generateId(),
                      agentId: ctx.agentId,
                      runId,
                      type: 'tool_result',
                      summary: `Tool ${masked.name}: ${finalOutput.slice(0, 80)}`,
                      metadata: {
                        toolName: masked.name,
                        toolCallId: masked.toolCallId,
                        outputLength: finalOutput.length,
                        hasError: !!masked.error,
                      },
                      timestamp: Date.now(),
                      severity: (masked.error ? 'high' : 'low') as CrossAgentEvent['severity'],
                    };
                    this.securityOrch.onAgentEvent(toolEvent);
                  } catch (err) {
                    reportSilentFailure(err, 'agentRuntime:2791');
                    /* best-effort */
                  }

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
                    content: finalOutput,
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
                const followUpRequest = await getHookManager().fireBeforeLLMCall(followUpCtx);
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
                totalTokens.cacheReadTokens =
                  (totalTokens.cacheReadTokens ?? 0) + (followUp.usage.cacheReadTokens ?? 0);
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
              console.warn(
                `[TOOL LOOP] EXIT after ${toolLoopCount} iterations. calls=${response.toolCalls?.length} cycle=${cycleDetected} retry=${retryLoopDetected} phase=${this.governor.getState().phase}`,
              );

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
                } catch (err) {
                  reportSilentFailure(err, 'agentRuntime:3046');
                  /* best-effort */
                }
                return result;
              }

              // ── Goal-completion verification gate ──
              // If the execution context names a verification tool, invoke it
              // before accepting a stop signal. A failed verification forces the
              // agent to continue rather than stopping early.
              let verificationPassed = !ctx.verificationTool;
              if (
                ctx.verificationTool &&
                (!response.toolCalls || response.toolCalls.length === 0)
              ) {
                const vToolCallId = `verify-${Date.now()}`;
                const vToolCall: ToolCall = {
                  id: vToolCallId,
                  name: ctx.verificationTool,
                  arguments: {},
                };
                getGlobalLogger().info('AgentRuntime', 'Running verification tool', {
                  tool: ctx.verificationTool,
                  runId,
                });
                const vStart = Date.now();
                let vResult = await this.executeTool(
                  runId,
                  vToolCall,
                  ctx.agentId,
                  tenantId,
                  ctx.availableTools,
                  ctx,
                );
                try {
                  vResult = await getHookManager().fireAfterToolCall({
                    toolName: vToolCall.name,
                    args: vToolCall.arguments,
                    result: vResult,
                    agentId: ctx.agentId,
                    runId,
                  });
                } catch {
                  /* best-effort hook */
                }
                const vDuration = Date.now() - vStart;
                const vOutput = vResult.error ? `error: ${vResult.error}` : vResult.output;

                steps.push({
                  stepNumber: steps.length + 1,
                  timestamp: now(),
                  type: 'tool_result',
                  content: vOutput,
                  durationMs: vDuration,
                });

                const vAssistantMsg: import('./types').LLMMessage = {
                  role: 'assistant',
                  content: response.content,
                  ...(response.reasoning_content
                    ? { reasoning_content: response.reasoning_content }
                    : {}),
                  tool_calls: [
                    {
                      id: vToolCallId,
                      type: 'function' as const,
                      function: {
                        name: vToolCall.name,
                        arguments: JSON.stringify(vToolCall.arguments),
                      },
                    },
                  ],
                };
                request.messages.push(vAssistantMsg, {
                  role: 'tool',
                  content: vOutput,
                  tool_call_id: vToolCallId,
                });

                verificationPassed = this.isVerificationResultSuccessful(vResult);
                getGlobalLogger().info('AgentRuntime', 'Verification tool result', {
                  tool: ctx.verificationTool,
                  passed: verificationPassed,
                  runId,
                });

                if (!verificationPassed && attempt < this.config.maxRetries) {
                  const feedback = vResult.error
                    ? `Verification tool "${ctx.verificationTool}" reported an error: ${vResult.error}. Use the available tools to complete the task, then call "${ctx.verificationTool}" again.`
                    : `Verification tool "${ctx.verificationTool}" did not report success because the task is not complete. Use the available tools to finish the work, then call "${ctx.verificationTool}" again.`;
                  lastError = feedback;
                  request.messages.push({ role: 'user', content: feedback });
                  continue;
                }
              }

              // Early exit: skip verification when model is confident and has no tool calls.
              // This saves the verification token cost (~500-2000 tokens) and avoids
              // unnecessary retries on confident responses.
              if (earlyExit) {
                let safeContent =
                  response.content ||
                  (response as { reasoning_content?: string }).reasoning_content ||
                  '';
                // Hoisted scan-then-gate: previously lived as `await (async () => {...})()`
                // inside the result.summary assignment, which fired bus events during
                // object construction. Extracting the side effects out of the object
                // literal makes the data flow obvious: safeContent is sanitized in
                // place, then the result object captures it.
                let scannedSummary = safeContent;
                try {
                  const earlyExitScan = await this.contentScanner.scan(safeContent);
                  if (!earlyExitScan.isSafe) {
                    getMessageBus().publish('system.alert', 'runtime', {
                      type: 'content_threat_blocked',
                      via: 'early_exit_scan',
                      runId,
                      agentId: ctx.agentId,
                      threats: earlyExitScan.threats.map((t) => `${t.type}:${t.severity}`),
                      riskScore: earlyExitScan.riskScore,
                    });
                    scannedSummary = `[Content blocked: ${earlyExitScan.threats.length} threat(s) (risk=${earlyExitScan.riskScore})]`;
                    safeContent = scannedSummary;
                  }
                } catch (e) {
                  getGlobalLogger().debug('AgentRuntime', 'earlyExit content scan failed', {
                    error: (e as Error)?.message,
                  });
                }
                const totalDurationMs = Date.now() - startTime;
                const result: AgentExecutionResult = {
                  runId,
                  agentId: ctx.agentId,
                  missionId: ctx.missionId,
                  status: 'success',
                  summary: scannedSummary || '[Early exit: confident response]',
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
                      `[EARLY_EXIT] ${ctx.goal.slice(0, GOAL_TELEMETRY_MAX_CHARS)}`,
                      'episodic',
                      `run:${runId}|tokens:${totalTokens.totalTokens}|dur:${totalDurationMs}ms|steps:${steps.length}`,
                      0.6,
                      ['execution', 'early_exit', ...ctx.availableTools.slice(0, 3)],
                      {
                        runId,
                        goal: ctx.goal.slice(0, GOAL_RESULT_MAX_CHARS),
                        tokenUsage: totalTokens,
                        durationMs: totalDurationMs,
                      },
                    );
                  } catch (err) {
                    reportSilentFailure(err, 'agentRuntime:3226');
                    /* best-effort */
                  }
                }

                getMetricsCollector().recordRunComplete(
                  'success_early_exit',
                  totalDurationMs,
                  steps.length,
                  tenantId,
                  getCostEstimator().estimateCostFromUsage(
                    routing.modelId,
                    totalTokens.promptTokens,
                    totalTokens.completionTokens,
                  ),
                );
                bus.publish('agent.completed', ctx.agentId, {
                  runId,
                  status: 'success',
                  summary: safeContent.slice(0, RESULT_CONTENT_MAX_CHARS),
                  tokenUsage: totalTokens,
                  durationMs: totalDurationMs,
                });

                // Record final cost for estimator learning
                try {
                  const modelCfg = this.router.getModel(routing.modelId);
                  costEstimator.recordActualCost(
                    costEstimate.taskCategory,
                    routing.tier,
                    totalTokens.promptTokens,
                    totalTokens.completionTokens,
                    totalTokens.cacheReadTokens ?? 0,
                    modelCfg?.costPer1MInput ?? 3,
                    modelCfg?.costPer1MOutput ?? 10,
                    modelCfg?.costPer1MCachedInput,
                    totalDurationMs,
                    true,
                  );
                } catch (err) {
                  reportSilentFailure(err, 'agentRuntime:3266');
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
                } catch (err) {
                  reportSilentFailure(err, 'agentRuntime:3351');
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
                } catch (err) {
                  reportSilentFailure(err, 'agentRuntime:3379');
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
              } catch (err) {
                reportSilentFailure(err, 'agentRuntime:3415');
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
                  outputPrefix: response.content.slice(0, OUTPUT_PREFIX_MAX_CHARS),
                  goal: ctx.goal.slice(0, GOAL_FULL_MAX_CHARS),
                  report: verifReport,
                });
              } catch (err) {
                reportSilentFailure(err, 'agentRuntime:3433');
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
                    totalTokens.cacheReadTokens =
                      (totalTokens.cacheReadTokens ?? 0) +
                      (reflexionResponse.usage.cacheReadTokens ?? 0);
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
                    } catch (err) {
                      reportSilentFailure(err, 'agentRuntime:3571');
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
                      ? (this.smartRouter.getModel(nextId.id) as ModelConfig | undefined)
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
                    } catch (err) {
                      reportSilentFailure(err, 'agentRuntime:3679');
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
                    } catch (err) {
                      reportSilentFailure(err, 'agentRuntime:3693');
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
                  // Any non-safe result blocks -- covers both HIGH/CRITICAL single
                  // threats AND composite MEDIUM threats that pushed riskScore >= 50.
                  bus.publish('system.alert', 'runtime', {
                    type: 'content_threat_blocked',
                    threats: scanResult.threats.map((t) => `${t.type}:${t.severity}`),
                    riskScore: scanResult.riskScore,
                  });
                  safeContent = `[Content blocked: ${scanResult.threats.length} security threat(s) detected (risk=${scanResult.riskScore}). Review and resubmit.]`;
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
                } catch (err) {
                  reportSilentFailure(err, 'agentRuntime:3747');
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
                    safeContent = msg.content.slice(0, ERROR_MAX_CHARS);
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
                safeContent = `[No text response generated by agent] Goal: ${ctx.goal.slice(0, GOAL_TELEMETRY_MAX_CHARS)}`;
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
                costEstimator.recordActualCost(
                  costEstimate.taskCategory,
                  routing.tier,
                  totalTokens.promptTokens,
                  totalTokens.completionTokens,
                  totalTokens.cacheReadTokens ?? 0,
                  modelCfg?.costPer1MInput ?? 3,
                  modelCfg?.costPer1MOutput ?? 10,
                  modelCfg?.costPer1MCachedInput,
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
              } catch (err) {
                reportSilentFailure(err, 'agentRuntime:3838');
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
                    `[SUCCESS] ${ctx.goal.slice(0, GOAL_TELEMETRY_MAX_CHARS)}`,
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
                getCostEstimator().estimateCostFromUsage(
                  routing.modelId,
                  totalTokens.promptTokens,
                  totalTokens.completionTokens,
                ),
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

              // Record intelligence: postTask, metaLearner, failure patterns
              try {
                getAgentIntelligence().postTask({
                  task: ctx.goal,
                  taskType: taskType || 'general',
                  effortLevel: routing.tier,
                  topology: ctx.subAgentRole || 'SINGLE',
                  tokens: totalTokens.totalTokens,
                  durationMs: totalDurationMs,
                  success: true,
                  steps: steps.map((s) => ({
                    action: s.content?.slice(0, 200) || '',
                    tool: s.toolCall?.name || 'llm',
                    result: s.toolResult?.output?.slice(0, 200) || '',
                  })),
                  runId,
                });
              } catch (err) {
                reportSilentFailure(err, 'agentRuntime:3937');
                /* best-effort */
              }

              try {
                getMetaLearner().recordExperience({
                  id: `exp-${runId}-success`,
                  runId,
                  agentId: ctx.agentId,
                  missionId: ctx.missionId,
                  taskType: taskType || 'general',
                  strategyUsed: ctx.subAgentRole || 'SEQUENTIAL',
                  success: true,
                  durationMs: totalDurationMs,
                  tokenCost: totalTokens.totalTokens,
                  modelUsed: routing.modelId,
                  timestamp: new Date().toISOString(),
                  topology: ctx.subAgentRole || 'SEQUENTIAL',
                  lessons: result.summary ? [result.summary.slice(0, 200)] : [],
                });
              } catch (err) {
                reportSilentFailure(err, 'agentRuntime:3958');
                /* best-effort */
              }
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
            costEstimator.recordActualCost(
              costEstimate.taskCategory,
              routing.tier,
              totalTokens.promptTokens,
              totalTokens.completionTokens,
              totalTokens.cacheReadTokens ?? 0,
              modelCfg?.costPer1MInput ?? 3,
              modelCfg?.costPer1MOutput ?? 10,
              modelCfg?.costPer1MCachedInput,
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
            } catch (err) {
              reportSilentFailure(err, 'agentRuntime:4035');
              /* best-effort */
            }
          } catch (err) {
            reportSilentFailure(err, 'agentRuntime:4039');
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
                `[FAIL] ${ctx.goal.slice(0, GOAL_TELEMETRY_MAX_CHARS)}`,
                'episodic',
                `run:${runId}|error:${(lastError ?? 'unknown').slice(0, 100)}|dur:${Date.now() - startTime}ms`,
                0.5 + (lastErrorIsPermanent ? 0.3 : 0),
                ['execution', 'failure', ...ctx.availableTools.slice(0, 3)],
                { runId, goal: ctx.goal.slice(0, GOAL_RESULT_MAX_CHARS), error: lastError },
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
            getCostEstimator().estimateCostFromUsage(
              routing.modelId,
              totalTokens.promptTokens,
              totalTokens.completionTokens,
            ),
          );
          bus.publish('agent.failed', ctx.agentId, {
            runId,
            missionId: ctx.missionId,
            error: lastError,
          });

          // Record intelligence: postTask (failure), metaLearner, failure patterns
          try {
            getAgentIntelligence().postTask({
              task: ctx.goal,
              taskType: taskType || 'general',
              effortLevel: routing.tier,
              topology: ctx.subAgentRole || 'SINGLE',
              tokens: totalTokens.totalTokens,
              durationMs: Date.now() - startTime,
              success: false,
              steps: steps.map((s) => ({
                action: s.content?.slice(0, 200) || '',
                tool: s.toolCall?.name || 'llm',
                result: s.toolResult?.output?.slice(0, 200) || '',
              })),
              error: lastError,
              runId,
            });
          } catch (err) {
            reportSilentFailure(err, 'agentRuntime:4129');
            /* best-effort */
          }

          try {
            getMetaLearner().recordExperience({
              id: `exp-${runId}-failure`,
              runId,
              agentId: ctx.agentId,
              missionId: ctx.missionId,
              taskType: taskType || 'general',
              strategyUsed: ctx.subAgentRole || 'SEQUENTIAL',
              success: false,
              durationMs: Date.now() - startTime,
              tokenCost: totalTokens.totalTokens,
              modelUsed: routing.modelId,
              timestamp: new Date().toISOString(),
              topology: ctx.subAgentRole || 'SEQUENTIAL',
              errorPattern: lastError,
              lessons: lastError ? [lastError.slice(0, 200)] : [],
            });
          } catch (err) {
            reportSilentFailure(err, 'agentRuntime:4151');
            /* best-effort */
          }

          try {
            getFailurePatternLearner().recordFailure({
              task: ctx.goal,
              error: lastError || 'Unknown error',
              context: `runId:${runId}|topology:${ctx.subAgentRole || 'SINGLE'}|tokens:${totalTokens.totalTokens}`,
              category: 'other',
            });
          } catch (err) {
            reportSilentFailure(err, 'agentRuntime:4163');
            /* best-effort */
          }

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
      this.runLifecycle.removeRun(runId);
      getMetricsCollector().setGauge(
        'active_runs',
        'Active concurrent runs',
        this.runLifecycle.getActiveRunCount(),
      );
      if (tenantCfg?.enabled && tenantCfg.maxConcurrency > 0 && tenantId) {
        this.tenantManager.releaseTenantConcurrency(tenantId);
      }
      getLaneManager().releaseSlot(currentLane);
      this.concurrencyController.releaseSlot();
      try {
        tracer.completeRun(runId);
      } catch (e) {
        getGlobalLogger().warn('AgentRuntime', 'Failed to complete trace', {
          runId,
          error: (e as Error)?.message,
        });
      }
      // SLO check: evaluate trace against all active SLOs and record violations
      try {
        const trace = tracer.getTrace(runId);
        if (trace) {
          const sloManager = getSLOManager();
          const violations = sloManager.checkTrace(trace);
          for (const v of violations) {
            const sloDef = sloManager.getSLO(v.sloId);
            getMetricsCollector().recordSLOViolation(
              v.sloId,
              sloDef?.name ?? v.sloId,
              v.metric,
              v.severity,
              v.actualValue,
              v.threshold,
              tenantId,
            );
          }
        }
      } catch (e) {
        getGlobalLogger().warn('AgentRuntime', 'SLO check failed', {
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
              await fs.promises.mkdir(sopDir, { recursive: true });
              const sopPath = path.join(sopDir, `${runId}.md`);
              await fs.promises.writeFile(sopPath, formatSOPAsMarkdown(sop), 'utf-8');
              // Also write structured JSON for API retrieval
              const jsonPath = path.join(sopDir, `${runId}.json`);
              await fs.promises.writeFile(jsonPath, JSON.stringify(sop, null, 2), 'utf-8');
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
    // Plugin hook: beforeBackendSelect — can override the selected provider
    const hookSelected = await getHookManager()
      .fireBeforeBackendSelect({
        toolName: routing.provider,
        args: request as unknown as Record<string, unknown>,
        agentId: taskId ?? 'unknown',
        runId: taskId ?? 'unknown',
      })
      .catch(() => null);
    const resolvedProvider = hookSelected ?? routing.provider;

    const primaryProvider = this.providers.get(resolvedProvider);
    const entries: ProviderEntry<import('./types').LLMResponse>[] = [];

    if (primaryProvider) {
      entries.push({
        name: resolvedProvider,
        attempt: () =>
          this.callProviderOrThrow(
            primaryProvider,
            resolvedProvider,
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
      getHookManager()
        .fireAfterBackendSelect({
          toolName: routing.provider,
          args: request as unknown as Record<string, unknown>,
          selectedBackend: resolvedProvider,
          agentId: taskId ?? 'unknown',
          runId: taskId ?? 'unknown',
        })
        .catch(() => {});
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
      const cached = await this.cacheManager.lookupSemantic(request);
      if (cached) {
        try {
          getMetricsCollector().recordSemanticCacheEvent(
            'hit',
            0,
            getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
          );
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:4441');
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
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:4453');
        /* best-effort */
      }

      // Google Gemini cachedContent wiring: when the provider is Google and the request carries
      // a system prompt, try to attach a server-side cached content name. Failures fall through
      // (cachedContent is a cost optimization, not a correctness requirement).
      if (providerName === 'google' && request.cacheConfig) {
        const systemMsg = request.messages.find((m) => m.role === 'system');
        const tenantForGemini = getGlobalTenantProvider().getCurrentTenantId() ?? undefined;
        try {
          const lookup = await this.cacheManager.getGeminiCachedContent({
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
            } catch (err) {
              reportSilentFailure(err, 'agentRuntime:4480');
              /* best-effort */
            }
          }
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:4485');
          try {
            getMetricsCollector().recordGeminiCacheEvent('error', tenantForGemini);
          } catch (err) {
            reportSilentFailure(err, 'agentRuntime:4489');
            /* best-effort */
          }
        }
      }

      const tenantIdForFlight = getGlobalTenantProvider().getCurrentTenantId() ?? undefined;
      const flightKey = SingleFlightRequestCache.computeKey(request, tenantIdForFlight);
      const evictionsBefore = this.cacheManager.getSingleFlightStats().evictions;
      const inflightBefore = this.cacheManager.getSingleFlightInflightCount();
      const llmTimeoutMs = this.config.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
      const result: LLMResponse = await this.cacheManager.dedupeSingleFlight(
        flightKey,
        async () => {
          return this.stepTimeout.wrap(provider.call(request), {
            timeoutMs: llmTimeoutMs,
            stepId: `llm-${providerName}-${attemptNumber}-${taskId ?? 'main'}`,
          });
        },
        tenantIdForFlight,
      );
      const recentEvictionDelta =
        this.cacheManager.getSingleFlightStats().evictions - evictionsBefore;
      const wasHit = this.cacheManager.getSingleFlightInflightCount() === inflightBefore;
      try {
        getMetricsCollector().recordSingleFlightEvent(wasHit ? 'hit' : 'miss', tenantIdForFlight);
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:4517');
        /* best-effort */
      }
      if (recentEvictionDelta > 0) {
        try {
          getMetricsCollector().recordSingleFlightEvent('eviction', tenantIdForFlight);
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:4524');
          /* best-effort */
        }
      }
      this.cacheManager.storeSemantic(request, result);
      try {
        getMetricsCollector().recordSemanticCacheEvent(
          'store',
          0,
          getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
        );
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:4536');
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
    } catch (err) {
      reportSilentFailure(err, 'agentRuntime:4575');
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
    return this.toolExecutionService.execute(
      runId,
      toolCall,
      agentId,
      tenantId,
      allowedTools,
      agentCtx,
      this.executedMutations,
    );
  }
  private generateActionId(): string {
    return `act_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /** Heuristic used by the goal-completion verification gate. A verification
   *  tool succeeds when it reports no error and its output contains an explicit
   *  success signal (or a JSON `passed`/`success`/`ok` field). */
  private isVerificationResultSuccessful(result: ToolResult): boolean {
    if (result.error) return false;
    const output = String(result.output ?? '');
    if (/\b(error|fail|failed|failure|invalid|unsuccessful|false)\b/i.test(output)) {
      return false;
    }
    if (/\b(pass|passed|success|successful|ok|valid|true)\b/i.test(output)) {
      return true;
    }
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === 'object') {
        if ('passed' in parsed) return Boolean(parsed.passed);
        if ('success' in parsed) return Boolean(parsed.success);
        if ('ok' in parsed) return Boolean(parsed.ok);
      }
    } catch {
      /* not JSON */
    }
    return true;
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
    return this.runLifecycle.pauseRun(runId);
  }

  /**
   * Clear the pause flag for a run (e.g., after resume).
   */
  unpauseRun(runId: string): void {
    this.runLifecycle.unpauseRun(runId);
  }

  isPaused(runId: string): boolean {
    return this.runLifecycle.isPaused(runId);
  }

  /**
   * List all active runs with their pause state.
   * Returns an array of { runId, paused, checkpointPhase }.
   */
  getActiveRuns(): Array<{ runId: string; paused: boolean; checkpointPhase?: string }> {
    return this.runLifecycle.getActiveRuns().map((runId) => {
      const checkpoint = this.checkpointer.resume(runId);
      return {
        runId,
        paused: this.runLifecycle.isPaused(runId),
        checkpointPhase: checkpoint?.phase,
      };
    });
  }

  getActiveRunCount(): number {
    return this.runLifecycle.getActiveRunCount();
  }

  isRunActive(runId: string): boolean {
    return this.runLifecycle.isActive(runId);
  }

  getSemanticCacheStats() {
    return this.cacheManager.getSemanticCacheStats();
  }

  getSingleFlightStats(): SingleFlightStats {
    return this.cacheManager.getSingleFlightStats();
  }

  getGeminiCacheStats(): GeminiCacheStats {
    return this.cacheManager.getGeminiCacheStats();
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
    this.compensationService.dispose();
    this.cacheManager.dispose();
    this.reliabilityEngine.shutdown();
    try {
      getModelPerformanceStore().dispose();
    } catch (err) {
      reportSilentFailure(err, 'agentRuntime:4779');
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
    this.tenantManager.flushAll();
  }
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
