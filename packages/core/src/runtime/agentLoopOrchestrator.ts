import { reportSilentFailure } from '../silentFailureReporter';
import type {
  AgentExecutionContext,
  AgentExecutionResult,
  AgentExecutionStep,
  AgentRuntimeConfig,
  LLMRequest,
  LLMResponse,
  RoutingDecision,
  TokenUsage,
} from './types';
import type { ModelConfig } from './types/routing';
import {
  GOAL_TELEMETRY_MAX_CHARS,
  GOAL_RESULT_MAX_CHARS,
  GOAL_FULL_MAX_CHARS,
  OUTPUT_PREFIX_MAX_CHARS,
  RESULT_CONTENT_MAX_CHARS,
  ERROR_MAX_CHARS,
} from './runtimeConstants';
import type { ModelRouter } from './modelRouter';
import { getMessageBus } from './messageBus';
import { getTraceRecorder } from './executionTrace';
import { getGlobalDeterminismCapture } from './determinismCapture';
import { getMetricsCollector } from './metricsCollector';
import { getCostEstimator } from './costEstimator';
import { getHookManager } from '../pluginManager';
import { getHallucinationDetector, type HallucinationReport } from '../hallucinationDetector';
import { getGlobalLogger } from '../logging';
import { getFreezeDryManager } from './freezeDry';
import { getModelPerformanceStore } from './modelPerformanceStore';
import { getVerificationReportStore } from './verificationReportStore';
import { getIntentLog } from './intentLog';
import { checkMemoryPoisoning } from '../security/memoryPoisoningGate';
import { getMemoryPoisoningDefenseEngine } from '../security/memoryPoisoningDefenseEngine';
import {
  UnifiedVerificationPipeline,
  type UVPTaskContext,
  detectTaskType,
} from './unifiedVerification';
import { TokenGovernor } from './tokenGovernor';
import { CircuitBreaker } from './circuitBreaker';
import { ToolExecutionHandler } from './toolExecutionHandler';
import { GoalCompletionVerifier, type ExecuteToolFn } from './goalCompletionVerifier';
import { CheckpointingPhase } from './phases/checkpointing';
import { SamplesStore } from './samplesStore';
import { ContentScanner } from '../contentScanner';
import { ThreeLayerMemory } from '../threeLayerMemory';
import { ToolExecutionService } from './toolExecutionService';
import { CycleDetector } from './cycleDetector';
import { ReflexionInjector, type ReflectionEntry } from '../memory/reflexionInjector';
import { ReflexionGenerator, type ReflexionContext } from './reflexionGenerator';
import { ContextCompactor, type CompactTaskType } from './contextCompactor';
import { SecurityOrchestrator } from './securityOrchestrator';
import { RunTelemetryRecorder } from './runTelemetryRecorder';
import { SmartModelRouter } from './smartModelRouter';
import { classifyLLMError, computeBackoff } from './llmRetry';
import { isConfidentResponse } from './entropyGater';
import { now, delay, generateId } from './runtimeHelpers';
import { getGlobalTenantProvider } from './tenantProvider';
import type { CrossAgentEvent } from '../security/crossAgentCorrelator';
import type { PreLoopSetupResult, EscalationChain } from './preLoopSetup';
import type { InitResult } from './runInitializer';

export interface AgentLoopOrchestratorDeps {
  getConfig(): AgentRuntimeConfig;
  getProviders(): Map<string, import('./types').LLMProvider>;
  getRouter(): ModelRouter;
  getSmartRouter(): SmartModelRouter | null;
  getGovernor(): TokenGovernor;
  getCircuitBreaker(): CircuitBreaker;
  getToolExecutionHandler(): ToolExecutionHandler;
  getToolExecutionService(): ToolExecutionService;
  getGoalCompletionVerifier(): GoalCompletionVerifier;
  getVerificationPipeline(): UnifiedVerificationPipeline;
  getContentScanner(): ContentScanner;
  getMemory(): ThreeLayerMemory | null;
  getCheckpointingPhase(): CheckpointingPhase;
  getSamplesStore(): SamplesStore;
  getCompactor(): ContextCompactor;
  getCycleDetector(): CycleDetector;
  getReflexionInjector(): ReflexionInjector;
  getReflexionGenerator(): ReflexionGenerator;
  getSecurityOrch(): SecurityOrchestrator;
  getRunTelemetryRecorder(): RunTelemetryRecorder;
  getMetricsCollector(): import('./metricsCollector').MetricsCollector;
  getCostEstimator(): import('./costEstimator').CostEstimator;
  getHookManager(): import('../pluginManager').HookManager;
  getLastProviderError(): Error | null;
  setLastProviderError(err: Error | null): void;
  setLastHallucinationDetected(value: boolean): void;
  /** Called when the circuit breaker has already been updated (onSuccess/onFailure) so the cleanup handler does not release it again. */
  onCircuitReleased(): void;
  executeTool: ExecuteToolFn;
  callWithTimeout: (
    request: LLMRequest,
    routing: RoutingDecision,
    attemptNumber?: number,
    taskId?: string,
  ) => Promise<LLMResponse | null>;
}

