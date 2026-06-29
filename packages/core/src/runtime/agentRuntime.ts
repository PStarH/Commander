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
  LLMMessage,
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
import { ContextCompactor } from './contextCompactor';
import { SlidingWindowOrchestrator } from './slidingWindowOrchestrator';
import { classifyLLMError, computeBackoff } from './llmRetry';
import { CircuitBreaker } from './circuitBreaker';
import { createParameterControllerPlugin } from './parameterController';
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
import { ExecutionContextInjector } from './executionContextInjector';
import { ExecutionRouter } from './executionRouter';
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
import { ToolPlanner } from './toolPlanner';
import { CycleDetector } from './cycleDetector';
import { parseStructuredOutput } from './structuredOutput';
import { getExecutionScheduler, type RunHandle } from '../atr/scheduler';
import { LeaseManager } from '../atr/leaseManager';
import { isConfidentResponse } from './entropyGater';
import { InterruptError } from './interruptError';
import { createContentScanner, type ContentScanner } from '../contentScanner';
import { scanToolOutputForInjection, enforceToolOutputSecurity } from '../contentScanner';
import { sanitizeIfNeeded } from '../security/outputSanitizer';
import { getCostGuard } from '../security/costGuard';
import { getCapabilityTokenIssuer } from '../security/capabilityToken';
import { getEnterpriseSecurityGateway } from '../security/enterpriseSecurityGateway';
import { checkMemoryPoisoning } from '../security/memoryPoisoningGate';
import { getMemoryPoisoningDefenseEngine } from '../security/memoryPoisoningDefenseEngine';
import { isAgentSuspended, isAgentQuarantined, getThrottleMultiplier, processSecurityAlert } from '../security/securityResponseEngine';
import type { SecurityAlert } from '../security/securityResponseEngine';
import { assertInvariants } from '../security/securityInvariantVerifier';
import { getHallucinationDetector } from '../hallucinationDetector';
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
import { initializeServices, type InitializedServices } from './serviceInitializer';
import { CheckpointingPhase } from './phases/checkpointing';
import { RunTelemetryRecorder } from './runTelemetryRecorder';
import {
  createInitialAgentExecutionState,
  type AgentExecutionState,
} from './phases/AgentExecutionState';
import {
  OpenTelemetryExporter,
  getOTelExporter,
  executionTraceToOtlpSpans,
} from './openTelemetryExporter';
import { exportSOPFromTrace, formatSOPAsMarkdown } from './sopExport';
import {
  FinallyCleanupHandler,
  type TenantOverrides,
} from './finallyCleanupHandler';
import { LLMRequestBuilder } from './llmRequestBuilder';
import { GoalCompletionVerifier } from './goalCompletionVerifier';
import { ToolExecutionHandler } from './toolExecutionHandler';
import { ReflexionGenerator, type ReflexionContext } from './reflexionGenerator';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalLogger } from '../logging';
import { getDataRetentionJanitor } from '../storage/dataRetention';
import type { CompactTaskType } from './contextCompactor';
import { getCostEstimator, type CostEstimate } from './costEstimator';
import { getTokenSentinel } from '../telos/tokenSentinel';
import { DEFAULT_TELOS_CONFIG, type TELOSBudget } from '../telos/types';
import { getModelPerformanceStore } from './modelPerformanceStore';
import { getSecurityMonitor } from '../security/securityMonitor';
import { initializeRuntimeGuardian } from './runtimeGuardianBridge';
import {
  SecurityOrchestrator,
  type SecurityOrchestratorDecision,
} from './securityOrchestrator';
import type { CrossAgentEvent } from '../security/crossAgentCorrelator';
import {
  DEFAULT_CONFIG,
  generateId,
  now,
  delay,
} from './runtimeHelpers';

