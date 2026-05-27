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
} from './types';
import { ModelRouter, getModelRouter } from './modelRouter';
import { getMessageBus } from './messageBus';
import { getTraceRecorder } from './executionTrace';
import { PersistentTraceStore } from './traceStore';
import { ContextCompactor } from './contextCompactor';
import { classifyLLMError, computeBackoff } from './llmRetry';
import { CircuitBreaker } from './circuitBreaker';
import { createParameterControllerPlugin, applyControllerParams } from './parameterController';
import { UnifiedVerificationPipeline, type UVPTaskContext, detectTaskType } from './unifiedVerification';
import { provisionTools } from './toolProvisioner';
import { TokenGovernor, type OptimizationStrategy } from './tokenGovernor';
import { SamplesStore } from './samplesStore';
import { captureProvenance } from './provenance';
import { StateCheckpointer, type CheckpointState } from './stateCheckpointer';
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
import { ToolOutputManager } from './toolOutputManager';
import { ToolOrchestrator } from './toolOrchestrator';
import { ToolApproval } from './toolApproval';
import { selectTools, sortToolDefinitionsForCache } from './toolRetriever';
import { ToolPlanner } from './toolPlanner';
import { CycleDetector } from './cycleDetector';
import { repairToolCallArguments } from './toolCallRepair';
import { validateToolCall, formatValidationErrors } from './toolCallValidator';
import { ToolRegistry } from '../tools/toolRegistry';
import { parseStructuredOutput } from './structuredOutput';
import { isConfidentResponse } from './entropyGater';
import { createContentScanner, type ContentScanner } from '../contentScanner';
import type { TenantProvider, TenantConfig } from './tenantProvider';
import { getGlobalTenantProvider, getGlobalMemoryRegistry } from './tenantProvider';
import { getLaneManager } from '../sandbox/lane';
import { createMemoryStore } from '../memory';
import type { MemoryStore } from '../memory';
import { OpenTelemetryExporter, getOTelExporter, executionTraceToOtlpSpans } from './openTelemetryExporter';
import type { OTelSpan } from './openTelemetryExporter';
import { buildSystemPrompt, buildCacheAwareUserPrompt } from './promptBuilder';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getGlobalLogger } from '../logging';
import type { CompactTaskType } from './contextCompactor';
import { DEFAULT_CONFIG, generateId, now, delay, descendingToolOrder, applyObservationMask, isMutationTool } from './runtimeHelpers';

