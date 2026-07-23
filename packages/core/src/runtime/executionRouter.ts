/**
 * Extracted from AgentRuntime.execute() to shrink the god method.
 *
 * Responsible for Phase 1 of execute(): model routing with cascade awareness,
 * Batch API routing, privacy routing (sensitive content detection + local
 * model fallback), and pre-run cost estimation.
 *
 * Returns a discriminated union: either 'proceed' with all routing data, or
 * 'cancelled' with a summary string (when privacy check blocks execution).
 */
import type { AgentExecutionContext, RoutingDecision } from './types';
import type { ModelConfig } from './types/routing';
import type { ModelTier } from './types';
import { ModelRouter } from './modelRouter';
import type { SmartModelRouter } from './smartModelRouter';
import type { TokenGovernor } from './tokenGovernor';
import type { ExecutionTraceRecorder as TraceRecorder } from './executionTrace';
import type { MessageBus } from './messageBus';
import type { CostEstimate } from './costEstimator';
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from './runtimeConstants';
import { getPrivacyRouter } from './privacyRouter';
import { getCostEstimator } from './costEstimator';
import { getMetricsCollector } from './metricsCollector';
import { getIntentLog } from './intentLog';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExecutionRouterDeps {
  getSmartRouter: () => SmartModelRouter | null;
  isSmartRouterActive: () => boolean;
  getRouter: () => ModelRouter;
  getGovernor: () => TokenGovernor;
  getProviders: () => Map<string, unknown>;
  /** Optional: inject for unit tests (Vitest 4 ESM mocks do not reliably intercept named imports). */
  getPrivacyRouter?: () => ReturnType<typeof getPrivacyRouter>;
  /** Optional: inject for unit tests (same ESM mock isolation reason). */
  getCostEstimator?: () => ReturnType<typeof getCostEstimator>;
}

export interface RouteParams {
  ctx: AgentExecutionContext;
  runId: string;
  tenantId?: string;
  bus: MessageBus;
  tracer: TraceRecorder;
}

export type RouteResult =
  | {
      status: 'proceed';
      routing: RoutingDecision;
      escalationChain: ModelConfig[];
      batchRouting: RoutingDecision | undefined;
      costEstimate: CostEstimate;
    }
  | {
      status: 'cancelled';
      summary: string;
    };

// ── ExecutionRouter ──────────────────────────────────────────────────────────

export class ExecutionRouter {
  constructor(private readonly deps: ExecutionRouterDeps) {}

  async route(params: RouteParams): Promise<RouteResult> {
    const { ctx, runId, tenantId, bus, tracer } = params;
    const router = this.deps.getRouter();
    const governor = this.deps.getGovernor();
    const smartRouter = this.deps.getSmartRouter();
    const smartRouterActive = this.deps.isSmartRouterActive();
    const providers = this.deps.getProviders();

    // 1. Route to optimal model with FrugalGPT cascade awareness
    let routing: RoutingDecision;
    let currentEscalationChain: ModelConfig[];

    if (smartRouter && smartRouterActive) {
      const smartResult = smartRouter.route(ctx, {
        governorPhase: governor.getState().phase,
        registeredProviders: new Set(providers.keys()),
        preferredTier: ctx.preferredModelTier,
      });
      routing = smartResult;
      currentEscalationChain = (smartResult.escalationChain ?? []).map(
        (id) =>
          (smartRouter.getModel(id) as ModelConfig | undefined) ?? {
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
      const { initial: cascadeInitial, escalationChain } = router.routeWithCascade(
        ctx,
        governor.getState().phase,
        ctx.preferredModelTier,
        new Set(providers.keys()),
      );
      routing = cascadeInitial;
      currentEscalationChain = escalationChain;
    }

    // Batch API routing for non-time-sensitive tasks (50% cost savings)
    let batchRouting: RoutingDecision | undefined;
    if (ModelRouter.isBatchEligible(ctx) && governor.getState().phase !== 'critical') {
      const batchModel = router.routeBatch(ctx, routing.tier);
      if (batchModel) {
        const estimatedInputTokens = Math.ceil(ctx.goal.length / 4) + 2048;
        const estimatedOutputTokens = Math.min(
          ctx.tokenBudget,
          batchModel.contextWindow - estimatedInputTokens,
        );
        const standardCost =
          (estimatedInputTokens / 1_000_000) * batchModel.costPer1MInput +
          (estimatedOutputTokens / 1_000_000) * batchModel.costPer1MOutput;
        const batchCost = standardCost * 0.5; // 50% batch discount
        batchRouting = {
          modelId: batchModel.id,
          tier: batchModel.tier,
          provider: batchModel.provider,
          reasoning: [
            ...routing.reasoning,
            `batch_api: 50% cost savings via ${batchModel.provider}/${batchModel.id}`,
            `batch_max_batch_size: ${batchModel.maxBatchSize ?? 'unlimited'}`,
          ],
          estimatedCost: batchCost,
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
          estimatedSavings: `${Math.round((standardCost - batchCost) * 100) / 100}`,
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
        }
      }
    }

    tracer.recordDecision(
      runId,
      `routed to ${routing.modelId} (${routing.tier}) cascade=${currentEscalationChain.length > 0}${batchRouting ? ' [BATCH]' : ''}`,
      0,
    );

    // ── Privacy Routing ──
    try {
      const privacy = (this.deps.getPrivacyRouter ?? getPrivacyRouter)();
      const decision = await privacy.checkContent(ctx.goal, {
        agentId: ctx.agentId,
        runId,
      });

      if (decision.blocked) {
        const summary = `PRIVACY_BLOCKED: ${decision.reason}`;
        tracer.recordDecision(runId, summary, 0);
        bus.publish('agent.failed', ctx.agentId, {
          runId,
          projectId: ctx.projectId,
          error: summary,
        });
        try {
          getMetricsCollector().incrementCounter('privacy_blocks_total', 'Privacy blocks', 1, []);
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:1495');
        }
        return { status: 'cancelled', summary };
      }

      if (decision.route === 'local') {
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
        }
      }
    } catch (e) {
      getGlobalLogger().warn('AgentRuntime', 'Privacy check failed', {
        error: (e as Error)?.message,
      });
    }

    // Pre-run cost estimation
    const costEstimator = (this.deps.getCostEstimator ?? getCostEstimator)();
    const costEstimate: CostEstimate = costEstimator.estimateBeforeRun(
      ctx,
      routing,
      router.getModel(routing.modelId),
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
    }

    return {
      status: 'proceed',
      routing,
      escalationChain: currentEscalationChain,
      batchRouting,
      costEstimate,
    };
  }
}
