/**
 * RunTelemetryRecorder — Extracted telemetry recording for agent run outcomes.
 *
 * Both the success and failure tails of `AgentRuntime.execute()`'s retry loop
 * record the same kinds of signals (plugin hooks, run-complete metrics, bus
 * events, circuit-breaker state, memory with a poisoning gate, agent
 * intelligence, and meta-learner experience). They were previously inlined as
 * ~150/180-line blocks inside the god-object execute() method.
 *
 * This module owns that recording so AgentRuntime stays an orchestrator.
 */
import type {
  AgentExecutionContext,
  AgentExecutionResult,
  AgentExecutionStep,
  LLMRequest,
  RoutingDecision,
  TokenUsage,
} from './types';
import type { CostEstimate } from './costEstimator';
import type { ModelRouter } from './modelRouter';
import type { CircuitBreaker } from './circuitBreaker';
import type { RunHandle } from '../atr/scheduler';
import type { ThreeLayerMemory } from '../threeLayerMemory';
import type { AgentExecutionState } from './phases/AgentExecutionState';
import type { CheckpointingPhase } from './phases/checkpointing';

import { getMessageBus } from './messageBus';
import { getTraceRecorder } from './executionTrace';
import { getMetricsCollector } from './metricsCollector';
import { getHookManager } from '../pluginManager';
import { getAgentIntelligence } from '../intelligence/agentIntegration';
import { getMetaLearner } from '../selfEvolution/metaLearner';
import { getFailurePatternLearner } from '../intelligence/failurePatterns';
import { getExecutionScheduler } from '../atr/scheduler';
import { getCostEstimator } from './costEstimator';
import { getModelPerformanceStore } from './modelPerformanceStore';
import { checkMemoryPoisoning } from '../security/memoryPoisoningGate';
import { getGlobalTenantProvider } from './tenantProvider';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import { GOAL_RESULT_MAX_CHARS, GOAL_TELEMETRY_MAX_CHARS } from './runtimeConstants';

/**
 * Constructor dependencies. All are getters so the recorder always observes the
 * runtime's *current* instance state (e.g. `runHandle` is assigned mid-run).
 */
export interface RunTelemetryRecorderDeps {
  getMemory: () => ThreeLayerMemory | null;
  getRouter: () => ModelRouter;
  getCircuitBreaker: () => CircuitBreaker;
  getRunHandle: () => RunHandle | null;
  getCheckpointingPhase: () => CheckpointingPhase;
  getMaxRetries: () => number;
}

/** Params shared by both success and failure recording paths. */
export interface RunTelemetryCommonParams {
  ctx: AgentExecutionContext;
  runId: string;
  routing: RoutingDecision;
  taskType: string;
  totalTokens: TokenUsage;
  steps: AgentExecutionStep[];
  startTime: number;
  tenantId: string | undefined;
  costEstimate: CostEstimate;
}

export interface RecordSuccessParams extends RunTelemetryCommonParams {
  /** The already-constructed success result (its `summary` is published on the bus). */
  result: AgentExecutionResult;
}

export interface RecordFailureParams extends RunTelemetryCommonParams {
  lastError: string | undefined;
  lastErrorIsPermanent: boolean;
  /** Mutable execution state — updated with final tokens/steps/error before the terminal checkpoint. */
  state: AgentExecutionState;
  /** The LLM request, persisted into the terminal checkpoint payload. */
  request: LLMRequest;
}

export class RunTelemetryRecorder {
  constructor(private readonly deps: RunTelemetryRecorderDeps) {}