// ============================================================================
// Tenant context resolution — extracted from execute() for clarity
// ============================================================================
// NOTE: TenantOverrides is now imported from ./finallyCleanupHandler to keep a
// single source of truth shared with the cleanup handler.

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
  private contextInjector: ExecutionContextInjector;
  private executionRouter: ExecutionRouter;
  private teamRegistry: TeamRegistry;
  private agentHandoff: AgentHandoff;
  private outputManager: ToolOutputManager;
  private breakerRegistry: import('./circuitBreakerRegistry').CircuitBreakerRegistry;
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
  private checkpointingPhase: CheckpointingPhase;
  // Records success/failure run telemetry (hooks, metrics, bus, circuit
  // breaker, memory, intelligence, meta-learner) - extracted from execute().
  private runTelemetryRecorder: RunTelemetryRecorder;
  // Finally-block cleanup — extracted from execute() for testability/clarity
  private finallyCleanupHandler: FinallyCleanupHandler;
  // Extracted from execute() step 2 — builds the cache-optimized LLM request.
  private llmRequestBuilder: LLMRequestBuilder;
  // Extracted from execute()'s retry loop — verifies goal completion via the
  // configured verification tool before accepting a stop signal.
  private goalCompletionVerifier: GoalCompletionVerifier;
  // Extracted from execute()'s retry loop — owns the per-response tool-execution
  // phase (onStepStart → tool dispatch → result redaction → onStepComplete).
  private toolExecutionHandler: ToolExecutionHandler;

  // Tenant config provider (kept for direct lookups in execute())
  private tenantProvider: TenantProvider;

  // Last error from a provider call, preserved so the retry loop can
  // classify it properly instead of seeing "Unknown error".
  private lastProviderError: Error | null = null;
  // Last hallucination detection result, fed into AdaptiveHITL signals.
  private lastHallucinationDetected = false;

  constructor(
    config?: Partial<AgentRuntimeConfig>,
    router?: ModelRouter,
    tenantProvider?: TenantProvider,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Wire providerRetry config into maxRetries and retryDelayMs so callers
    // can control provider-level retry behavior without setting individual fields.
    if (config?.providerRetry) {
      if (config.providerRetry.attempts !== undefined) {
        this.config.maxRetries = config.providerRetry.attempts;
      }
      if (config.providerRetry.initialDelayMs !== undefined) {
        this.config.retryDelayMs = config.providerRetry.initialDelayMs;
      }
    }

    this.router = router ?? getModelRouter();
    if (this.config.smartModelRouter?.enabled) {
      this.smartRouter =
        SmartModelRouter.fromEnv() ??
        new SmartModelRouter(this.config.smartModelRouter as Partial<ModelRouterUserConfig>);
    }
    this.tenantProvider = tenantProvider ?? getGlobalTenantProvider();

    // Delegate subsystem construction to ServiceInitializer so this file stays
    // an orchestrator rather than a 500-line constructor.
    const services = initializeServices(
      {
        config: this.config,
        getRunHandle: () => this.runHandle,
        getLedgerCtx: () => this.ledgerCtx,
        getActiveRuns: () => new Set(this.runLifecycle?.getActiveRuns() ?? []),
        getPromotedTools: () => this.promotedTools,
        generateActionId: () => this.generateActionId(),
      },
      this.tools,
    );

    // Promote all initialized services to instance fields (preserves the
    // existing AgentRuntimeInterface surface while shrinking the god object).
    this.compactor = services.compactor;
    this.slidingWindow = services.slidingWindow;
    this.reliabilityEngine = services.reliabilityEngine;
    this.circuitBreaker = services.circuitBreaker;
    this.dlq = services.dlq;
    this.checkpointer = services.checkpointer;
    this.governor = services.governor;
    this.verificationPipeline = services.verificationPipeline;
    this.verificationPipeline.setRuntime(this);
    this.reflexionInjector = services.reflexionInjector;
    this.reflexionGenerator = services.reflexionGenerator;
    this.samplesStore = services.samplesStore;
    this.traceStore = services.traceStore;
    this.leaseManager = services.leaseManager;
    this.stepTimeout = services.stepTimeout;
    this.fallbackChain = services.fallbackChain;
    this.compensationService = services.compensationService;
    this.agentInbox = services.agentInbox;
    this.teamRegistry = services.teamRegistry;
    this.agentHandoff = services.agentHandoff;
    this.cacheManager = services.cacheManager;
    this.concurrencyController = services.concurrencyController;
    this.runLifecycle = services.runLifecycle;
    this.tenantManager = services.tenantManager;
    this.toolExecutionService = services.toolExecutionService;
    this.outputManager = services.outputManager;
    this.breakerRegistry = services.breakerRegistry;
    this.orchestrator = services.orchestrator;
    this.planner = services.planner;
    this.cycleDetector = services.cycleDetector;
    this.contentScanner = services.contentScanner;
    this.securityOrch = services.securityOrch;
    this.contextInjector = services.contextInjector;
    this.memory = services.memory;
    this.memoryStore = services.memoryStore;
    this.conversationStore = services.conversationStore;
    this.otelExporter = services.otelExporter;

    this.executionRouter = new ExecutionRouter({
      getSmartRouter: () => this.smartRouter,
      isSmartRouterActive: () => this.smartRouterActive,
      getRouter: () => this.router,
      getGovernor: () => this.governor,
      getProviders: () => this.providers,
    });

    this.checkpointingPhase = new CheckpointingPhase({
      checkpointer: this.checkpointer,
      runLifecycle: this.runLifecycle,
      leaseManager: this.leaseManager,
    });

    // RunTelemetryRecorder owns the success/failure telemetry tails that were
    // previously inlined in execute()'s retry loop. Getters are used so the
    // recorder always reads the runtime's current state (e.g. runHandle is
    // assigned mid-run, router/memory are stable after init).
    this.runTelemetryRecorder = new RunTelemetryRecorder({
      getMemory: () => this.memory,
      getRouter: () => this.router,
      getCircuitBreaker: () => this.circuitBreaker,
      getRunHandle: () => this.runHandle,
      getCheckpointingPhase: () => this.checkpointingPhase,
      getMaxRetries: () => this.config.maxRetries,
    });

    // Wire the finally-block cleanup handler with getter callbacks so it always
    // observes the runtime's current (possibly tenant-overridden) instance
    // fields rather than values captured at construction time.
    this.finallyCleanupHandler = new FinallyCleanupHandler({
      getCircuitBreaker: () => this.circuitBreaker,
      getRunLifecycle: () => this.runLifecycle,
      getTenantManager: () => this.tenantManager,
      getConcurrencyController: () => this.concurrencyController,
      getTracer: () => getTraceRecorder(),
      getConfig: () => this.config,
      getOtelExporter: () => this.otelExporter,
      getSamplesStore: () => this.samplesStore,
      getTraceStore: () => this.traceStore,
      getConversationStore: () => this.conversationStore,
      restoreTenantOverrides: (overrides, tenantId) =>
        this.restoreTenantOverrides(overrides, tenantId),
    });

    // LLMRequestBuilder — dependency-injected via getter/setter callbacks so it
    // always observes the runtime's current (per-run) instance fields rather
    // than values captured at construction time.
    this.llmRequestBuilder = new LLMRequestBuilder({
      getConfig: () => this.config,
      getGovernor: () => this.governor,
      getRouter: () => this.router,
      getTools: () => this.tools,
      setPromotedTools: (tools: Set<string>) => {
        this.promotedTools = tools;
      },
      setTool: (name: string, tool: Tool) => {
        this.tools.set(name, tool);
      },
      getLastPrefixCacheKey: () => this.lastPrefixCacheKey,
      setLastPrefixCacheKey: (key: string) => {
        this.lastPrefixCacheKey = key;
      },
    });

    // GoalCompletionVerifier — owns the goal-completion verification gate that
    // previously lived inline in execute()'s retry loop. Getter callbacks keep
    // it decoupled from the runtime's concrete (possibly per-tenant) state.
    this.goalCompletionVerifier = new GoalCompletionVerifier({
      getExecuteTool: () => this.executeTool.bind(this),
      getMaxRetries: () => this.config.maxRetries,
    });

    // ToolExecutionHandler — owns the tool-execution phase that previously lived
    // inline in execute()'s retry loop (onStepStart hook → tool-call parsing →
    // batch-safe/sequential dispatch → result redaction → onStepComplete →
    // follow-up LLM call). Getter callbacks keep it decoupled from the runtime's
    // concrete (possibly per-tenant) instance fields; the runtime-method
    // callbacks are bound so `this` resolves correctly inside the handler.
    this.toolExecutionHandler = new ToolExecutionHandler({
      getConfig: () => this.config,
      getTools: () => this.tools,
      getGovernor: () => this.governor,
      getCacheManager: () => this.cacheManager,
      getPlanner: () => this.planner,
      getOrchestrator: () => this.orchestrator,
      getOutputManager: () => this.outputManager,
      getCycleDetector: () => this.cycleDetector,
      getSecurityOrch: () => this.securityOrch,
      getSlidingWindow: () => this.slidingWindow,
      getMemory: () => this.memory,
      getCompactor: () => this.compactor,
      normalizeToolCall: (tc) => this.normalizeToolCall(tc),
      applyPreToolCallGates: (
        tc,
        agentId,
        runId,
        tenantId,
        recentToolPatterns,
        toolLoopCount,
        siblingAbortSignal,
      ) =>
        this.applyPreToolCallGates(
          tc,
          agentId,
          runId,
          tenantId,
          recentToolPatterns,
          toolLoopCount,
          siblingAbortSignal,
        ),
      applyBeforeToolCallSecurity: (tc, agentId, runId) =>
        this.applyBeforeToolCallSecurity(tc, agentId, runId),
      executeTool: (runId, toolCall, agentId, tenantId, allowedTools, agentCtx) =>
        this.executeTool(runId, toolCall, agentId, tenantId, allowedTools, agentCtx),
      invalidateMutationCache: (toolName) => this.invalidateMutationCache(toolName),
      callWithTimeout: (request, routing, attemptNumber, taskId) =>
        this.callWithTimeout(request, routing, attemptNumber, taskId),
      setExecutedMutations: (mutations) => {
        this.executedMutations = mutations;
      },
      setLastHallucinationDetected: (value) => {
        this.lastHallucinationDetected = value;
      },
    });

    // Benchmarks may intentionally generate high tool-call volumes; let callers
    // disable GuardianAgent monitoring through the runtime config.
    if (this.config.securityMonitor?.enabled === false) {
      this.securityOrch.updateConfig({ enableGuardianAgent: false });
    }

    // SOC 2 C1.2 / GDPR Art 17 disposal — schedule the retention janitor from
    // the runtime constructor so CLI-only paths still get the housekeeping tick.
    try {
      const janitor = getDataRetentionJanitor();
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

    // Initialize the runtime guardian bridge with this runtime's provider access.
    // Only initialize when explicitly enabled in config — avoids side effects
    // in tests that don't expect extra LLM calls from the guardian.
    if (this.config.runtimeGuardian?.enabled) {
      try {
        const runtimeRef = this;
        initializeRuntimeGuardian(
          (name: string) => {
            const provider = runtimeRef.getProvider(name);
            if (!provider) return null;
            return {
              call: (input: {
                model: string;
                messages: { role: string; content: string }[];
                maxTokens: number;
              }) =>
                provider.call({
                  ...input,
                  messages: input.messages as LLMMessage[],
                }),
            };
          },
          this.config.runtimeGuardian,
        );
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:runtime-guardian-init');
        /* best-effort — GuardianAgent rules still provide baseline protection */
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
        // `runId` propagates so Phase 2 Hub Glue
        // RetryHookCorrelator can dedup by run
        // (key `${runId}:${toolName}:${pattern}`) instead of
        // collapsing concurrent runs that hit the same
        // tool/args within the 5s TTL window. `runId`
        // is the local param from `checkRetryLoop`'s
        // closure — same value as agentRuntime.execute()'s
        // top-level `const runId = generateId()`.
        runId,
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
      {
        verification: {
          confidence: 0.95,
          gateFailures: [],
          hallucinationDetected: this.lastHallucinationDetected,
        },
      },
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

  /** Return the names of all registered tools. */
  listToolNames(): string[] {
    return Array.from(this.tools.keys());
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
    return this.breakerRegistry;
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
    const costEstimator = getCostEstimator();
    const startTime = Date.now();
    const state = createInitialAgentExecutionState(ctx);
    (state as { runId: string }).runId = runId;

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

          // 1. Model routing + Privacy + Cost estimation
          const routeResult = await this.executionRouter.route({
            ctx,
            runId,
            tenantId,
            bus,
            tracer,
          });
          if (routeResult.status === 'cancelled') {
            return {
              runId,
              agentId: ctx.agentId,
              missionId: ctx.missionId,
              status: 'cancelled',
              summary: routeResult.summary,
              steps: [],
              totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              totalDurationMs: 0,
              error: routeResult.summary,
            };
          }
          let routing = routeResult.routing;
          let currentEscalationChain = routeResult.escalationChain;
          const batchRouting = routeResult.batchRouting;
          const costEstimate = routeResult.costEstimate;

          // 2. Build LLM request with cache-optimized prompt structure
          //    Stable content (system, tools) FIRST for maximum cache hits.
          //    Variable content (user message) LAST.
          //    (Extracted into LLMRequestBuilder — see llmRequestBuilder.ts)
          const { request, projectContext } = this.llmRequestBuilder.build({
            ctx,
            routing,
            batchRouting,
            taskType,
            tenantId,
          });

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

          state.activeProjectContext = projectContext;
          await this.checkpointingPhase.checkpointStart(ctx, state, {
            request,
            projectContext,
          });

          // Dynamic context injection (inbox, memory, skills, skill recall)
          const injected = await this.contextInjector.inject({
            ctx,
            tokenBudget: ctx.tokenBudget,
          });
          if (injected.partCount > 0) {
            request.messages.splice(request.messages.length - 1, 0, {
              role: 'system' as const,
              content: injected.content,
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

            // PASTE speculative execution: pre-execute predicted read-only tools
            // during LLM thinking time. Fire-and-forget — results land in
            // ToolResultCache and are consumed transparently on cache hit.
            try {
              this.toolExecutionService.triggerSpeculativeExecution(tenantId).catch(() => {});
            } catch (err) {
              reportSilentFailure(err, 'agentRuntime:speculativeTrigger');
            }

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

              // Hallucination detection: analyze the LLM response and feed the
              // result into AdaptiveHITL via onBeforeToolCall signals.
              try {
                const userInput = request.messages
                  .filter((m) => m.role === 'user')
                  .map((m) => m.content)
                  .join('\n')
                  .slice(0, 4000);
                const report = getHallucinationDetector().analyze(
                  userInput,
                  response.content?.slice(0, 4000) ?? '',
                );
                this.lastHallucinationDetected =
                  report.recommendation === 'reject' || report.recommendation === 'flag_for_review';
              } catch (err) {
                reportSilentFailure(err, 'agentRuntime:hallucination-detection');
                this.lastHallucinationDetected = false;
              }

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
                // Security (OWASP ASI10): Run hallucination detector on LLM output
                // and pass result to security orchestrator for HITL signal enrichment.
                try {
                  const hallucinationReport = getHallucinationDetector().analyze(
                    ctx.goal ?? '',
                    response.content ?? '',
                  );
                  if (hallucinationReport.recommendation !== 'pass') {
                    getGlobalLogger().warn('AgentRuntime', 'Hallucination detected', {
                      agentId: ctx.agentId,
                      riskScore: hallucinationReport.riskScore,
                      recommendation: hallucinationReport.recommendation,
                      signals: hallucinationReport.signals.length,
                    });
                    // Enrich the LLM event with hallucination signal
                    llmEvent.metadata.hallucinationDetected = true;
                    llmEvent.metadata.hallucinationRiskScore = hallucinationReport.riskScore;
                    llmEvent.severity = 'medium' as const;
                  }
                } catch {
                  /* best-effort hallucination detection */
                }
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

              // TokenSentinel: fine-grained per-run token-budget tracking.
              // Unlike EnterpriseSecurityGateway's BillExplosionGuard (which
              // does a pre-LLM cost estimate and hard-blocks the call), the
              // TokenSentinel checks the *actual* accumulated token usage
              // against a hard cap and emits a warn log + a 'system.alert'
              // (token_usage_anomaly variant) MessageBus event when exceeded.
              // Advisory only — it does NOT throw or abort the run; the
              // BillExplosionGuard already owns the hard-block path (see
              // preLLMCheck further down).
              try {
                const hardCap =
                  this.config.budgetHardCapTokens ||
                  DEFAULT_TELOS_CONFIG.defaultBudget.hardCapTokens;
                const telosBudget: TELOSBudget = {
                  hardCapTokens: hardCap,
                  softCapTokens: Math.floor(hardCap * 0.75),
                  costCapUsd: DEFAULT_TELOS_CONFIG.defaultBudget.costCapUsd,
                };
                const budgetAlert = getTokenSentinel().checkBudget(
                  runId,
                  totalTokens.totalTokens,
                  telosBudget,
                );
                if (budgetAlert) {
                  getGlobalLogger().warn(
                    'AgentRuntime',
                    `TokenSentinel budget exceeded: ${budgetAlert.message}`,
                    {
                      runId,
                      agentId: ctx.agentId,
                      current: budgetAlert.current,
                      limit: budgetAlert.limit,
                      type: budgetAlert.type,
                    },
                  );
                  bus.publish('system.alert', ctx.agentId, {
                    type: 'token_usage_anomaly',
                    runId,
                    agentId: ctx.agentId,
                    alertType: budgetAlert.type,
                    current: budgetAlert.current,
                    limit: budgetAlert.limit,
                    message: budgetAlert.message,
                  });
                }
              } catch (err) {
                reportSilentFailure(err, 'agentRuntime:tokenSentinel:checkBudget');
              }

              // ── Degeneration guard (PRE-STEP) ──
              // Detect and sanitize model degeneration BEFORE the step is created.
              // This prevents degenerate content (e.g., "TheTheTheThe…") from
              // entering step history, where it would contaminate the final
              // summary when the terminal handler pulls from steps.
              let degenerationDetected = false;
              if (response.content) {
                const stagnation = this.cycleDetector.checkOutput(response.content);
                if (stagnation.detected && stagnation.type === 'semantic_stagnation') {
                  bus.publish('system.alert', 'runtime', {
                    ...stagnation,
                    runId,
                    agentId: ctx.agentId,
                    stepNumber: steps.length + 1,
                  });
                  getGlobalLogger().warn('AgentRuntime', 'Semantic stagnation detected', {
                    stepNumber: steps.length + 1,
                    similarity: stagnation.similarity,
                    description: stagnation.description,
                  });
                  getMetricsCollector().incrementCounter(
                    'degeneration_breaks_total',
                    'Retry loops broken due to model output degeneration',
                    1,
                    [{ name: 'type', value: 'repetition' }],
                  );

                  // Sanitize: truncate to the first non-degenerate sentence.
                  const sentences = response.content.split(/(?<=[.!?])\s+/);
                  const cleanSentences: string[] = [];
                  for (const s of sentences) {
                    if (!CycleDetector.detectRepetition(s).detected) {
                      cleanSentences.push(s);
                    } else {
                      break;
                    }
                  }
                  const cleanContent = cleanSentences.join(' ').trim();
                  response.content =
                    (cleanContent.length > 20 ? cleanContent.slice(0, 2000) : '') +
                    '[Output truncated: model degeneration detected — ' +
                    stagnation.description +
                    ']';
                  response.toolCalls = [];
                  degenerationDetected = true;
                }
              }

              // Record step (content is already sanitized if degeneration was detected)
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

              // ── Tool execution phase (extracted to ToolExecutionHandler) ──
              // Owns onStepStart → tool dispatch → result redaction → onStepComplete
              // → follow-up LLM call. Returns control signals for the post-loop
              // interrupt check, goal-completion verification, and early-exit path.
              const {
                response: toolExecResponse,
                earlyExit,
                interruptData,
                largestFileWriteContent: toolExecLargestFileWriteContent,
              } = await this.toolExecutionHandler.executeStep({
                ctx,
                runId,
                response,
                request,
                steps,
                totalTokens,
                bus,
                tenantId,
                routing,
                step,
                stepNumber,
                degenerationDetected,
                largestFileWriteContent,
              });
              response = toolExecResponse;
              largestFileWriteContent = toolExecLargestFileWriteContent;

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
                state.totalTokenUsage = totalTokens;
                state.steps = steps;
                await this.checkpointingPhase.checkpointTerminal(ctx, state, 'interrupted', {
                  request,
                  attempt,
                  stepNumber: steps.length,
                  exitSummary: result.summary,
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
              // Verifies whether the agent's accumulated work has satisfied the
              // original goal before a stop signal is accepted. A failed
              // verification (within the attempt budget) injects feedback into
              // the next iteration's context and forces another retry.
              const verification = await this.goalCompletionVerifier.verify({
                ctx,
                runId,
                routing,
                steps,
                request,
                response,
                tenantId,
                attempt,
              });
              if (!verification.isComplete && verification.feedback) {
                // ── Context-growth guard ──
                // Each failed verification adds messages to request.messages and
                // forces another retry. Under long-context stress, small models
                // degenerate rapidly. Estimate the current context size and break
                // if it exceeds a safe threshold (~80% of a typical 128k window).
                const estimatedContextTokens = request.messages.reduce(
                  (sum, m) => sum + Math.ceil(String(m.content ?? '').length / 4),
                  0,
                );
                const contextTokenLimit = 102400; // 80% of typical 128k context window
                if (estimatedContextTokens > contextTokenLimit) {
                  getGlobalLogger().warn('AgentRuntime', 'Context-growth guard: breaking retry loop', {
                    estimatedContextTokens,
                    contextTokenLimit,
                    attempt,
                    maxRetries: this.config.maxRetries,
                  });
                  getMetricsCollector().incrementCounter(
                    'context_growth_breaks_total',
                    'Retry loops broken due to context window exhaustion',
                    1,
                    [{ name: 'reason', value: 'context_limit' }],
                  );
                  break;
                }
                lastError = verification.feedback;
                continue;
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

                state.totalTokenUsage = totalTokens;
                state.steps = steps;
                await this.checkpointingPhase.checkpointTerminal(ctx, state, 'completed_early_exit', {
                  request,
                  attempt,
                  stepNumber: steps.length,
                  exitSummary: result.summary,
                });

                if (this.memory) {
                  try {
                    const _memContent = `[EARLY_EXIT] ${ctx.goal.slice(0, GOAL_TELEMETRY_MAX_CHARS)}`;
                    // Security (OWASP ASI07): Memory poisoning detection gate.
                    const _poisoningCheck = checkMemoryPoisoning(_memContent, `agent:${ctx.agentId}`, ctx.agentId);
                    if (!_poisoningCheck.allowed) {
                      getGlobalLogger().warn('AgentRuntime', 'Memory write blocked by poisoning gate', { reason: _poisoningCheck.reason });
                    } else {
                    // Security (G4): Advanced defense engine — entropy, Unicode, Base64, rate limit, taint tracking
                    let _defenseBlocked = false;
                    try {
                      const _defenseResult = getMemoryPoisoningDefenseEngine().validateMemoryWrite({
                        content: _memContent,
                        source: `agent:${ctx.agentId}`,
                        agentId: ctx.agentId,
                        memoryType: 'episodic',
                        sourceCredibility: 'agent_generated',
                        sessionId: runId,
                        metadata: { phase: 'early_exit' },
                      });
                      if (!_defenseResult.allowed) {
                        _defenseBlocked = true;
                        getGlobalLogger().warn('AgentRuntime', 'Memory write blocked by defense engine', {
                          reason: _defenseResult.reason,
                          riskScore: _defenseResult.riskScore,
                          severity: _defenseResult.severity,
                        });
                      }
                    } catch (err) {
                      reportSilentFailure(err, 'agentRuntime:defenseEngine:early_exit');
                    }
                    if (!_defenseBlocked) {
                    this.memory.add(
                      _memContent,
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
                    } // end defense engine check
                    } // end poisoning gate else
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

              state.totalTokenUsage = totalTokens;
              state.steps = steps;
              await this.checkpointingPhase.checkpointAfterStep(ctx, state, 'tool_execution', {
                request,
                attempt,
                stepNumber: steps.length,
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

              state.totalTokenUsage = totalTokens;
              state.steps = steps;
              state.lastError = lastError;
              await this.checkpointingPhase.checkpointAfterStep(ctx, state, 'verification', {
                request,
                attempt,
                stepNumber: steps.length,
                lastError,
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
                  // Phase 2 Hub Glue / SemanticCircuitCorrelator: stamp the
                  // current runId so the semantic_circuit_trip callback can
                  // correlate with the corresponding `tool.blocked circuit_broken`
                  // via the runId-strengthened 1-tuple key. toolName is intentionally
                  // OMITTED — see pairCorrelator.ts requireToolNameOnAlert:false.
                  { runId },
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
              // Safety net: skip steps with degenerate content.
              if (!safeContent || safeContent.length === 0) {
                for (let si = steps.length - 1; si >= 0; si--) {
                  const s = steps[si];
                  if (s.type === 'response' && s.content && !s.content.includes('<tool_call>')) {
                    // Skip degenerate content in step history
                    if (CycleDetector.detectRepetition(s.content).detected) {
                      continue;
                    }
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
              // Safety net: skip steps with degenerate content.
              if (!safeContent || safeContent.length === 0) {
                for (let si = steps.length - 1; si >= 0; si--) {
                  const s = steps[si];
                  if (s.content && s.content.length > 0) {
                    if (CycleDetector.detectRepetition(s.content).detected) {
                      continue;
                    }
                    safeContent = s.content.slice(0, 2000);
                    break;
                  }
                }
              }

              // Absolute last resort: reflect the goal
              if (!safeContent || safeContent.length === 0) {
                safeContent = `[No text response generated by agent] Goal: ${ctx.goal.slice(0, GOAL_TELEMETRY_MAX_CHARS)}`;
              }

              // Final degeneration guard: if safeContent still contains degenerate
              // content (from any source), sanitize it before building the result.
              if (safeContent && CycleDetector.detectRepetition(safeContent).detected) {
                const rep = CycleDetector.detectRepetition(safeContent);
                if (rep.detected) {
                  getGlobalLogger().warn('AgentRuntime', 'Terminal degeneration guard: sanitizing safeContent', {
                    description: rep.description,
                  });
                  safeContent =
                    '[Output truncated: model degeneration detected — ' +
                    rep.description +
                    ']';
                }
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

              state.totalTokenUsage = totalTokens;
              state.steps = steps;
              await this.checkpointingPhase.checkpointTerminal(ctx, state, 'completed', {
                request,
                attempt,
                stepNumber: steps.length,
                exitSummary: result.summary,
              });

              if (this.memory) {
                try {
                  const _memContent2 = `[SUCCESS] ${ctx.goal.slice(0, GOAL_TELEMETRY_MAX_CHARS)}`;
                  // Security (OWASP ASI07): Memory poisoning detection gate.
                  const _poisoningCheck2 = checkMemoryPoisoning(_memContent2, `agent:${ctx.agentId}`, ctx.agentId);
                  if (!_poisoningCheck2.allowed) {
                    getGlobalLogger().warn('AgentRuntime', 'Memory write blocked by poisoning gate', { reason: _poisoningCheck2.reason });
                  } else {
                  // Security (G4): Advanced defense engine — entropy, Unicode, Base64, rate limit, taint tracking
                  let _defenseBlocked2 = false;
                  try {
                    const _defenseResult2 = getMemoryPoisoningDefenseEngine().validateMemoryWrite({
                      content: _memContent2,
                      source: `agent:${ctx.agentId}`,
                      agentId: ctx.agentId,
                      memoryType: 'episodic',
                      sourceCredibility: 'agent_generated',
                      sessionId: runId,
                      metadata: { phase: 'success' },
                    });
                    if (!_defenseResult2.allowed) {
                      _defenseBlocked2 = true;
                      getGlobalLogger().warn('AgentRuntime', 'Memory write blocked by defense engine', {
                        reason: _defenseResult2.reason,
                        riskScore: _defenseResult2.riskScore,
                        severity: _defenseResult2.severity,
                      });
                    }
                  } catch (err) {
                    reportSilentFailure(err, 'agentRuntime:defenseEngine:success');
                  }
                  if (!_defenseBlocked2) {
                  this.memory.add(
                    _memContent2,
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
                  } // end defense engine check
                  } // end poisoning gate else
                } catch (e) {
                  getGlobalLogger().warn('AgentRuntime', 'Failed to record success memory', {
                    error: (e as Error)?.message,
                  });
                }
              }

              // Record success telemetry (plugin hooks, run-complete metrics,
              // agent.completed bus event, circuit-breaker success, agent
              // intelligence, meta-learner experience, scheduler commitRun) -
              // extracted to RunTelemetryRecorder.recordSuccess().
              this.runTelemetryRecorder.recordSuccess({
                ctx,
                runId,
                routing,
                taskType,
                result,
                totalTokens,
                steps,
                startTime,
                tenantId,
                costEstimate,
              });
              circuitReleased = true;
              return result;
            }

            // Handle failure with error classification
            // Use the preserved provider error for accurate classification,
            // falling back to lastError or a generic message.
            const errorToClassify = this.lastProviderError ?? new Error(lastError || 'Unknown error');
            const ce = classifyLLMError(errorToClassify);
            lastError = ce.message;
            lastErrorIsPermanent = !ce.retryable;
            // Reset for the next attempt
            this.lastProviderError = null;
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

          // Record failure telemetry (trace error, actual cost, model
          // performance, onError hooks, terminal checkpoint, failure memory
          // with poisoning gate, run-complete metrics, agent.failed bus event,
          // agent intelligence, meta-learner experience, failure-pattern
          // learner) - extracted to RunTelemetryRecorder.recordFailure(),
          // which returns the failed AgentExecutionResult.
          return await this.runTelemetryRecorder.recordFailure({
            ctx,
            runId,
            routing,
            taskType,
            lastError,
            lastErrorIsPermanent,
            totalTokens,
            steps,
            startTime,
            tenantId,
            costEstimate,
            state,
            request,
          });
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
      // Cleanup is delegated to FinallyCleanupHandler (circuit breaker release,
      // run lifecycle, tenant/lane/concurrency slot release, tracer completion,
      // SLO check, OTel export, SOP auto-export, store flush, tenant restore).
      await this.finallyCleanupHandler.cleanup({
        runId,
        ctx,
        circuitReleased,
        tenantCfg,
        tenantId,
        currentLane,
        startTime,
        execResult,
        tenantOverrides,
      });
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
   *  ProviderFallbackChain treats non-throwing returns as success, so we throw on null.
   *  Preserves the original provider error so the retry loop can classify it (429 vs 400 etc). */
  private async callProviderOrThrow(
    provider: LLMProvider,
    providerName: string,
    request: LLMRequest,
    attemptNumber: number,
    taskId?: string,
  ): Promise<import('./types').LLMResponse> {
    const result = await this.callProvider(provider, providerName, request, attemptNumber, taskId);
    if (!result) {
      // The original error is preserved in this.lastProviderError by callProvider.
      // Throw it directly so ProviderFallbackChain and the retry loop can classify
      // it properly (e.g., 429 = retryable, 400 = permanent).
      // Do NOT clear this.lastProviderError here — the retry loop reads it later.
      if (this.lastProviderError) {
        throw this.lastProviderError;
      }
      throw new Error(`Provider "${providerName}" returned null (likely timeout or unavailable)`);
    }
    // Clear on success — no error to preserve
    this.lastProviderError = null;
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

      // EnterpriseSecurityGateway: pre-LLM cost + input-scan gate.
      const estimatedTokens = this.estimateRequestTokens(request);
      const gateway = getEnterpriseSecurityGateway();
      const preCheck = gateway.preLLMCheck({
        tenantId: tenantIdForFlight,
        sessionId: taskId,
        model: request.model,
        estimatedTokens,
        source: taskId ?? 'unknown',
        input: request.messages.map((m) => m.content).join('\n').slice(0, 10000),
      });
      if (!preCheck.allowed) {
        throw new Error(`Security gateway blocked LLM call: ${preCheck.reason ?? 'policy'}`);
      }

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

      // EnterpriseSecurityGateway: post-LLM cost accounting + DLP scan.
      const postCheck = gateway.postLLMCheck({
        tenantId: tenantIdForFlight,
        sessionId: taskId,
        model: request.model,
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
        agentId: taskId,
        output: result.content,
      });
      if (!postCheck.allowed) {
        throw new Error(`Security gateway blocked LLM output: ${postCheck.reason ?? 'DLP policy'}`);
      }

      this.samplesStore.recordLLMCall(request, result, {
        provider: providerName,
        durationMs: Date.now() - startMs,
        attemptNumber,
        taskId,
      });
      return result;
    } catch (err) {
      this.lastProviderError = err instanceof Error ? err : new Error(String(err));
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
    // Security (RASP): Check if agent is suspended or quarantined before executing any tool.
    // This closes the detection→response loop — alerts from security detectors
    // suspend agents, and this check prevents further tool execution.
    if (isAgentQuarantined(agentId)) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: '',
        error: 'BLOCKED: Agent is quarantined due to critical security event. Manual review required.',
        durationMs: 0,
      };
    }
    if (isAgentSuspended(agentId)) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: '',
        error: 'BLOCKED: Agent is temporarily suspended due to a security alert. Retry later.',
        durationMs: 0,
      };
    }

    // Security (G9): Verify security invariants before tool execution.
    // Checks all registered invariants (AUTH, AUTHZ, SANDBOX, FLOW, AUDIT, etc.)
    // and blocks execution if any invariant is violated.
    try {
      const invariantResult = assertInvariants(
        {
          agentId,
          runId,
          toolName: toolCall.name,
          toolArgs: toolCall.arguments,
          capabilityTokenPresent: !!agentCtx,
          agentSuspended: isAgentSuspended(agentId),
          agentQuarantined: isAgentQuarantined(agentId),
        },
        'executeTool',
      );
      if (!invariantResult.passed) {
        const violated = invariantResult.violations.map((v) => v.invariant.id).join(', ');
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: '',
          error: `BLOCKED: Security invariant violated (${violated}). Tool execution denied.`,
          durationMs: 0,
        };
      }
    } catch {
      // best-effort — if invariant verifier fails, proceed (don't block on verifier errors)
    }

    const gateway = getEnterpriseSecurityGateway();
    const preCheck = gateway.preToolCheck({
      tenantId,
      sessionId: runId,
      toolName: toolCall.name,
      source: agentId,
      input: JSON.stringify(toolCall.arguments).slice(0, 10000),
    });
    if (!preCheck.allowed) {
      const errorMsg = `SECURITY_GATEWAY_BLOCKED: ${preCheck.reason ?? 'tool policy'}`;
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: errorMsg,
        error: errorMsg,
        durationMs: 0,
      };
    }

    const result = await this.toolExecutionService.execute(
      runId,
      toolCall,
      agentId,
      tenantId,
      allowedTools,
      agentCtx,
      this.executedMutations,
    );

    // EnterpriseSecurityGateway: post-tool DLP scan on tool output.
    const postCheck = gateway.postToolCheck({
      tenantId,
      sessionId: runId,
      toolName: toolCall.name,
      output: result.output,
      agentId,
    });
    if (!postCheck.allowed) {
      const errorMsg = `SECURITY_GATEWAY_BLOCKED_OUTPUT: ${postCheck.reason ?? 'DLP policy'}`;
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: errorMsg,
        error: errorMsg,
        durationMs: result.durationMs,
      };
    }
    if (postCheck.sanitizedOutput && postCheck.sanitizedOutput !== result.output) {
      result.output = postCheck.sanitizedOutput;
    }

    return result;
  }
  private generateActionId(): string {
    return `act_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /** Rough token estimator for the enterprise security gateway pre-LLM check. */
  private estimateRequestTokens(request: LLMRequest): number {
    const text = request.messages.map((m) => m.content).join('\n');
    // Approximate 4 chars per token; include tool definitions if present.
    const toolText = request.tools
      ? request.tools.map((t) => `${t.name}\n${t.description ?? ''}\n${JSON.stringify(t.inputSchema ?? {})}`).join('\n')
      : '';
    return Math.ceil((text.length + toolText.length) / 4);
  }

  /**
   * Normalize a tool_call payload from either the internal flat format or the
   * OpenAI-style `{ function: { name, arguments } }` format into the flat
   * `{ id, name, arguments }` shape the rest of the runtime expects.
   */
  private normalizeToolCall(
    tc: ToolCall & { function?: { name?: string; arguments?: string } },
  ): ToolCall {
    if (tc.name && tc.arguments !== undefined) {
      return tc;
    }
    const fn = tc.function;
    let args: Record<string, unknown> = {};
    if (fn?.arguments) {
      try {
        args = JSON.parse(fn.arguments);
      } catch {
        args = { raw: fn.arguments };
      }
    }
    return {
      id: tc.id ?? `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: fn?.name ?? tc.name ?? '',
      arguments: args,
    };
  }

  // ---------------------------------------------------------------------------
  // Auto-resume (GAP-03)
  // ---------------------------------------------------------------------------

  /**
   * List runs that crashed (have checkpoints but no terminal state).
   * Callers can use this to present a resume UI or auto-resume.
   */
  listUnfinishedRuns(): Array<{ runId: string; phase: string; timestamp: string }> {
    return this.checkpointingPhase.listUnfinishedRuns();
  }

  /** Tier 1.2: Resume a crashed run using the full RunRecovery pipeline.
   *  Validates the lease, reconstructs completedToolCallIds from checkpoint
   *  messages, and returns a result suitable for continuing from the last step.
   *  Returns null if the checkpoint is not found or the lease was lost.
   */
  async resume(runId: string, tenantId?: string): Promise<RunRecoveryResult | null> {
    const result = await this.checkpointingPhase.resume(runId, tenantId);
    if (result && result.status === 'recovered') {
      getGlobalLogger().info('AgentRuntime', 'Run recovered', {
        runId,
        resumeFromStep: result.resumeFromStep,
        completedToolCalls: result.completedToolCallIds.size,
      });
    }
    return result;
  }

  /** List all runs that have recoverable checkpoints (non-terminal phases). */
  listResumableRuns(): Array<{ runId: string; phase: string; timestamp: string }> {
    return this.checkpointingPhase.listResumableRuns();
  }

  /**
   * Signal a running execution to pause at the next checkpoint boundary.
   * Returns true if the run was active and pause was signaled, false otherwise.
   */
  pauseRun(runId: string): boolean {
    return this.checkpointingPhase.pauseRun(runId);
  }

  /**
   * Clear the pause flag for a run (e.g., after resume).
   */
  unpauseRun(runId: string): void {
    this.checkpointingPhase.unpauseRun(runId);
  }

  isPaused(runId: string): boolean {
    return this.checkpointingPhase.isPaused(runId);
  }

  /**
   * List all active runs with their pause state.
   * Returns an array of { runId, paused, checkpointPhase }.
   */
  getActiveRuns(): Array<{ runId: string; paused: boolean; checkpointPhase?: string }> {
    return this.checkpointingPhase.getActiveRuns();
  }

  getActiveRunCount(): number {
    return this.checkpointingPhase.getActiveRunCount();
  }

  isRunActive(runId: string): boolean {
    return this.checkpointingPhase.isRunActive(runId);
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
