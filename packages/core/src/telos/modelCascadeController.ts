/**
 * ModelCascadeController — quality-gated FrugalGPT-style escalation.
 *
 * Instead of escalating only on provider errors, this controller tries the
 * cheapest capable model first, runs a fast heuristic evaluation on the output,
 * and escalates to stronger models only when the quality gate fails.
 *
 * Exposes cascade savings metrics via MetricsCollector.
 */
import { reportSilentFailure } from '../silentFailureReporter';
import type {
  AgentExecutionResult,
  LLMRequest,
  LLMResponse,
  RoutingDecision,
} from '../runtime/types';
import type { ModelConfig } from '../runtime/types';
import { HeuristicEvaluator } from './evaluator';
import { ModelRouter } from '../runtime/modelRouter';
import { getCostEstimator } from '../runtime/costEstimator';
import { getMetricsCollector } from '../runtime/metricsCollector';
import { getGlobalLogger } from '../logging';

export interface CascadeAttempt {
  attemptNumber: number;
  routing: RoutingDecision;
  response: LLMResponse | null;
  evaluation: import('./evaluator').EvaluationResult;
  costUsd: number;
}

export interface CascadeResult {
  response: LLMResponse | null;
  selectedRouting: RoutingDecision | null;
  attempts: CascadeAttempt[];
  escalations: number;
  costSavedUsd: number;
  exhausted: boolean;
}

export class ModelCascadeController {
  private router: ModelRouter;
  private evaluator: HeuristicEvaluator;
  private threshold: number;

  constructor(router: ModelRouter, evaluator: HeuristicEvaluator, threshold = 0.67) {
    this.router = router;
    this.evaluator = evaluator;
    this.threshold = threshold;
  }

  /**
   * Execute a quality-gated model cascade.
   *
   * @param request         The LLM request to send.
   * @param initialRouting  First (cheapest/optimal) model routing decision.
   * @param escalationChain Ordered list of stronger models to try on quality failure.
   * @param callProvider    Function that invokes the actual provider for a routing decision.
   * @param tenantId        Optional tenant for metrics.
   */
  async executeCascade(
    request: LLMRequest,
    initialRouting: RoutingDecision,
    escalationChain: ModelConfig[],
    callProvider: (req: LLMRequest, routing: RoutingDecision) => Promise<LLMResponse | null>,
    tenantId?: string,
  ): Promise<CascadeResult> {
    const chainRoutings = escalationChain.map((m) => this.modelConfigToRouting(m, initialRouting));
    const attemptRoutings = [initialRouting, ...chainRoutings];

    const attempts: CascadeAttempt[] = [];
    let lastResponse: LLMResponse | null = null;
    let lastRouting: RoutingDecision | null = null;
    let escalations = 0;
    const startMs = Date.now();

    for (let i = 0; i < attemptRoutings.length; i++) {
      const routing = attemptRoutings[i];
      const attemptNumber = i + 1;
      const isLast = i === attemptRoutings.length - 1;

      // Augment request with escalation feedback so the next model knows why
      // it is being asked (cheap way to improve stronger-model outputs).
      const augmentedRequest = this.buildRequestForAttempt(request, attempts);

      let response: LLMResponse | null;
      try {
        response = await callProvider(augmentedRequest, routing);
      } catch (err) {
        getGlobalLogger().debug('ModelCascadeController', 'Provider call failed', {
          attempt: attemptNumber,
          model: routing.modelId,
          error: (err as Error)?.message,
        });
        response = null;
      }

      if (response) {
        lastResponse = response;
        lastRouting = routing;
      }

      const costUsd = response
        ? this.estimateCost(
            routing.modelId,
            response.usage.promptTokens,
            response.usage.completionTokens,
          )
        : 0;

      const evaluation = this.evaluator.evaluate(
        this.responseToResult(request, response, routing.modelId),
      );

      getMetricsCollector().recordCascadeAttempt(
        attemptNumber,
        routing.modelId,
        evaluation.passed,
        tenantId,
      );

      const attempt: CascadeAttempt = {
        attemptNumber,
        routing,
        response,
        evaluation,
        costUsd,
      };
      attempts.push(attempt);

      if (response && evaluation.passed) {
        const baselineCost = this.mostExpensiveCost(
          attemptRoutings,
          response.usage.promptTokens,
          response.usage.completionTokens,
        );
        const costSavedUsd = Math.max(0, baselineCost - costUsd);
        if (costSavedUsd > 0) {
          getMetricsCollector().recordCascadeCostSaved(costSavedUsd, tenantId);
        }

        getMetricsCollector().recordStepLatency(
          'cascade_escalation',
          Date.now() - startMs,
          tenantId,
        );

        return {
          response,
          selectedRouting: routing,
          attempts,
          escalations,
          costSavedUsd,
          exhausted: false,
        };
      }

      if (!isLast) {
        escalations++;
        const nextRouting = attemptRoutings[i + 1];
        if (nextRouting) {
          getMetricsCollector().recordCascadeEscalation(
            routing.modelId,
            nextRouting.modelId,
            'quality_gate_failed',
            tenantId,
          );
        }
      }
    }

    getMetricsCollector().recordStepLatency('cascade_escalation', Date.now() - startMs, tenantId);

    return {
      response: lastResponse,
      selectedRouting: lastRouting,
      attempts,
      escalations,
      costSavedUsd: 0,
      exhausted: true,
    };
  }