  /**
   * Records telemetry for a successful agent run.
   *
   * Fires plugin `onAgentComplete` hooks, emits the run-complete metric,
   * publishes `agent.completed` on the bus, marks the circuit breaker
   * successful, records agent-intelligence (postTask) and meta-learner
   * experience, and commits the run with the execution scheduler.
   *
   * The caller is responsible for flipping its `circuitReleased` flag and
   * returning the success `result` — both happen *after* this call so that a
   * thrown metric/bus call leaves the circuit unreleased, matching the prior
   * inlined behaviour.
   */
  recordSuccess(params: RecordSuccessParams): void | Promise<void> {
    const { ctx, runId, routing, taskType, result, totalTokens, steps, startTime, tenantId } =
      params;
    const totalDurationMs = Date.now() - startTime;
    const bus = getMessageBus();
    const memory = this.deps.getMemory();

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
      projectId: ctx.projectId,
      missionId: ctx.missionId,
      summary: result.summary,
      tokenUsage: totalTokens,
      durationMs: totalDurationMs,
    });

    this.deps.getCircuitBreaker().onSuccess();

    // Record success memory via active memory manager when available.
    // Fire-and-forget: AgentRuntime serializes execute() on a single active-run
    // flag, so we must not block the return path on async telemetry. We still
    // return the observe promise so tests can await it.
    let memoryPromise: Promise<void> | undefined;
    if (memory) {
      const _memContent = `[SUCCESS] ${ctx.goal.slice(0, GOAL_TELEMETRY_MAX_CHARS)}`;
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
        memoryPromise = memory
          .observe({
            content: _memContent,
            context: `run:${runId}|tokens:${totalTokens.totalTokens}|dur:${totalDurationMs}ms|steps:${steps.length}`,
            importance: 0.7,
            tags: ['execution', 'success', ...ctx.availableTools.slice(0, 3)],
          })
          .then(() => undefined)
          .catch((e) => {
            getGlobalLogger().warn('AgentRuntime', 'Failed to record success memory', {
              error: (e as Error)?.message,
            });
          });
      }
    }

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

    const runHandle = this.deps.getRunHandle();
    if (runHandle) {
      try {
        getExecutionScheduler().commitRun({
          runId,
          leaseToken: runHandle.leaseToken,
          fencingEpoch: runHandle.fencingEpoch,
          tenantId: getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
        });
      } catch (e) {
        getGlobalLogger().debug('AgentRuntime', 'Scheduler commitRun failed', {
          runId,
          error: (e as Error).message,
        });
      }
    }

    return memoryPromise;
  }

  /**
   * Records telemetry for a failed agent run (all retry attempts exhausted)
   * and returns the failed {@link AgentExecutionResult}.
   *
   * Records the trace error, final actual cost + model-performance outcome,
   * fires plugin `onError` hooks, writes the terminal checkpoint, records
   * failure memory (behind the poisoning gate), emits the run-complete metric,
   * publishes `agent.failed` on the bus, records agent-intelligence (postTask),
   * meta-learner experience, and the failure-pattern learner entry.
   */
  async recordFailure(params: RecordFailureParams): Promise<AgentExecutionResult> {
    const {
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
    } = params;
    const maxRetries = this.deps.getMaxRetries();
    const bus = getMessageBus();
    const tracer = getTraceRecorder();
    const costEstimator = getCostEstimator();
    const router = this.deps.getRouter();
    const memory = this.deps.getMemory();

    // All attempts failed
    tracer.recordError(runId, `All ${maxRetries + 1} attempts failed`, Date.now() - startTime);

    // Record final actual cost for failed run (for estimator learning)
    try {
      const modelCfg = router.getModel(routing.modelId);
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
      router.recordOutcome(
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

    state.totalTokenUsage = totalTokens;
    state.steps = steps;
    state.lastError = lastError;
    await this.deps.getCheckpointingPhase().checkpointTerminal(ctx, state, 'failed', {
      request,
      attempt: maxRetries,
      stepNumber: steps.length,
      lastError,
      exitSummary: lastError,
    });

    if (memory) {
      try {
        const _memContent3 = `[FAIL] ${ctx.goal.slice(0, GOAL_TELEMETRY_MAX_CHARS)}`;
        // Security (OWASP ASI07): Memory poisoning detection gate.
        const _poisoningCheck3 = checkMemoryPoisoning(
          _memContent3,
          `agent:${ctx.agentId}`,
          ctx.agentId,
        );
        if (!_poisoningCheck3.allowed) {
          getGlobalLogger().warn('AgentRuntime', 'Memory write blocked by poisoning gate', {
            reason: _poisoningCheck3.reason,
          });
        } else {
          await memory.observe({
            content: _memContent3,
            context: `run:${runId}|error:${(lastError ?? 'unknown').slice(0, 100)}|dur:${Date.now() - startTime}ms`,
            importance: 0.5 + (lastErrorIsPermanent ? 0.3 : 0),
            tags: ['execution', 'failure', ...ctx.availableTools.slice(0, 3)],
          });
        } // end poisoning gate else
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
      projectId: ctx.projectId,
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
  }
}
