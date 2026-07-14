import type {
  AgentExecutionContext,
  AgentExecutionResult,
  AgentRuntimeConfig,
  LLMProvider,
  LLMRequest,
  ModelTier,
  RoutingDecision,
  Tool,
} from './types';
import type { ModelConfig } from './types/routing';
import type { CostEstimate } from './costEstimator';
import type { ProjectContext } from './projectContextLoader';
import type { TaskType } from './unifiedVerificationTypes';
import { detectTaskType } from './unifiedVerification';
import { ModelRouter } from './modelRouter';
import { ExecutionRouter } from './executionRouter';
import { LLMRequestBuilder } from './llmRequestBuilder';
import { ExecutionContextInjector } from './executionContextInjector';
import { CheckpointingPhase } from './phases/checkpointing';
import { SamplesStore } from './samplesStore';
import { TokenGovernor } from './tokenGovernor';
import { CircuitBreaker } from './circuitBreaker';
import { SlidingWindowOrchestrator } from './slidingWindowOrchestrator';
import { CacheManager } from './cacheManager';
import { provisionTools } from './toolProvisioner';
import { captureProvenance } from './provenance';
import { getMessageBus } from './messageBus';
import { getTraceRecorder } from './executionTrace';
import { getGlobalLogger } from '../logging';
import { getHookManager } from '../pluginManager';
import {
  createInitialAgentExecutionState,
  type AgentExecutionState,
} from './phases/AgentExecutionState';

export type EscalationChain = ModelConfig[];

export interface PreLoopSetupDeps {
  getConfig(): AgentRuntimeConfig;
  getRouter(): ModelRouter;
  getExecutionRouter(): ExecutionRouter;
  getLLMRequestBuilder(): LLMRequestBuilder;
  getContextInjector(): ExecutionContextInjector;
  getCheckpointingPhase(): CheckpointingPhase;
  getSamplesStore(): SamplesStore;
  getGovernor(): TokenGovernor;
  getCircuitBreaker(): CircuitBreaker;
  getProviders(): Map<string, LLMProvider>;
  getTools(): Map<string, Tool>;
  getCacheManager(): CacheManager;
  getSmartRouterActive(): boolean;
  setSmartRouterActive(enabled: boolean): void;
  setGovernor(governor: TokenGovernor): void;
  setSlidingWindow(sw: SlidingWindowOrchestrator): void;
  setVerificationPipelineEvaluator(provider: LLMProvider): void;
}

export interface PreLoopSetupResult {
  request: LLMRequest;
  routing: RoutingDecision;
  escalationChain: EscalationChain;
  batchRouting: RoutingDecision | undefined;
  costEstimate: CostEstimate;
  taskType: TaskType;
  projectContext: ProjectContext | undefined;
  state: AgentExecutionState;
}

export class PreLoopSetup {
  constructor(private deps: PreLoopSetupDeps) {}

  async prepare(
    ctx: AgentExecutionContext,
    init: { runId: string; tenantId: string | undefined },
  ): Promise<PreLoopSetupResult | AgentExecutionResult> {
    const { runId, tenantId } = init;
    const bus = getMessageBus();
    const tracer = getTraceRecorder();

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
      this.deps.setSmartRouterActive(true);
    } else if (cd?.cascadeEnabled === false) {
      this.deps.setSmartRouterActive(false);
    }
    // qualityThreshold is applied via orchestrator.setQualityGateThreshold()
    // before execute() — not here, because the orchestrator owns the gate
    // config and is constructed at the CLI layer.

    // Record run manifest (provenance, config, params)
    this.deps.getSamplesStore().recordRunManifest(runId, {
      ...captureProvenance(),
      agentId: ctx.agentId,
      missionId: ctx.missionId,
      goal: ctx.goal.slice(0, 500),
      tokenBudget: ctx.tokenBudget,
      availableTools: ctx.availableTools,
      modelId: this.deps
        .getRouter()
        .route(ctx, undefined, ctx.preferredModelTier, new Set(this.deps.getProviders().keys()))
        .modelId,
      config: { ...this.deps.getConfig() },
      timestamp: new Date().toISOString(),
    });

