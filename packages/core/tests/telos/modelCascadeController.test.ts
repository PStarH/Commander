import { describe, it, expect, beforeEach } from 'vitest';
import { ModelCascadeController } from '../../src/telos/modelCascadeController';
import { HeuristicEvaluator } from '../../src/telos/evaluator';
import type { LLMRequest, LLMResponse, RoutingDecision } from '../../src/runtime/types';
import type { ModelConfig } from '../../src/runtime/types';
import { getMetricsCollector } from '../../src/runtime/metricsCollector';

function makeRouting(modelId: string, tier = 'eco', estimatedCost = 0.001): RoutingDecision {
  return {
    modelId,
    tier: tier as import('../../src/runtime/types').ModelTier,
    provider: 'mock',
    reasoning: ['test'],
    estimatedCost,
    maxTokens: 1000,
  };
}

function makeModel(id: string, tier = 'standard', input = 0.003, output = 0.01): ModelConfig {
  return {
    id,
    provider: 'mock',
    tier: tier as import('../../src/runtime/types').ModelTier,
    costPer1KInput: input,
    costPer1KOutput: output,
    capabilities: ['code'],
    contextWindow: 128000,
    priority: 0,
  };
}

function makeResponse(content: string, promptTokens = 100, completionTokens = 50): LLMResponse {
  return {
    content,
    model: 'mock',
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    finishReason: 'stop',
  };
}

function makeRequest(content: string): LLMRequest {
  return {
    model: 'mock',
    messages: [{ role: 'user', content }],
  };
}

describe('ModelCascadeController', () => {
  beforeEach(() => {
    getMetricsCollector().reset();
  });

  it('selects the first model when it passes the quality gate', async () => {
    const router = {} as import('../../src/runtime/modelRouter').ModelRouter;
    const evaluator = new HeuristicEvaluator({ passThreshold: 0.5 });
    const controller = new ModelCascadeController(router, evaluator, 0.5);

    const request = makeRequest('hello');
    const initial = makeRouting('gpt-4o-mini', 'eco', 0.001);
    const chain: ModelConfig[] = [makeModel('gpt-4o', 'standard', 0.003, 0.01)];

    const result = await controller.executeCascade(request, initial, chain, async () =>
      makeResponse('A well-structured, detailed response that addresses the request fully.'),
    );

    expect(result.exhausted).toBe(false);
    expect(result.escalations).toBe(0);
    expect(result.selectedRouting?.modelId).toBe('gpt-4o-mini');
    expect(result.attempts).toHaveLength(1);
    expect(result.costSavedUsd).toBeGreaterThan(0);

    const saved = getMetricsCollector().getCounterTotal('cascade_cost_saved_usd');
    expect(saved).toBeGreaterThan(0);
  });

  it('escalates once when the first model fails and the second passes', async () => {
    const router = {} as import('../../src/runtime/modelRouter').ModelRouter;
    const evaluator = new HeuristicEvaluator({ passThreshold: 0.7 });
    const controller = new ModelCascadeController(router, evaluator, 0.7);

    const request = makeRequest('hello');
    const initial = makeRouting('gpt-4o-mini', 'eco', 0.001);
    const chain: ModelConfig[] = [makeModel('gpt-4o', 'standard', 0.003, 0.01)];

    let call = 0;
    const result = await controller.executeCascade(request, initial, chain, async () => {
      call++;
      return call === 1
        ? makeResponse('bad') // too short, fails completeness
        : makeResponse('A comprehensive and well-structured response with complete reasoning.');
    });

    expect(result.exhausted).toBe(false);
    expect(result.escalations).toBe(1);
    expect(result.selectedRouting?.modelId).toBe('gpt-4o');
    expect(result.attempts).toHaveLength(2);

    const attempts = getMetricsCollector().getCounterTotal('cascade_attempts_total');
    expect(attempts).toBe(2);
  });

  it('returns exhausted when every model fails the gate', async () => {
    const router = {} as import('../../src/runtime/modelRouter').ModelRouter;
    const evaluator = new HeuristicEvaluator({ passThreshold: 0.95 });
    const controller = new ModelCascadeController(router, evaluator, 0.95);

    const request = makeRequest('hello');
    const initial = makeRouting('cheap');
    const chain: ModelConfig[] = [makeModel('mid'), makeModel('expensive', 'power', 0.01, 0.03)];

    const result = await controller.executeCascade(
      request,
      initial,
      chain,
      async () => makeResponse(' mediocre '), // low completeness + clarity
    );

    expect(result.exhausted).toBe(true);
    expect(result.attempts).toHaveLength(3);
    expect(result.costSavedUsd).toBe(0);
  });

  it('continues past a null response and uses the next model', async () => {
    const router = {} as import('../../src/runtime/modelRouter').ModelRouter;
    const evaluator = new HeuristicEvaluator({ passThreshold: 0.5 });
    const controller = new ModelCascadeController(router, evaluator, 0.5);

    const request = makeRequest('hello');
    const initial = makeRouting('cheap');
    const chain: ModelConfig[] = [makeModel('claude-sonnet-4-6', 'standard', 0.003, 0.015)];

    let call = 0;
    const result = await controller.executeCascade(request, initial, chain, async () => {
      call++;
      return call === 1
        ? null
        : makeResponse('A comprehensive and well-structured response with complete reasoning.');
    });

    expect(result.exhausted).toBe(false);
    expect(result.selectedRouting?.modelId).toBe('claude-sonnet-4-6');
  });
});