export class AgentRuntime {
  private config: AgentRuntimeConfig;
  private providers: Map<string, LLMProvider> = new Map();
  private tools: Map<string, Tool> = new Map();
  private router: ModelRouter;
  private activeRuns: Set<string> = new Set();
  private compactor: ContextCompactor;
  private circuitBreaker: CircuitBreaker;
  private verificationPipeline: UnifiedVerificationPipeline;
  private governor: TokenGovernor;
  private samplesStore: SamplesStore;
  private memory: import('../threeLayerMemory').ThreeLayerMemory | null = null;
  private traceStore: PersistentTraceStore;
  private checkpointer: StateCheckpointer;
  private dlq: DeadLetterQueue;
  private compensationRegistry: CompensationRegistry;
  private agentInbox: AgentInbox;
  private teamRegistry: TeamRegistry;
  private agentHandoff: AgentHandoff;
  private toolCache: ToolResultCache;
  private outputManager: ToolOutputManager;
  private memoryStore: MemoryStore | null = null;
  private otelExporter: OpenTelemetryExporter | null = null;
  private orchestrator: ToolOrchestrator;
  private planner: ToolPlanner;
  private cycleDetector: CycleDetector;
  private contentScanner: ContentScanner;
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
    this.tenantProvider = tenantProvider ?? getGlobalTenantProvider();
    this.compactor = new ContextCompactor({ maxContextTokens: this.config.budgetHardCapTokens || 128000 });
    this.circuitBreaker = new CircuitBreaker(5, 30000);
    this.governor = new TokenGovernor({ totalBudget: this.config.budgetHardCapTokens || 64000 });
    this.verificationPipeline = new UnifiedVerificationPipeline({
      enabled: true,
      budgetFloorTokens: 1500,
      llmVerificationBudget: 300,
    });
    this.samplesStore = new SamplesStore();
    this.traceStore = new PersistentTraceStore();
    this.checkpointer = new StateCheckpointer();
    this.dlq = new DeadLetterQueue();
    this.compensationRegistry = new CompensationRegistry();
    this.agentInbox = new AgentInbox();
    this.teamRegistry = new TeamRegistry();
    this.agentHandoff = new AgentHandoff(this.agentInbox, this.checkpointer);
    // Register default compensation handlers for mutation tools
    this.registerDefaultCompensation();
    try { this.memory = getGlobalThreeLayerMemory(); } catch (e) { getGlobalLogger().warn('AgentRuntime', 'Failed to initialize global memory', { error: (e as Error)?.message }); }
    try { getTraceRecorder(this.traceStore); } catch (e) { getGlobalLogger().warn('AgentRuntime', 'Failed to initialize trace recorder', { error: (e as Error)?.message }); }
    // Initialize memory store if configured
    if (this.config.memoryStoreType) {
      createMemoryStore(this.config.memoryStoreType).then(store => {
        this.memoryStore = store;
      }).catch(e => {
        getGlobalLogger().warn('AgentRuntime', 'Failed to initialize memory store', { type: this.config.memoryStoreType, error: (e as Error)?.message });
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
        exporter.start().catch(e => getGlobalLogger().warn('AgentRuntime', 'Failed to start OTel exporter', { error: (e as Error)?.message }));
        this.otelExporter = exporter;
      } catch (e) {
        getGlobalLogger().warn('AgentRuntime', 'Failed to initialize OTel exporter', { error: (e as Error)?.message });
      }
    }
    // Tool calling infrastructure
    this.toolCache = new ToolResultCache({ enabled: true, maxEntries: 512, defaultTtlMs: 1_800_000 });
    this.outputManager = new ToolOutputManager({ enabled: true, turnBudget: 32000 });
    // ToolApproval with auto-approve callback (semi_auto/manual policies still gate)
    const toolApproval = new ToolApproval(
      async (req) => ({ approved: true, requestId: req.id, approvedAt: new Date().toISOString(), reason: 'Auto-approved' }),
    );
    this.orchestrator = new ToolOrchestrator({ enabled: true, maxRetries: 1, circuitBreakerThreshold: 3, useApproval: true }, toolApproval);
    this.planner = new ToolPlanner();
    this.cycleDetector = new CycleDetector();
    this.contentScanner = createContentScanner();
    // Auto-register adaptive parameter controller
    getHookManager().register(createParameterControllerPlugin()).catch(e => getGlobalLogger().debug('AgentRuntime', 'Hook registration', { error: (e as Error)?.message }));
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

  registerProvider(name: string, provider: LLMProvider): void {
    this.providers.set(name, provider);
  }

  registerTool(name: string, tool: Tool): void {
    this.tools.set(name, tool);
  }

  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
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

  getInbox(): AgentInbox { return this.agentInbox; }
  getTeamRegistry(): TeamRegistry { return this.teamRegistry; }
  getHandoff(): AgentHandoff { return this.agentHandoff; }

  /**
   * Execute an agent task end-to-end.
   * Wraps entire body in try/finally to guarantee cleanup (GAP-02, GAP-05).
   * Enforces maxConcurrency via semaphore (GAP-07).
   */
  async execute(ctx: AgentExecutionContext): Promise<AgentExecutionResult> {
    // Concurrency semaphore: wait if at maxConcurrency
    await this.acquireSlot();

    const runId = generateId();
    const bus = getMessageBus();
    const tracer = getTraceRecorder();
    const startTime = Date.now();

    const tenantId = ctx.tenantId;
    const tenantCfg = tenantId ? this.tenantProvider.getTenantConfig(tenantId) : undefined;

    // GAP-09: Enforce per-tenant rate limit
    if (tenantCfg?.enabled && tenantCfg.maxRunsPerMinute > 0) {
      const rateEntry = this.tenantRateLimits.get(tenantId!);
      const now = Date.now();
      if (rateEntry && now < rateEntry.resetAt && rateEntry.count >= tenantCfg.maxRunsPerMinute) {
        this.releaseSlot();
        return {
          runId, agentId: ctx.agentId, missionId: ctx.missionId,
          status: 'failed', summary: 'Tenant rate limit exceeded',
          steps: [], totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          totalDurationMs: 0, error: 'TENANT_RATE_LIMIT: too many runs per minute',
        };
      }
      if (!rateEntry || now > rateEntry.resetAt) {
        this.tenantRateLimits.set(tenantId!, { count: 1, resetAt: now + 60_000 });
      } else {
        rateEntry.count++;
      }
    }

    // GAP-09: Enforce per-tenant concurrency limit
    if (tenantCfg?.enabled && tenantCfg.maxConcurrency > 0) {
      const current = this.tenantRunningCounts.get(tenantId!) ?? 0;
      if (current >= tenantCfg.maxConcurrency) {
        this.releaseSlot();
        return {
          runId, agentId: ctx.agentId, missionId: ctx.missionId,
          status: 'failed', summary: 'Tenant concurrency limit exceeded',
          steps: [], totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          totalDurationMs: 0, error: 'TENANT_CONCURRENCY_LIMIT: too many concurrent runs',
        };
      }
      this.tenantRunningCounts.set(tenantId!, current + 1);
    }

    // GAP-09: Resolve tenant-scoped storage and memory
    // Override class fields to tenant-scoped instances for this run's duration.
    // Safe because acquireSlot() limits concurrency to maxConcurrentRuns,
    // and tenant concurrency is enforced separately.
    const origSamplesStore = this.samplesStore;
    const origTraceStore = this.traceStore;
    const origCheckpointer = this.checkpointer;
    const origMemory = this.memory;
    if (tenantId && tenantCfg?.enabled) {
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
    }

    // Execution Lane: acquire a lane slot (concurrent execution isolation)
    let currentLane: string;
    try {
      currentLane = await getLaneManager().acquireSlot({
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        runId,
        args: ctx.lane ? { lane: ctx.lane } : undefined,
      });
    } catch {
      this.releaseSlot();
      return {
        runId, agentId: ctx.agentId, missionId: ctx.missionId,
        status: 'failed', summary: 'Failed to acquire lane slot',
        steps: [], totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        totalDurationMs: 0, error: 'LANE_ACQUISITION_FAILED',
      };
    }

    this.activeRuns.add(runId);
    tracer.startRun(runId, ctx.agentId, ctx.missionId);
    getMetricsCollector().setGauge('active_runs', 'Active concurrent runs', this.activeRuns.size);

    try {
      return await runWithTenant(ctx.tenantId, async () => {

    // Record run manifest (provenance, config, params)
    this.samplesStore.recordRunManifest(runId, {
      ...captureProvenance(),
      agentId: ctx.agentId,
      missionId: ctx.missionId,
      goal: ctx.goal.slice(0, 500),
      tokenBudget: ctx.tokenBudget,
      availableTools: ctx.availableTools,
      modelId: this.router.route(ctx).modelId,
      config: { ...this.config },
      timestamp: new Date().toISOString(),
    });

    // Per-run governor to prevent concurrent run corruption (was shared instance)
    this.governor = new TokenGovernor({ totalBudget: ctx.tokenBudget || this.config.budgetHardCapTokens || 64000 });
    // Detect task type for strategy selection
    const taskType = detectTaskType(ctx.goal);
    this.governor.setTaskCategory(taskType === 'code' ? 'code' : taskType === 'search' ? 'search' : taskType === 'analysis' ? 'analysis' : taskType === 'structured' ? 'structured' : 'general');

    // 0. Pre-execution budget check (hard enforcement, not advisory)
    if (this.config.budgetHardCapTokens > 0 && ctx.tokenBudget > this.config.budgetHardCapTokens) {
      const msg = `BUDGET_EXCEEDED: requested ${ctx.tokenBudget} > hard cap ${this.config.budgetHardCapTokens}`;
      tracer.recordDecision(runId, msg, 0);
      bus.publish('agent.failed', ctx.agentId, { runId, error: msg });
      return {
        runId, agentId: ctx.agentId, missionId: ctx.missionId,
        status: 'cancelled', summary: msg, steps: [],
        totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        totalDurationMs: 0, error: msg,
      };
    }

    // 1. Route to optimal model (pass per-run governor phase, not global singleton)
    const routing: RoutingDecision = this.router.route(ctx, this.governor.getState().phase);
    tracer.recordDecision(runId, `routed to ${routing.modelId} (${routing.tier})`, 0);

    // 2. Build LLM request with cache-optimized prompt structure
    //    Stable content (system, tools) FIRST for maximum cache hits.
    //    Variable content (user message) LAST.
    const systemPrompt = buildSystemPrompt(ctx, routing, this.config, this.tools, this.governor);
    // Score and reorder tools by goal relevance for better LLM focus
    // Most relevant tools first, then the rest sorted by relevance score
    if (ctx.availableTools.length > 3) {
      const relevantTools = selectTools(ctx.goal, ctx.availableTools);
      if (relevantTools.length > 0) {
        const seen = new Set(relevantTools);
        ctx.availableTools = [
          ...relevantTools,
          ...ctx.availableTools.filter(t => !seen.has(t)),
        ];
      }
    }

    let toolDefs = ctx.availableTools
      .map(name => this.tools.get(name)?.definition)
      .filter((t): t is ToolDefinition => t !== undefined);

    // Stable category-based sort for maximum prompt cache hit rates.
    // Cache-friendly ordering ensures the tool definition prefix is identical across LLM calls.
    toolDefs = sortToolDefinitionsForCache(toolDefs);

    // Dynamic tool retrieval: filter to relevant tools when enabled
    const retrieval = this.config.toolRetrieval;
    if (retrieval?.enabled && toolDefs.length > retrieval.maxTools) {
      const selectedNames = selectTools(ctx.goal, ctx.availableTools, {
        minTools: retrieval.minTools,
        maxTools: retrieval.maxTools,
        alwaysInclude: retrieval.alwaysInclude,
      });
      const selected = new Set(selectedNames);
      toolDefs = toolDefs.filter(t => selected.has(t.name));
    }

    // Cache configuration: enable caching for system prompt + tools on providers that support it
    const cacheConfig: CacheConfig = {
      cacheSystemPrompt: true,
      cacheTools: toolDefs.length > 0,
      useCacheControl: true,
    };

    // Strip internal @tier suffix (eco/standard/power/consensus) before sending to provider
    const apiModel = (routing.modelId || '').replace(/@\w+$/, '') || routing.modelId;
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
          content: buildCacheAwareUserPrompt(ctx, routing, this.governor),
        },
      ],
      maxTokens: routing.maxTokens,
      tools: toolDefs,
      cacheConfig,
    };

    // Apply parameter controller (eval profile, reasoning config, adaptive params)
    const request = applyControllerParams(baseRequest, ctx.goal, baseRequest.messages, 0);

    // Pre-LLM tool provisioning: detect tool needs and inject results before LLM sees the question
    try {
      const provisioned = await provisionTools(ctx.goal, request, this.tools, this.toolCache);
      if (provisioned) {
        bus.publish('system.alert', 'runtime', { type: 'tool_provisioned' });
      }
    } catch (e) { getGlobalLogger().debug('AgentRuntime', 'Tool provisioning failed (best-effort)', { error: (e as Error)?.message }); }

    this.checkpointer.checkpoint({
      runId, agentId: ctx.agentId, missionId: ctx.missionId,
      timestamp: now(), phase: 'started',
      stepNumber: 0, attemptNumber: 0,
      messages: request.messages,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stepDurations: [],
      context: {
        agentId: ctx.agentId, missionId: ctx.missionId,
        projectId: ctx.projectId, goal: ctx.goal,
        availableTools: ctx.availableTools,
        maxSteps: ctx.maxSteps, tokenBudget: ctx.tokenBudget,
      },
      totalDurationMs: 0,
    });

    // Check agent inbox for pending messages before execution
    const inboxMessages = this.agentInbox.pollInbox(ctx.agentId);
    if (inboxMessages.length > 0) {
      const inboxBlock = inboxMessages.map(m =>
        `[from:${m.from}] ${m.subject}: ${m.body.slice(0, 300)}`
      ).join('\n');
      request.messages.splice(request.messages.length - 1, 0, {
        role: 'system' as const,
        content: `## Pending Messages\n${inboxBlock}\n\nAddress these messages as part of your execution.`,
      });
      // Send read receipts
      for (const msg of inboxMessages) {
        this.agentInbox.acknowledge(ctx.agentId, msg.id);
      }
    }

    if (this.memory) {
      try {
        const keywords = ctx.goal.split(/\s+/).filter(w => w.length > 4).slice(0, 8);
        if (keywords.length > 0) {
          const memories = this.memory.query({ keywords, limit: 5, importanceThreshold: 0.3 });
          if (memories.length > 0) {
            const memoryBlock = memories.map(m =>
              `[${m.layer}] ${m.content.slice(0, 300)} (importance:${m.importance.toFixed(2)}, tags:${m.tags.join(',')})`
            ).join('\n');
            request.messages.splice(request.messages.length - 1, 0, {
              role: 'system' as const,
              content: `## Relevant Past Experiences\n${memoryBlock}\n\nLearn from these past experiences when working on the current task.`,
            });
          }
        }
      } catch (e) { getGlobalLogger().debug('AgentRuntime', 'Memory initialization failed', { error: (e as Error)?.message }); }
    }

    // Inject skills catalog (Level 0) into context
    try {
      const { SkillInjector, getSkillSystem } = await import('../skills');
      const injector = new SkillInjector(getSkillSystem().manager);
      const skillsBlock = await injector.buildSkillsBlock(ctx.goal, 0);
      const instructions = injector.buildSkillUsageInstructions();
      if (skillsBlock) {
        request.messages.splice(request.messages.length - 1, 0, {
          role: 'system' as const,
          content: `${skillsBlock}\n\n${instructions}`,
        });
      }
    } catch (e) { getGlobalLogger().debug('AgentRuntime', 'Skills injection failed', { error: (e as Error)?.message }); }

    // 3. Emit started event
    bus.publish('agent.started', ctx.agentId, {
      runId,
      missionId: ctx.missionId,
      model: routing.modelId,
      goal: ctx.goal,
    });

    // Fire plugin onAgentStart hooks
    getHookManager().fireOnAgentStart({ ctx, runId }).catch(e => getGlobalLogger().debug('AgentRuntime', 'onAgentStart hook failed', { error: (e as Error)?.message }));

    // 4. Execute with retry and circuit breaker
    let lastError: string | undefined;
    let lastErrorIsPermanent = false;
    const steps: AgentExecutionStep[] = [];
    let totalTokens: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    // Check circuit breaker before first attempt
    if (!this.circuitBreaker.isAvailable()) {
      const msg = 'CIRCUIT_OPEN: Too many recent failures. Cooling down.';
      tracer.recordDecision(runId, msg, 0);
      bus.publish('agent.failed', ctx.agentId, { runId, error: msg });
      return { runId, agentId: ctx.agentId, missionId: ctx.missionId, status: 'cancelled', summary: msg, steps: [], totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, totalDurationMs: 0, error: msg };
    }

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const llmCtx = { request, agentId: ctx.agentId, runId };
      let llmRequest = await getHookManager().fireBeforeLLMCall(llmCtx);
      let response = await this.callWithTimeout(llmRequest, routing);
      await getHookManager().fireAfterLLMCall({ request: llmRequest, response, agentId: ctx.agentId, runId });
      const stepDuration = Date.now() - startTime;

      if (response) {
        // Accumulate token usage
        totalTokens.promptTokens += response.usage.promptTokens;
        totalTokens.completionTokens += response.usage.completionTokens;
        totalTokens.totalTokens += response.usage.totalTokens;
        this.governor.reportUsage(response.usage.totalTokens);

        // Record LLM call in trace
        const traceEventId = tracer.recordLLMCall(
          runId,
          routing.modelId,
          routing.provider,
          routing.tier,
          request,
          response,
          response.usage,
          stepDuration,
        );
        getMetricsCollector().recordLLMCall(
          routing.modelId, routing.provider,
          response.usage.totalTokens, stepDuration,
          undefined, tenantId,
        );

        // Record step
        const stepNumber = steps.length + 1;
        const step: AgentExecutionStep = {
          stepNumber,
          timestamp: now(),
          type: 'response',
          content: response.content,
          tokenUsage: response.usage,
          durationMs: stepDuration,
        };

        // ── Hook: onStepStart ──
        getHookManager().fireOnStepStart({
          runId, agentId: ctx.agentId, stepNumber, type: 'response', content: response.content,
        }).catch(e => getGlobalLogger().debug('AgentRuntime', 'onStepStart hook failed', { error: (e as Error)?.message }));

        steps.push(step);

        // Entropy gating: if model is confident with no tool calls, log for observability
        if (!response.toolCalls || response.toolCalls.length === 0) {
          if (isConfidentResponse(response)) {
            bus.publish('system.alert', 'runtime', { type: 'entropy_gate', reason: 'confident_no_tool_calls' });
          }
          // Attempt structured output extraction for potential JSON answers
          const structured = parseStructuredOutput(response.content);
          if (structured) {
            step.content = typeof structured === 'string' ? structured : JSON.stringify(structured);
          }
        }

        // Process tool calls in a loop — with caching, planning, cycle detection, and output management
        const maxIterations = Math.max(ctx.maxSteps || 10, 20);
        let toolLoopCount = 0;
        this.cycleDetector.reset();
        let cycleDetected = false;
        while (response.toolCalls && response.toolCalls.length > 0 && toolLoopCount < maxIterations && !cycleDetected) {
          toolLoopCount++;

          // Reset output manager turn budget
          this.outputManager.resetTurn();

          // Check cache for all tool calls first (zero-cost on hit)
          const calls = response.toolCalls;
          const uncachedCalls: typeof calls = [];
          const cachedResults: Array<{ toolCallId: string; name: string; output: string; error?: string; durationMs: number }> = [];

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
          const rawResults: Array<{ toolCallId: string; name: string; output: string; error?: string; durationMs: number }> = [];

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
                bus.publish('tool.blocked', ctx.agentId, { runId, toolName: s.toolCall.name, reason: 'orchestrator_skipped', detail: s.reason });
                rawResults.push({ toolCallId: s.toolCall.id, name: s.toolCall.name, output: '', error: s.reason, durationMs: 0 });
              }
              for (const cb of planResult.circuitBroken) {
                bus.publish('tool.blocked', ctx.agentId, { runId, toolName: cb.toolCall.name, reason: 'circuit_broken', detail: cb.toolName });
                rawResults.push({ toolCallId: cb.toolCall.id, name: cb.toolCall.name, output: '', error: `CIRCUIT_OPEN: ${cb.toolName}`, durationMs: 0 });
              }

              // Partition approved calls: concurrent-safe first, then serial
              const concurrencyMap = approvedCalls.map(tc => {
                const tool = this.tools.get(tc.name);
                return { tc, isSafe: tool?.isConcurrencySafe === true };
              });
              const safeCalls = concurrencyMap.filter(c => c.isSafe).map(c => c.tc);
              const serialCalls = concurrencyMap.filter(c => !c.isSafe).map(c => c.tc);

              // Run concurrent-safe tools in parallel with sibling abort
              if (safeCalls.length > 0) {
                const siblingAbort = new AbortController();
                const concurrentResults = await Promise.allSettled(
                  safeCalls.map(async (tc) => {
                    // Check HookManager beforeToolCall
                    const hookCtx = { toolName: tc.name, args: tc.arguments, agentId: ctx.agentId, runId };
                    const hookResult = await getHookManager().fireBeforeToolCall(hookCtx);
                    if (hookResult !== null) {
                      bus.publish('tool.blocked', ctx.agentId, { runId, toolName: tc.name, reason: 'hook_denied', detail: hookResult.error ?? '' });
                      return { toolCallId: tc.id, name: tc.name, output: '', error: `Hook blocked: ${hookResult.error || 'denied'}`, durationMs: 0 };
                    }

                    if (siblingAbort.signal.aborted) {
                      return { toolCallId: tc.id, name: tc.name, output: '', error: 'Cancelled: sibling tool error', durationMs: 0 };
                    }
                    const cycleCheck = this.cycleDetector.check(tc.name, tc.arguments, toolLoopCount);
                    if (cycleCheck.detected) {
                      bus.publish('system.alert', 'runtime', { type: 'cycle_detected', toolName: tc.name, description: cycleCheck.description });
                      bus.publish('tool.blocked', ctx.agentId, { runId, toolName: tc.name, reason: 'cycle_detected', detail: cycleCheck.description });
                      cycleDetected = true;
                      return { toolCallId: tc.id, name: tc.name, output: '', error: `Cycle detected: ${cycleCheck.description}`, durationMs: 0 };
                    }
                    let toolResult = await this.executeTool(runId, tc, ctx.agentId, tenantId, ctx.availableTools);
                    toolResult = await getHookManager().fireAfterToolCall({
                      toolName: tc.name, args: tc.arguments, result: toolResult, agentId: ctx.agentId, runId,
                    });
                    if (toolResult.error && (tc.name === 'shell_execute' || tc.name === 'bash')) {
                      siblingAbort.abort();
                    }
                    if (!toolResult.error) {
                      this.toolCache.set(tc, toolResult, tenantId);
                      this.invalidateMutationCache(tc.name);
                    }
                    return { toolCallId: tc.id, name: tc.name, output: toolResult.output, error: toolResult.error, durationMs: toolResult.durationMs };
                  })
                );
                for (let i = 0; i < concurrentResults.length; i++) {
                  const r = concurrentResults[i];
                  if (r.status === 'fulfilled') {
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
                const hookCtx = { toolName: tc.name, args: tc.arguments, agentId: ctx.agentId, runId };
                const hookResult = await getHookManager().fireBeforeToolCall(hookCtx);
                if (hookResult !== null) {
                  bus.publish('tool.blocked', ctx.agentId, { runId, toolName: tc.name, reason: 'hook_denied', detail: hookResult.error ?? '' });
                  rawResults.push({ toolCallId: tc.id, name: tc.name, output: '', error: `Hook blocked: ${hookResult.error || 'denied'}`, durationMs: 0 });
                  continue;
                }
                const cycleCheck = this.cycleDetector.check(tc.name, tc.arguments, toolLoopCount);
                if (cycleCheck.detected) {
                  bus.publish('system.alert', 'runtime', { type: 'cycle_detected', toolName: tc.name, description: cycleCheck.description });
                  bus.publish('tool.blocked', ctx.agentId, { runId, toolName: tc.name, reason: 'cycle_detected', detail: cycleCheck.description });
                  rawResults.push({ toolCallId: tc.id, name: tc.name, output: '', error: `Cycle detected: ${cycleCheck.description}`, durationMs: 0 });
                  cycleDetected = true;
                  break;
                }
                let toolResult = await this.executeTool(runId, tc, ctx.agentId, tenantId, ctx.availableTools);
                toolResult = await getHookManager().fireAfterToolCall({
                  toolName: tc.name, args: tc.arguments, result: toolResult, agentId: ctx.agentId, runId,
                });
                if (!toolResult.error) {
                  this.toolCache.set(tc, toolResult, tenantId);
                  this.invalidateMutationCache(tc.name);
                }
                rawResults.push({ toolCallId: tc.id, name: tc.name, output: toolResult.output, error: toolResult.error, durationMs: toolResult.durationMs });
              }
            }

          // Merge cached + raw results, reorder to match original request order
          const allResults = [...cachedResults, ...rawResults];
          const resultMap = new Map(allResults.map(r => [r.toolCallId, r]));
          const orderedResults = calls.map(tc => resultMap.get(tc.id)!).filter(Boolean);

          // Output management: cap, truncate, persist per-turn budget
          const managedOutputs = this.outputManager.manageBatch(
            orderedResults.map((r, i) => ({
              toolCall: calls[i],
              result: { toolCallId: r.toolCallId, name: r.name, output: r.output, error: r.error, durationMs: r.durationMs },
            })),
          );

          // Governor-driven observation masking: adjust window based on budget pressure
          const maskDecision = this.governor.shouldApply('observation_mask');
          const effectiveWindow = maskDecision.apply
            ? Math.max(2, Math.floor(this.config.observationMaskWindow * (1 - maskDecision.intensity * 0.7)))
            : this.config.observationMaskWindow;
          const maskedResults = applyObservationMask(
            orderedResults.map((r, i) => ({
              ...r,
              output: managedOutputs[i]?.output ?? r.output,
            })),
            effectiveWindow,
          );

          for (const masked of maskedResults) {
            const tsNum = steps.length + 1;
            const toolStep: AgentExecutionStep = {
              stepNumber: tsNum,
              timestamp: now(),
              type: 'tool_result',
              content: masked.output,
              durationMs: masked.durationMs,
            };

            // ── Hook: onStepComplete ──
            getHookManager().fireOnStepComplete({
              runId, agentId: ctx.agentId, stepNumber: tsNum, type: 'tool_result', content: masked.output,
            }).catch(e => getGlobalLogger().debug('AgentRuntime', 'onStepComplete hook failed', { error: (e as Error)?.message }));

            steps.push(toolStep);

            const assistantMsg: import('./types').LLMMessage = {
              role: 'assistant',
              content: response.content,
              ...(response.reasoning_content ? { reasoning_content: response.reasoning_content } : {}),
              ...(response.toolCalls ? { tool_calls: response.toolCalls.map(tc => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              })) } : {}),
            };
            request.messages.push(
              assistantMsg,
              { role: 'tool', content: masked.output, tool_call_id: masked.toolCallId },
            );
          }

          // Resume the model with tool results
          const followUpCtx = { request, agentId: ctx.agentId, runId };
          let followUpRequest = await getHookManager().fireBeforeLLMCall(followUpCtx);
          const followUp = await this.callWithTimeout(followUpRequest, routing);
          await getHookManager().fireAfterLLMCall({ request: followUpRequest, response: followUp, agentId: ctx.agentId, runId });
          if (!followUp) break;
          totalTokens.promptTokens += followUp.usage.promptTokens;
          totalTokens.completionTokens += followUp.usage.completionTokens;
          totalTokens.totalTokens += followUp.usage.totalTokens;
          this.governor.reportUsage(followUp.usage.totalTokens);
          response = followUp;

          // Context compaction: governor-driven, triggered earlier under pressure
          const compactDecision = this.governor.shouldApply('context_compaction');
          const compactThreshold = compactDecision.apply ? 2 : 3;
          if (toolLoopCount > compactThreshold) {
            const tokensBefore = this.compactor.getUsage(request.messages).total;
            const tt = detectTaskType(ctx.goal);
            const taskType: CompactTaskType = tt === 'creative' ? 'general' : tt;

            // ── Hook: beforeContextCompaction ──
            getHookManager().fireBeforeContextCompaction({
              messageCount: request.messages.length, totalTokens: tokensBefore,
              budgetTokens: this.config.budgetHardCapTokens || 128000,
              agentId: ctx.agentId, runId,
            }).catch(e => getGlobalLogger().debug('AgentRuntime', 'beforeContextCompaction hook failed', { error: (e as Error)?.message }));

            const compactResult = this.compactor.compact(request.messages, undefined, taskType);
            if (compactResult.action.droppedCount > 0) {
              request.messages = compactResult.messages;
              this.governor.recordOutcome('context_compaction', tokensBefore, this.compactor.getUsage(request.messages).total);
              bus.publish('system.alert', 'runtime', {
                type: 'context_compaction',
                layer: compactResult.action.layer,
                droppedCount: compactResult.action.droppedCount,
                tokensSaved: compactResult.action.tokensSaved,
              });

              // ── Hook: afterContextCompaction ──
              getHookManager().fireAfterContextCompaction({
                messageCount: request.messages.length, totalTokens: this.compactor.getUsage(request.messages).total,
                budgetTokens: this.config.budgetHardCapTokens || 128000,
                agentId: ctx.agentId, runId,
              }).catch(e => getGlobalLogger().debug('AgentRuntime', 'afterContextCompaction hook failed', { error: (e as Error)?.message }));
            }
          }
        }

        // ── Hook: onSessionArchive (before checkpoint) ──
        getHookManager().fireOnSessionArchive({
          runId, phase: 'tool_execution', stepNumber: steps.length,
          tokenUsage: { totalTokens: totalTokens.totalTokens },
        }).catch(e => getGlobalLogger().debug('AgentRuntime', 'onSessionArchive hook failed', { error: (e as Error)?.message }));

        this.checkpointer.checkpoint({
          runId, agentId: ctx.agentId, missionId: ctx.missionId,
          timestamp: now(), phase: 'tool_execution',
          stepNumber: steps.length,
          attemptNumber: attempt,
          messages: request.messages,
          tokenUsage: { ...totalTokens },
          stepDurations: steps.map(s => s.durationMs),
          context: {
            agentId: ctx.agentId, missionId: ctx.missionId,
            projectId: ctx.projectId, goal: ctx.goal,
            availableTools: ctx.availableTools,
            maxSteps: ctx.maxSteps, tokenBudget: ctx.tokenBudget,
          },
          totalDurationMs: Date.now() - startTime,
        });

        // Unified Verification Pipeline: tiered zero-cost-first verification
        const verifCtx: UVPTaskContext = {
          goal: ctx.goal,
          output: response.content,
          language: ctx.goal.toLowerCase().includes('python') ? 'python' : undefined,
          schema: ctx.outputSchema,
          toolsUsed: ctx.availableTools,
          tokenBudgetRemaining: this.governor.getState().remainingTokens,
          previousFailures: lastError ? [lastError] : undefined,
        };
        const verifReport = await this.verificationPipeline.verify(verifCtx);
        this.governor.reportUsage(verifReport.tokensUsed);

        // Record verification result to samples store
        this.samplesStore.recordVerification(ctx.goal, response.content, {
          passed: verifReport.passed,
          confidence: verifReport.confidence,
          signalCount: verifReport.signals.length,
          tokensUsed: verifReport.tokensUsed,
          stagesRun: verifReport.stagesRun,
          skipReason: verifReport.skipReason,
        });

        this.checkpointer.checkpoint({
          runId, agentId: ctx.agentId, missionId: ctx.missionId,
          timestamp: now(), phase: 'verification',
          stepNumber: steps.length,
          attemptNumber: attempt,
          messages: request.messages,
          tokenUsage: { ...totalTokens },
          stepDurations: steps.map(s => s.durationMs),
          context: {
            agentId: ctx.agentId, missionId: ctx.missionId,
            projectId: ctx.projectId, goal: ctx.goal,
            availableTools: ctx.availableTools,
            maxSteps: ctx.maxSteps, tokenBudget: ctx.tokenBudget,
          },
          lastError,
          totalDurationMs: Date.now() - startTime,
        });

        if (!verifReport.passed && attempt < this.config.maxRetries) {
          const feedback = this.verificationPipeline.toFeedback(verifReport);
          if (feedback) {
            lastError = feedback;
            tracer.recordDecision(runId, `verification (attempt ${attempt + 1}, confidence ${verifReport.confidence.toFixed(2)}): ${feedback.slice(0, 100)}`, 0);
            request.messages.push({ role: 'user', content: feedback });
            continue;
          }
        }

        // Content safety scan before returning result
        let safeContent = response.content;
        try {
          const scanResult = await this.contentScanner.scan(safeContent);
          if (!scanResult.isSafe) {
            const criticalThreats = scanResult.threats.filter(t => t.severity === 'HIGH' || t.severity === 'CRITICAL');
            if (criticalThreats.length > 0) {
              bus.publish('system.alert', 'runtime', {
                type: 'content_threat_blocked',
                threats: criticalThreats.map(t => `${t.type}:${t.severity}`),
              });
              safeContent = `[Content blocked: ${criticalThreats.length} security threat(s) detected. Review and resubmit.]`;
            }
          }
        } catch (e) { getGlobalLogger().warn('AgentRuntime', 'Content scan failed (best-effort)', { error: (e as Error)?.message }); }

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
          summary: safeContent.slice(0, 2000),
          steps,
          totalTokenUsage: totalTokens,
          totalDurationMs,
        };