  private modelConfigToRouting(model: ModelConfig, base: RoutingDecision): RoutingDecision {
    const estimatedInputTokens = Math.ceil(
      (base.estimatedCost / Math.max(base.estimatedCost, 0.00001)) * 1000,
    );
    const estimatedOutputTokens = Math.min(model.contextWindow, base.maxTokens);
    return {
      modelId: model.id,
      tier: model.tier,
      provider: model.provider,
      reasoning: [...base.reasoning, `cascade_escalation: ${model.id} (${model.tier})`],
      estimatedCost:
        (estimatedInputTokens / 1_000_000) * model.costPer1MInput +
        (estimatedOutputTokens / 1_000_000) * model.costPer1MOutput,
      maxTokens: base.maxTokens,
    };
  }

  private buildRequestForAttempt(request: LLMRequest, priorAttempts: CascadeAttempt[]): LLMRequest {
    if (priorAttempts.length === 0) return request;
    const last = priorAttempts[priorAttempts.length - 1];
    if (!last.response || last.evaluation.passed) return request;

    const feedback = `\n\n[system: previous model ${last.routing.modelId} scored ${last.evaluation.overallScore}/${last.evaluation.threshold} on quality. Escalating to a stronger model.]`;
    const messages = request.messages.map((m, idx) =>
      idx === request.messages.length - 1 && m.role === 'user'
        ? { ...m, content: m.content + feedback }
        : m,
    );
    return { ...request, messages };
  }

  private responseToResult(
    request: LLMRequest,
    response: LLMResponse | null,
    modelId: string,
  ): Pick<AgentExecutionResult, 'runId' | 'summary' | 'steps' | 'status'> {
    return {
      runId: (request as unknown as Record<string, unknown>).runId as string,
      summary: response?.content ?? `No response from ${modelId}`,
      steps: response
        ? [
            {
              stepNumber: 1,
              timestamp: new Date().toISOString(),
              type: 'response' as const,
              content: response.content,
              durationMs: 0,
              tokenUsage: response.usage,
            },
          ]
        : [],
      status: response ? 'success' : 'failed',
    };
  }

  private estimateCost(modelId: string, promptTokens: number, completionTokens: number): number {
    try {
      return getCostEstimator().estimateCostFromUsage(modelId, promptTokens, completionTokens);
    } catch (err) {
      reportSilentFailure(err, 'modelCascadeController:242');
      return 0;
    }
  }

  private mostExpensiveCost(
    routings: RoutingDecision[],
    promptTokens: number,
    completionTokens: number,
  ): number {
    let maxCost = 0;
    for (const r of routings) {
      const cost = this.estimateCost(r.modelId, promptTokens, completionTokens);
      if (cost > maxCost) maxCost = cost;
    }
    return maxCost;
  }
}