export class AgentLoopOrchestrator {
  constructor(private readonly deps: AgentLoopOrchestratorDeps) {}

  async run(
    ctx: AgentExecutionContext,
    init: InitResult,
    setup: PreLoopSetupResult,
  ): Promise<AgentExecutionResult> {
    const { runId, tenantId, startTime } = init;
    const { request, batchRouting, costEstimate, taskType, projectContext, state } = setup;
    let routing = setup.routing;
    let currentEscalationChain: EscalationChain = setup.escalationChain;
    void batchRouting;
    void projectContext;

    const bus = getMessageBus();
    const tracer = getTraceRecorder();
    const costEstimator = this.deps.getCostEstimator();

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
    // Consecutive degeneration counter: when the model degenerates 2+
    // times in a row, force earlyExit to prevent cascading context
    // pollution. The model's reasoning quality will not recover.
    let consecutiveDegenerationCount = 0;

    // Cost enforcement is handled by EnterpriseSecurityGateway.preLLMCheck
    // (→ UnifiedCostAuthority) inside the LLM call path. The legacy
    // CostGuard.evaluateRequest() previously duplicated this check on
    // the hot path; it has been removed to eliminate double-checking.
    // CostGuard is now @deprecated — see security/costGuard.ts.

    for (let attempt = 0; attempt <= this.deps.getConfig().maxRetries; attempt++) {
      const llmCtx = { request, agentId: ctx.agentId, runId };
      const llmRequest = await this.deps.getHookManager().fireBeforeLLMCall(llmCtx);

      // PASTE speculative execution: pre-execute predicted read-only tools
      // during LLM thinking time. Fire-and-forget — results land in
      // ToolResultCache and are consumed transparently on cache hit.
      try {
        this.deps
          .getToolExecutionService()
          .triggerSpeculativeExecution(tenantId)
          .catch(() => {});
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:speculativeTrigger');
      }

      let response = await this.deps.callWithTimeout(llmRequest, routing);
      await this.deps.getHookManager().fireAfterLLMCall({
        request: llmRequest,
        response,
        agentId: ctx.agentId,
        runId,
      });
      const stepDuration = Date.now() - startTime;

      // Enforce sub-agent step limits (only when ctx.guard is set by subAgentExecutor)
      ctx.guard?.check(0);

      if (response) {
        // DeterminismCapture: record LLM response for event replay recovery (Path A).
        // Fire-and-forget — capture failures never block the critical path.
        try {
          const captureStep = getGlobalDeterminismCapture().nextStep(runId);
          getGlobalDeterminismCapture().captureLLMResponse(runId, captureStep, response);
        } catch (capErr) {
          reportSilentFailure(capErr, 'agentRuntime:captureLLMResponse');
        }
        // Accumulate token usage
        totalTokens.promptTokens += response.usage.promptTokens;
        totalTokens.completionTokens += response.usage.completionTokens;
        totalTokens.totalTokens += response.usage.totalTokens;
        totalTokens.cacheReadTokens =
          (totalTokens.cacheReadTokens ?? 0) + (response.usage.cacheReadTokens ?? 0);
        this.deps.getGovernor().reportUsage(response.usage.totalTokens);
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
        void _traceEventId;
        getMetricsCollector().recordLLMCall(
          routing.modelId,
          routing.provider,
          response.usage.totalTokens,
          stepDuration,
          undefined,
          tenantId,
        );

        // Hallucination detection: single analyze call for both HITL
        // signal and security event enrichment (previously called twice).
        let hallucinationReport: HallucinationReport | null = null;
        try {
          const userInput = request.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content)
            .join('\n')
            .slice(0, 4000);
          hallucinationReport = getHallucinationDetector().analyze(
            userInput,
            response.content?.slice(0, 4000) ?? '',
          );
          this.deps.setLastHallucinationDetected(
            hallucinationReport.recommendation === 'reject' ||
              hallucinationReport.recommendation === 'flag_for_review',
          );
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:hallucination-detection');
          this.deps.setLastHallucinationDetected(false);
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
          // Reuse the hallucination report from above (OWASP ASI10) — no
          // duplicate analyze() call. Enriches the LLM event for HITL.
          if (hallucinationReport && hallucinationReport.recommendation !== 'pass') {
            getGlobalLogger().warn('AgentRuntime', 'Hallucination detected', {
              agentId: ctx.agentId,
              riskScore: hallucinationReport.riskScore,
              recommendation: hallucinationReport.recommendation,
              signals: hallucinationReport.signals.length,
            });
            llmEvent.metadata.hallucinationDetected = true;
            llmEvent.metadata.hallucinationRiskScore = hallucinationReport.riskScore;
            llmEvent.severity = 'medium' as const;
          }
          this.deps.getSecurityOrch().onAgentEvent(llmEvent);
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:2104');
          /* best-effort */
        }

        // Record actual cost for estimator learning (per-step)
        try {
          const modelCfg = this.deps.getRouter().getModel(routing.modelId);
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
          this.deps
            .getRouter()
            .recordOutcome(
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

        // NOTE: TokenSentinel advisory budget check removed — superseded by
        // UnifiedCostAuthority (UCA). The UCA's postCall (invoked via
        // EnterpriseSecurityGateway.postLLMCheck) now owns per-run budget
        // tracking, anomaly observation (3σ), and melt triggering.
        // Keeping this block as a comment to document the migration.

        // ── Degeneration guard (PRE-STEP) ──
        // Detect and sanitize model degeneration BEFORE the step is created.
        // This prevents degenerate content (e.g., "TheTheTheThe…") from
        // entering step history, where it would contaminate the final
        // summary when the terminal handler pulls from steps.
        let degenerationDetected = false;
        if (response.content) {
          const stagnation = this.deps.getCycleDetector().checkOutput(response.content);
          if (stagnation.detected && stagnation.type === 'semantic_stagnation') {
            consecutiveDegenerationCount++;
            bus.publish('system.alert', 'runtime', {
              ...stagnation,
              runId,
              agentId: ctx.agentId,
              stepNumber: steps.length + 1,
              consecutive: consecutiveDegenerationCount,
            });
            getGlobalLogger().warn('AgentRuntime', 'Semantic stagnation detected', {
              stepNumber: steps.length + 1,
              similarity: stagnation.similarity,
              description: stagnation.description,
              consecutive: consecutiveDegenerationCount,
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
            // Recovery strategy: on 3rd+ consecutive degeneration, the
            // model has lost coherence — continuing to execute tool
            // calls will only pollute the context further and produce
            // worse outcomes. Force earlyExit by clearing toolCalls so
            // the terminal handler takes over with whatever work was
            // already completed. On 1st-2nd degeneration, preserve
            // toolCalls (the model may still issue valid calls like
            // update-dep) and give it a chance to recover.
            if (consecutiveDegenerationCount >= 3) {
              getGlobalLogger().warn(
                'AgentRuntime',
                'Forcing earlyExit due to repeated degeneration',
                {
                  consecutiveDegenerationCount,
                  stepNumber: steps.length + 1,
                  toolCallsCleared: response.toolCalls?.length ?? 0,
                },
              );
              getMetricsCollector().incrementCounter(
                'degeneration_forced_exits_total',
                'Early exits forced due to repeated model degeneration',
                1,
                [{ name: 'reason', value: 'consecutive_degeneration' }],
              );
              response.toolCalls = [];
            }
            degenerationDetected = true;
          } else {
            // Reset counter when output is healthy
            consecutiveDegenerationCount = 0;
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
        } = await this.deps.getToolExecutionHandler().executeStep({
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

        // FreezeDry: update run state with current step progress so the
        // freeze manifest reflects the latest step at crash time.
        try {
          getFreezeDryManager().setRunState(runId, {
            runId,
            agentId: ctx.agentId,
            phase: 'executing',
            stepNumber,
            goal: ctx.goal,
            completedToolCalls: steps.length,
          });
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:freezeDryStepUpdate');
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
          state.totalTokenUsage = totalTokens;
          state.steps = steps;
          await this.deps.getCheckpointingPhase().checkpointTerminal(ctx, state, 'interrupted', {
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
        //
        // Skip verification when degeneration was detected: the model's
        // output is unreliable, and injecting feedback into a degenerating
        // model only accelerates context pollution. Accept whatever work
        // was already completed and go to terminal handling.
        const verification = degenerationDetected
          ? {
              isComplete: true,
              verificationTrace: 'verification=skipped;reason=degeneration_detected',
            }
          : await this.deps.getGoalCompletionVerifier().verify({
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
              maxRetries: this.deps.getConfig().maxRetries,
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
            const earlyExitScan = await this.deps.getContentScanner().scan(safeContent);
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
          await this.deps
            .getCheckpointingPhase()
            .checkpointTerminal(ctx, state, 'completed_early_exit', {
              request,
              attempt,
              stepNumber: steps.length,
              exitSummary: result.summary,
            });

          if (this.deps.getMemory()) {
            try {
              const _memContent = `[EARLY_EXIT] ${ctx.goal.slice(0, GOAL_TELEMETRY_MAX_CHARS)}`;
              // Security (OWASP ASI07): Memory poisoning detection gate.
              const _poisoningCheck = checkMemoryPoisoning(
                _memContent,
                `agent:${ctx.agentId}`,
                ctx.agentId,
              );
              if (!_poisoningCheck.allowed) {
                getGlobalLogger().warn('AgentRuntime', 'Memory write blocked by poisoning gate', {
                  reason: _poisoningCheck.reason,
                });
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
                    getGlobalLogger().warn(
                      'AgentRuntime',
                      'Memory write blocked by defense engine',
                      {
                        reason: _defenseResult.reason,
                        riskScore: _defenseResult.riskScore,
                        severity: _defenseResult.severity,
                      },
                    );
                  }
                } catch (err) {
                  reportSilentFailure(err, 'agentRuntime:defenseEngine:early_exit');
                }
                if (!_defenseBlocked) {
                  this.deps
                    .getMemory()!
                    .add(
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
            const modelCfg = this.deps.getRouter().getModel(routing.modelId);
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

          init.circuitReleased = true;
          this.deps.onCircuitReleased();
          return result;
        }

        // ── Hook: onSessionArchive (before checkpoint) ──
        this.deps
          .getHookManager()
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
        await this.deps.getCheckpointingPhase().checkpointAfterStep(ctx, state, 'tool_execution', {
          request,
          attempt,
          stepNumber: steps.length,
        });

        // Enforce sub-agent progress and step limits
        ctx.guard?.check(evidenceCount);

        // Unified Verification Pipeline: tiered zero-cost-first verification
        // Governor strategy: skip LLM verification when budget is tight and model is confident
        const verifSkipDecision = this.deps.getGovernor().shouldApply('verification_skip');
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
            tokenBudgetRemaining: this.deps.getGovernor().getState().remainingTokens,
            previousFailures: lastError ? [lastError] : undefined,
          };
          const verifStart = Date.now();
          verifReport = await this.deps.getVerificationPipeline().verify(verifCtx);
          this.deps.getGovernor().reportUsage(verifReport.tokensUsed);
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
        this.deps.getSamplesStore().recordVerification(ctx.goal, response.content, {
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
              (s) => (s as { type?: string }).type ?? (s as { name?: string }).name ?? 'unknown',
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
        await this.deps.getCheckpointingPhase().checkpointAfterStep(ctx, state, 'verification', {
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
        this.deps.getReflexionInjector().addReflection(reflectionInsight);

        // Semantic circuit breaker: track consecutive verification failures.
        // When verification repeatedly fails, the circuit breaker can trigger
        // semantic-level intervention (e.g., escalate to stronger model).
        if (!verifReport.passed) {
          this.deps.getCircuitBreaker().recordSemanticFailure(
            `verification_failed: ${(verifReport.signals[0] && ((verifReport.signals[0] as { type?: string }).type ?? (verifReport.signals[0] as { name?: string }).name)) || 'unknown'}`,
            // Phase 2 Hub Glue / SemanticCircuitCorrelator: stamp the
            // current runId so the semantic_circuit_trip callback can
            // correlate with the corresponding `tool.blocked circuit_broken`
            // via the runId-strengthened 1-tuple key. toolName is intentionally
            // OMITTED — see pairCorrelator.ts requireToolNameOnAlert:false.
            { runId },
          );
        } else {
          this.deps.getCircuitBreaker().recordSemanticSuccess();
        }

        if (!verifReport.passed && attempt < this.deps.getConfig().maxRetries) {
          const maxReflexion = this.deps.getConfig().reflexionMaxIterations ?? 2;

          // Tier 3.2 (RFC v2): explicit reflection-driven self-correction loop for
          // low-confidence verification failures. Heuristic-only generation avoids
          // an extra LLM call; cap iterations to prevent runaway cost.
          if (verifReport.confidence < 0.5 && maxReflexion > 0) {
            let reflexionAttempt = 0;
            let currentFeedback = this.deps.getVerificationPipeline().toFeedback(verifReport);

            while (reflexionAttempt < maxReflexion && currentFeedback && !verifReport.passed) {
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

              const reflexion = await this.deps.getReflexionGenerator().generate(reflexionCtx);

              this.deps.getReflexionInjector().addReflection({
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
              const reflexionResponse = await this.deps.callWithTimeout(request, routing, attempt);
              if (!reflexionResponse) break;

              response = reflexionResponse;
              totalTokens.promptTokens += reflexionResponse.usage.promptTokens;
              totalTokens.completionTokens += reflexionResponse.usage.completionTokens;
              totalTokens.totalTokens += reflexionResponse.usage.totalTokens;
              totalTokens.cacheReadTokens =
                (totalTokens.cacheReadTokens ?? 0) + (reflexionResponse.usage.cacheReadTokens ?? 0);
              this.deps.getGovernor().reportUsage(reflexionResponse.usage.totalTokens);

              verifReport = await this.deps.getVerificationPipeline().verify({
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
                tokenBudgetRemaining: this.deps.getGovernor().getState().remainingTokens,
                previousFailures: lastError ? [lastError] : undefined,
              });
              this.deps.getGovernor().reportUsage(verifReport.tokensUsed);

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
                currentFeedback = this.deps.getVerificationPipeline().toFeedback(verifReport);
              }
            }
          }

          const feedback = this.deps.getVerificationPipeline().toFeedback(verifReport);
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
            this.deps
              .getCompactor()
              .recordFailureCorrelation(runId, request.messages, failureSignal);

            const tokensBeforeRetry = this.deps.getCompactor().getUsage(request.messages).total;
            const tt = detectTaskType(ctx.goal);
            const compactTaskType: CompactTaskType = tt === 'creative' ? 'general' : tt;
            const retryCompact = this.deps
              .getCompactor()
              .compact(request.messages, undefined, compactTaskType);
            if (retryCompact.action.droppedCount > 0) {
              request.messages = retryCompact.messages;
              this.deps
                .getGovernor()
                .recordOutcome(
                  'context_compaction',
                  tokensBeforeRetry,
                  this.deps.getCompactor().getUsage(request.messages).total,
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
            const smartRouter = this.deps.getSmartRouter();
            if (smartRouter && currentEscalationChain.length > 0) {
              const nextId = smartRouter.getNextEscalation(
                routing.modelId,
                currentEscalationChain.map((m) => m.id),
              );
              fallbackModel = nextId
                ? (smartRouter.getModel(nextId.id) as ModelConfig | undefined)
                : undefined;
            } else {
              fallbackModel =
                currentEscalationChain.length > 0
                  ? this.deps.getRouter().getNextEscalation(routing.modelId, currentEscalationChain)
                  : this.deps.getRouter().getFallbackModel(routing.modelId, tt);
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
                (m) => m.id !== fallbackModel!.id,
              );
              request.model = (fallbackModel.id || '').replace(/@\w+$/, '') || fallbackModel.id;
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

            const reflections = this.deps.getReflexionInjector().getRecentReflections(3);
            // Limit feedback length to prevent context bloat. The full
            // feedback + reflections can be 1000+ chars, which accelerates
            // context growth and triggers model degeneration in small models.
            // Truncate to 500 chars (enough for actionable guidance).
            const baseFeedback = feedback.slice(0, 500);
            const augmentedFeedback =
              reflections.length > 0
                ? `${baseFeedback}\n\n[Reflections]:\n${reflections.map((r, i) => `${i + 1}. ${r.insight.slice(0, 100)}`).join('\n')}`.slice(
                    0,
                    800,
                  )
                : baseFeedback;
            request.messages.push({ role: 'user', content: augmentedFeedback });
            continue;
          }
        }

        // Content safety scan before returning result
        // Reasoning models (MiMo, DeepSeek-R) put output in reasoning_content.
        // Merge so downstream code (synthesis, summary) can read it.
        let safeContent =
          response.content || (response as { reasoning_content?: string }).reasoning_content || '';
        try {
          const scanResult = await this.deps.getContentScanner().scan(safeContent);
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
        const outputFormat = this.deps.getConfig().outputFormat ?? 'auto';
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
            getGlobalLogger().warn(
              'AgentRuntime',
              'Terminal degeneration guard: sanitizing safeContent',
              {
                description: rep.description,
              },
            );
            safeContent =
              '[Output truncated: model degeneration detected — ' + rep.description + ']';
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
          const modelCfg = this.deps.getRouter().getModel(routing.modelId);
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
        await this.deps.getCheckpointingPhase().checkpointTerminal(ctx, state, 'completed', {
          request,
          attempt,
          stepNumber: steps.length,
          exitSummary: result.summary,
        });

        if (this.deps.getMemory()) {
          try {
            const _memContent2 = `[SUCCESS] ${ctx.goal.slice(0, GOAL_TELEMETRY_MAX_CHARS)}`;
            // Security (OWASP ASI07): Memory poisoning detection gate.
            const _poisoningCheck2 = checkMemoryPoisoning(
              _memContent2,
              `agent:${ctx.agentId}`,
              ctx.agentId,
            );
            if (!_poisoningCheck2.allowed) {
              getGlobalLogger().warn('AgentRuntime', 'Memory write blocked by poisoning gate', {
                reason: _poisoningCheck2.reason,
              });
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
                this.deps
                  .getMemory()!
                  .add(
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
        this.deps.getRunTelemetryRecorder().recordSuccess({
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
        this.deps.onCircuitReleased();
        return result;
      }

      // Handle failure with error classification
      // Use the preserved provider error for accurate classification,
      // falling back to lastError or a generic message.
      const errorToClassify =
        this.deps.getLastProviderError() ?? new Error(lastError || 'Unknown error');
      const ce = classifyLLMError(errorToClassify);
      lastError = ce.message;
      lastErrorIsPermanent = !ce.retryable;
      // Reset for the next attempt
      this.deps.setLastProviderError(null);
      tracer.recordError(runId, `${ce.errorClass}: ${ce.message}`, Date.now() - startTime);

      if (ce.retryable && attempt < this.deps.getConfig().maxRetries) {
        const delayMs =
          ce.retryAfter ?? computeBackoff(attempt, this.deps.getConfig().retryDelayMs);
        await delay(delayMs);
      } else if (!ce.retryable) {
        this.deps.getCircuitBreaker().onFailure();
        init.circuitReleased = true;
        this.deps.onCircuitReleased();
        break; // Don't retry permanent errors
      }
    }

    // Record failure telemetry (trace error, actual cost, model
    // performance, onError hooks, terminal checkpoint, failure memory
    // with poisoning gate, run-complete metrics, agent.failed bus event,
    // agent intelligence, meta-learner experience, failure-pattern
    // learner) - extracted to RunTelemetryRecorder.recordFailure(),
    // which returns the failed AgentExecutionResult.
    return await this.deps.getRunTelemetryRecorder().recordFailure({
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
}