    // Per-run governor and sliding window are owned by ExecutionContext.enter()
    // in AgentRuntime.execute() — do not reassign shared instance fields here.
    const taskType = detectTaskType(ctx.goal);
    if (
      this.deps.getConfig().budgetHardCapTokens > 0 &&
      ctx.tokenBudget > this.deps.getConfig().budgetHardCapTokens
    ) {
      const msg = `BUDGET_EXCEEDED: requested ${ctx.tokenBudget} > hard cap ${this.deps.getConfig().budgetHardCapTokens}`;
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
    const routeResult = await this.deps.getExecutionRouter().route({
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
    const routing = routeResult.routing;
    const escalationChain = routeResult.escalationChain;
    const batchRouting = routeResult.batchRouting;
    const costEstimate = routeResult.costEstimate;

    // 2. Build LLM request with cache-optimized prompt structure
    //    Stable content (system, tools) FIRST for maximum cache hits.
    //    Variable content (user message) LAST.
    //    (Extracted into LLMRequestBuilder — see llmRequestBuilder.ts)
    const { request, projectContext } = this.deps.getLLMRequestBuilder().build({
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
        this.deps.getTools(),
        this.deps.getCacheManager().getToolCache(),
      );
      if (provisioned) {
        bus.publish('system.alert', 'runtime', { type: 'tool_provisioned' });
      }
    } catch (e) {
      getGlobalLogger().debug('AgentRuntime', 'Tool provisioning failed (best-effort)', {
        error: (e as Error)?.message,
      });
    }

    const state = createInitialAgentExecutionState(ctx);
    (state as { runId: string }).runId = runId;
    state.activeProjectContext = projectContext;
    await this.deps.getCheckpointingPhase().checkpointStart(ctx, state, {
      request,
      projectContext,
    });

    // Dynamic context injection (inbox, memory, skills, skill recall)
    const injected = await this.deps.getContextInjector().inject({
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
    const totalTokens = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
    };
    // Track content written by file_write tool calls for artifact propagation
    let largestFileWriteContent = '';
    // Consecutive degeneration counter: when the model degenerates 2+
    // times in a row, force earlyExit to prevent cascading context
    // pollution. The model's reasoning quality will not recover.
    let consecutiveDegenerationCount = 0;

    // Per-run sliding window is created in ExecutionContext.enter().

    // Resolve evaluator provider for verification pipeline (echo chamber breaker)
    const evaluatorProviderName = this.deps.getConfig().evaluatorProviderName;
    if (evaluatorProviderName) {
      const evalProvider = this.deps.getProviders().get(evaluatorProviderName);
      if (evalProvider) {
        this.deps.setVerificationPipelineEvaluator(evalProvider);
      }
    }

    // Check circuit breaker before first attempt
    if (!this.deps.getCircuitBreaker().isAvailable()) {
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

    // Cost enforcement is handled by EnterpriseSecurityGateway.preLLMCheck
    // (→ UnifiedCostAuthority) inside the LLM call path. The legacy
    // CostGuard.evaluateRequest() previously duplicated this check on
    // the hot path; it has been removed to eliminate double-checking.
    // CostGuard is now @deprecated — see security/costGuard.ts.

    // Suppress unused-variable warnings for loop-local declarations that are
    // initialized here to mirror the original inline body, but consumed by
    // the AgentLoopOrchestrator.
    void lastError;
    void lastErrorIsPermanent;
    void totalTokens;
    void largestFileWriteContent;
    void consecutiveDegenerationCount;

    return {
      request,
      routing,
      escalationChain,
      batchRouting,
      costEstimate,
      taskType,
      projectContext,
      state,
    };
  }
}