        this.checkpointer.terminalCheckpoint({
          runId, agentId: ctx.agentId, missionId: ctx.missionId,
          timestamp: now(), phase: 'completed',
          stepNumber: steps.length,
          attemptNumber: attempt,
          messages: request.messages,
          tokenUsage: { ...totalTokens },
          stepDurations: steps.map(s => s.durationMs),
          context: {
            agentId: ctx.agentId, missionId: ctx.missionId,
            projectId: ctx.projectId, goal: ctx.goal,
            availableTools: ctx.availableTools,
            maxSteps: ctx.maxSteps, tokenBudget: ctx.tokenBudget,
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
              { runId, goal: ctx.goal.slice(0, 500), tokenUsage: totalTokens, durationMs: totalDurationMs },
            );
          } catch (e) { getGlobalLogger().warn('AgentRuntime', 'Failed to record success memory', { error: (e as Error)?.message }); }
        }

        // Fire plugin onAgentComplete hooks
        getHookManager().fireOnAgentComplete({ result, runId }).catch(e => getGlobalLogger().debug('AgentRuntime', 'onAgentComplete hook failed', { error: (e as Error)?.message }));

        // Emit completed event
        getMetricsCollector().recordRunComplete('success', totalDurationMs, steps.length, tenantId);
        bus.publish('agent.completed', ctx.agentId, {
          runId,
          missionId: ctx.missionId,
          summary: result.summary,
          tokenUsage: totalTokens,
          durationMs: totalDurationMs,
        });

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
        break; // Don't retry permanent errors
      }
    }

    // All attempts failed
    tracer.recordError(runId, `All ${this.config.maxRetries + 1} attempts failed`, Date.now() - startTime);

    // Fire plugin onError hooks
    getHookManager().fireOnError({ error: lastError ?? 'Unknown error', runId, agentId: ctx.agentId }).catch(e => getGlobalLogger().debug('AgentRuntime', 'onError hook failed', { error: (e as Error)?.message }));

    this.checkpointer.terminalCheckpoint({
      runId, agentId: ctx.agentId, missionId: ctx.missionId,
      timestamp: now(), phase: 'failed',
      stepNumber: steps.length,
      attemptNumber: this.config.maxRetries,
      messages: request.messages,
      tokenUsage: { ...totalTokens },
      stepDurations: steps.map(s => s.durationMs),
      context: {
        agentId: ctx.agentId, missionId: ctx.missionId,
        projectId: ctx.projectId, goal: ctx.goal,
        availableTools: ctx.availableTools,
        maxSteps: ctx.maxSteps, tokenBudget: ctx.tokenBudget,
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
      } catch (e) { getGlobalLogger().warn('AgentRuntime', 'Failed to record failure memory', { error: (e as Error)?.message }); }
    }

    getMetricsCollector().recordRunComplete('failed', Date.now() - startTime, steps.length, tenantId);
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
      });

    } finally {
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
      try { tracer.completeRun(runId); } catch (e) { getGlobalLogger().warn('AgentRuntime', 'Failed to complete trace', { runId, error: (e as Error)?.message }); }
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
          getGlobalLogger().warn('AgentRuntime', 'Failed to export OTel spans', { runId, error: (e as Error)?.message });
        }
      }
      try { await this.samplesStore.flush(); } catch (e) { getGlobalLogger().warn('AgentRuntime', 'Failed to flush samples', { runId, error: (e as Error)?.message }); }
      try { this.traceStore.flushAll(); } catch (e) { getGlobalLogger().warn('AgentRuntime', 'Failed to flush traces', { runId, error: (e as Error)?.message }); }
      // Restore tenant-scoped overrides
      this.samplesStore = origSamplesStore;
      this.traceStore = origTraceStore;
      this.checkpointer = origCheckpointer;
      this.memory = origMemory;
    }
  }

  private async callWithTimeout(
    request: LLMRequest,
    routing: RoutingDecision,
    attemptNumber: number = 0,
    taskId?: string,
  ): Promise<LLMResponse | null> {
    const provider = this.providers.get(routing.provider);
    let providerName = routing.provider;
    if (!provider) {
      const firstProvider = this.providers.values().next().value;
      if (!firstProvider) {
        this.samplesStore.recordLLMCall(request, null, {
          provider: 'none', durationMs: 0, attemptNumber,
          error: 'No provider available',
        });
        return null;
      }
      providerName = firstProvider.name;
      return this.callProvider(firstProvider, providerName, request, attemptNumber, taskId);
    }

    return this.callProvider(provider, providerName, request, attemptNumber, taskId);
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
      // AbortController wired into a rejection-based timeout.
      // When the timeout fires, the abort promise rejects, ending the race.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

      const abortPromise = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error(`LLM call timed out after ${this.config.timeoutMs}ms`));
        });
      });

      let result: LLMResponse;
      try {
        result = await Promise.race([provider.call(request), abortPromise]);
      } finally {
        clearTimeout(timeoutId);
      }

      this.samplesStore.recordLLMCall(request, result, {
        provider: providerName, durationMs: Date.now() - startMs,
        attemptNumber, taskId,
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
  ): Promise<ToolResult> {
    const tracer = getTraceRecorder();
    const bus = getMessageBus();
    const startTime = Date.now();

    // Sub-agent tool whitelist enforcement: if an allowlist is provided,
    // reject any tool call outside the allowed set.
    if (allowedTools && !allowedTools.includes(toolCall.name)) {
      const errorMsg = `TOOL_NOT_ALLOWED: "${toolCall.name}" is not in the allowed tools list for this agent. Allowed: ${allowedTools.join(', ')}`;
      bus.publish('tool.blocked', agentId, { runId, toolName: toolCall.name, reason: 'not_allowed', detail: errorMsg });
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: errorMsg,
        error: errorMsg,
        durationMs: 0,
      };
    }

    // ── Hook: beforeToolResolve (can block by returning ToolResult) ──
    const resolveBlock = await getHookManager().fireBeforeToolResolve({
      toolName: toolCall.name, args: toolCall.arguments, agentId, runId,
    });
    if (resolveBlock !== null) {
      bus.publish('tool.blocked', agentId, { runId, toolName: toolCall.name, reason: 'hook_blocked', detail: resolveBlock.error ?? '' });
      return resolveBlock;
    }

    const tool = this.tools.get(toolCall.name);
    const toolFound = !!tool;

    // ── Hook: afterToolResolve ──
    getHookManager().fireAfterToolResolve({
      toolName: toolCall.name, args: toolCall.arguments,
      tool: tool ? { name: tool.definition.name, category: tool.definition.category } : undefined,
      notFound: !toolFound, agentId, runId,
    }).catch(e => getGlobalLogger().debug('AgentRuntime', 'afterToolResolve hook failed', { error: (e as Error)?.message }));

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
        tags: ['tool_not_found'],
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
      });
    }

    const effectiveTimeout = tool.timeout ?? this.config.timeoutMs;

    // Validate and repair tool call arguments before execution
    const { args: repairedArgs, repairs } = repairToolCallArguments(toolCall.arguments, toolCall.name);
    const schema = tool.compiledSchema ?? ToolRegistry.getCompiledSchema(toolCall.name);
    let validatedArgs = repairedArgs;
    if (schema) {
      const validation = validateToolCall(repairedArgs, schema);
      if (!validation.valid) {
        const errorFeedback = formatValidationErrors(validation.errors, toolCall.name, repairs);
        tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, '', 0, errorFeedback);
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: '',
          error: errorFeedback,
          durationMs: Date.now() - startTime,
        };
      }
      validatedArgs = validation.repairedArgs ?? repairedArgs;
    }

    bus.publish('tool.started', agentId, { runId, toolName: toolCall.name, args: toolCall.arguments });

    const boundary = new StepErrorBoundary(runId, agentId, this.dlq, undefined, {
      maxRetries: 1,
      retryDelayMs: this.config.retryDelayMs,
      onExhausted: 'skip',
      onPermanent: 'abort',
    });

    const boundaryResult = await boundary.execute<string>(
      toolCall.name,
      'tool',
      async () => {
        const execPromise = tool.execute(validatedArgs);
        const timeoutPromise = new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`TOOL_TIMEOUT: "${toolCall.name}" exceeded ${effectiveTimeout}ms`)), effectiveTimeout);
          if (typeof timer.unref === 'function') (timer as ReturnType<typeof setTimeout> & { unref: () => void }).unref();
        });
        return Promise.race([execPromise, timeoutPromise]);
      },
      {
        tags: ['tool_execution', toolCall.name],
        inputSnapshot: JSON.stringify(toolCall.arguments).slice(0, 1000),
      },
    );

    if (boundaryResult.recovered) {
      bus.publish('tool.retry', agentId, { runId, toolName: toolCall.name, attempts: boundaryResult.attempts });
    }

    if (!boundaryResult.success) {
      const durationMs = Date.now() - startTime;
      const errorMsg = boundaryResult.error ?? 'Unknown tool error';

      tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, '', durationMs, errorMsg);
      getMetricsCollector().recordToolCall(toolCall.name, durationMs, errorMsg, tenantId);
      getMetricsCollector().recordError(boundaryResult.errorClass, tenantId);

      if (errorMsg.includes('TOOL_TIMEOUT')) {
        bus.publish('tool.timeout', agentId, { runId, toolName: toolCall.name, timeoutMs: effectiveTimeout, durationMs });
      }

      // Compensate side-effects from prior mutation tools in this run
      let compensateResult = await this.compensationRegistry.compensate(actionId);
      if (!compensateResult.success) {
        compensateResult = await this.compensationRegistry.compensate(actionId);
      }
      if (!compensateResult.success) {
        getGlobalLogger().debug('AgentRuntime', 'Compensation failed after retry', { actionId, error: compensateResult.error });
      }

      const structuredError = [
        `tool_error: "${toolCall.name}" failed after ${durationMs}ms`,
        `  reason: ${errorMsg}`,
        `  errorClass: ${boundaryResult.errorClass}`,
        `  args: ${JSON.stringify(toolCall.arguments)}`,
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
      if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir, { recursive: true });
      const resultFile = path.join(resultDir, `${toolCall.name}-${hash}.txt`);
      fs.writeFileSync(resultFile, output, 'utf-8');
      const headSize = Math.floor(maxSize * 0.6);
      const tailSize = maxSize - headSize;
      const head = output.slice(0, headSize);
      const tail = output.length > headSize ? output.slice(-tailSize) : '';
      output = `[Large output: ${output.length} chars. Saved to ${resultFile}.]\n${head}\n... [truncated, omitted ${output.length - maxSize} chars] ...\n${tail}\n[End. Full output at ${resultFile}]`;
    }

    tracer.recordToolExecution(runId, toolCall.name, toolCall.arguments, output, durationMs);
    getMetricsCollector().recordToolCall(toolCall.name, durationMs, undefined, tenantId);
    bus.publish('tool.executed', agentId, { toolName: toolCall.name, durationMs });
    bus.publish('tool.completed', agentId, { runId, toolName: toolCall.name, durationMs });

    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      output: typeof output === 'string' ? output : JSON.stringify(output),
      durationMs,
    };
  }

  /** Register default compensation handlers for mutation tools */
  private registerDefaultCompensation(): void {
    this.compensationRegistry.register('file_write', async (action) => {
      const filePath = action.args.filePath ?? action.args.path;
      if (typeof filePath === 'string') {
        try {
          const fs = await import('fs');
          fs.unlinkSync(filePath);
          return { success: true };
        } catch (e) { getGlobalLogger().debug('AgentRuntime', 'File compensation: file may already be deleted', { filePath, error: (e as Error)?.message }); }
      }
      return { success: true };
    });
    this.compensationRegistry.register('file_edit', async () => {
      // file_edit is append-only in this codebase — no undo without snapshot
      return { success: true };
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
    return new Promise<void>(resolve => {
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
    return this.checkpointer.listCheckpoints().filter(
      cp => cp.phase !== 'completed' && cp.phase !== 'failed',
    );
  }

  /**
   * Resume a crashed run from its last checkpoint.
   * Returns null if the checkpoint is not found or already terminal.
   */
  resume(runId: string): CheckpointState | null {
    return this.checkpointer.resume(runId);
  }

  getActiveRunCount(): number {
    return this.activeRuns.size;
  }

  isRunActive(runId: string): boolean {
    return this.activeRuns.has(runId);
  }
}
