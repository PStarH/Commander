import { ModelCascadeController } from '../../../telos/modelCascadeController';
import { HeuristicEvaluator } from '../../../telos/evaluator';
import { ModelRouter } from '../../../runtime/modelRouter';
import type { BenchmarkModule, Task, TokenUsage } from '../types';
import type { LLMRequest, LLMResponse, ModelConfig, RoutingDecision } from '../../../runtime/types';

/**
 * Two-model registry for the cascade benchmark.
 * - cheap-model: eco tier, very low cost, produces low-quality output on hard tasks.
 * - strong-model: power tier, expensive, always produces high-quality output.
 */
const CHEAP_MODEL: ModelConfig = {
  id: 'cheap-model',
  provider: 'mock',
  tier: 'eco',
  costPer1MInput: 0.5,
  costPer1MOutput: 1.5,
  capabilities: ['code', 'analysis'],
  contextWindow: 128000,
  priority: 0,
};

const STRONG_MODEL: ModelConfig = {
  id: 'strong-model',
  provider: 'mock',
  tier: 'power',
  costPer1MInput: 10,
  costPer1MOutput: 40,
  capabilities: ['code', 'reasoning', 'analysis'],
  contextWindow: 128000,
  priority: 0,
};

const MODELS = [CHEAP_MODEL, STRONG_MODEL];

/**
 * Token footprints used by the benchmark runner's cost model.
 * The strong model is two orders of magnitude more expensive than the cheap model.
 */
const CHEAP_TOKENS: TokenUsage = {
  input: 50,
  output: 5,
  total: 55,
  cached: 0,
  reasoning: 0,
};

const STRONG_TOKENS: TokenUsage = {
  input: 1000,
  output: 500,
  total: 1500,
  cached: 0,
  reasoning: 0,
};

/**
 * Simple requests where the cheap model's answer is just long and structured
 * enough to pass the heuristic quality gate.
 */
const CHEAP_PASSES: Record<string, string> = {
  'greet-user':
    'Hello! How can I help you today? I am ready to assist with any questions you might have.',
  'define-term':
    'It is a type of software system where multiple autonomous agents collaborate to achieve shared goals.',
};

/**
 * Complex requests where the cheap model produces short or unsafe output that
 * fails the heuristic gate, forcing escalation to the strong model.
 */
const CHEAP_FAILS: Record<string, string> = {
  'summarize-paragraph': 'hack',
  'explain-concept': 'malicious draft',
  'solve-problem': 'bypass details',
};

function makeRequest(task: Task): LLMRequest {
  return {
    model: 'mock',
    messages: [{ role: 'user', content: task.prompt }],
  };
}

function makeRouting(model: ModelConfig, estimatedCost: number): RoutingDecision {
  return {
    modelId: model.id,
    tier: model.tier,
    provider: model.provider,
    reasoning: ['benchmark routing'],
    estimatedCost,
    maxTokens: 1000,
  };
}

function getCheapResponse(task: Task): LLMResponse {
  const content = CHEAP_PASSES[task.id] ?? CHEAP_FAILS[task.id] ?? 'incomplete hack';
  return {
    content,
    model: CHEAP_MODEL.id,
    usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 },
    finishReason: 'stop',
  };
}

function getStrongResponse(task: Task): LLMResponse {
  const content = `Here is a comprehensive, well-structured, and detailed response for "${task.prompt}". It includes complete reasoning, thorough analysis, and addresses all aspects of the request fully.`;
  return {
    content,
    model: STRONG_MODEL.id,
    usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
    finishReason: 'stop',
  };
}

interface BaselineImpl {
  execute: (task: Task) => { output: string; tokenUsage: TokenUsage; latencyMs: number };
}

interface TreatmentImpl {
  execute: (task: Task) => Promise<{ output: string; tokenUsage: TokenUsage; latencyMs: number }>;
}

const taskSuite: Task[] = [
  {
    id: 'greet-user',
    prompt: 'Greet a returning user and offer assistance.',
    expected: (output: string) => output.endsWith(':passed:true'),
  },
  {
    id: 'define-term',
    prompt: 'Define the term "multi-agent orchestration".',
    expected: (output: string) => output.endsWith(':passed:true'),
  },
  {
    id: 'summarize-paragraph',
    prompt: 'Summarize this long paragraph covering the history of machine learning.',
    expected: (output: string) => output.endsWith(':passed:true'),
  },
  {
    id: 'explain-concept',
    prompt: 'Explain the concept of attention mechanisms in transformers with examples.',
    expected: (output: string) => output.endsWith(':passed:true'),
  },
  {
    id: 'solve-problem',
    prompt: 'Solve this multi-step reasoning puzzle and show your work.',
    expected: (output: string) => output.endsWith(':passed:true'),
  },
];

export const modelCascadeControllerModule: BenchmarkModule = {
  id: 'modelCascadeController',
  name: 'Model Cascade Controller',
  description:
    'Validates that a FrugalGPT-style model cascade meets the quality threshold at significantly lower cost than always routing to the strongest model.',
  path: 'telos/modelCascadeController.ts',
  baselineFactory: () =>
    ({
      execute: (task: Task) => {
        // Baseline: always use the strong model, no quality gating.
        const response = getStrongResponse(task);
        return {
          output: `selected:${response.model}:passed:true`,
          tokenUsage: STRONG_TOKENS,
          latencyMs: 1,
        };
      },
    }) as BaselineImpl,
  treatmentFactory: () => {
    const router = new ModelRouter(MODELS);
    const evaluator = new HeuristicEvaluator({ passThreshold: 0.67 });
    const controller = new ModelCascadeController(router, evaluator, 0.67);

    return {
      execute: async (task: Task) => {
        const request = makeRequest(task);
        const initialRouting = makeRouting(CHEAP_MODEL, 0.0001);

        const result = await controller.executeCascade(
          request,
          initialRouting,
          [STRONG_MODEL],
          async (_req, routing) => {
            // Scripted provider: cheap model first, strong model on escalation.
            if (routing.modelId === CHEAP_MODEL.id) {
              return getCheapResponse(task);
            }
            return getStrongResponse(task);
          },
        );

        const modelId = result.selectedRouting?.modelId ?? 'failed';
        const passed = !result.exhausted;
        const tokenUsage = modelId === CHEAP_MODEL.id ? CHEAP_TOKENS : STRONG_TOKENS;

        return {
          output: `selected:${modelId}:passed:${passed}`,
          tokenUsage,
          latencyMs: 1,
        };
      },
    } as TreatmentImpl;
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as BaselineImpl | TreatmentImpl;
    return impl.execute(task);
  },
  taskSuite,
  metrics: ['successRate'],
};
