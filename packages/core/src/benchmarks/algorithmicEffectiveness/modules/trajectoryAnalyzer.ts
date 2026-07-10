import { TrajectoryAnalyzer } from '../../../selfEvolution/trajectoryAnalyzer';
import type {
  BenchmarkModule,
  LLMClient,
  Task,
  TokenUsage,
} from '../types';
import type { TokenUsage as RuntimeTokenUsage } from '../../../runtime/types';
import type {
  ExecutionExperience,
  EvolutionInsight,
  FailureCategory,
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '../../../runtime/types';

/**
 * Benchmark module for TrajectoryAnalyzer.
 *
 * Baseline: light mode heuristic keyword classification. It is tripped up by
 * synthetic trajectories that contain confounding keywords from an earlier
 * classifier rule (e.g. an auth failure that also mentions "timeout").
 *
 * Treatment: thorough mode with a scripted LLM provider that classifies every
 * failure by its true category. No real API calls are made.
 */

interface TrajectoryTaskSpec {
  id: string;
  prompt: string;
  expectedCategory: FailureCategory;
  experience: ExecutionExperience;
}

const taskSpecs: TrajectoryTaskSpec[] = [
  {
    id: 'auth-masked-by-timeout',
    prompt: 'Classify an authentication failure whose error text also mentions a timeout',
    expectedCategory: 'authentication',
    experience: {
      id: 'auth-masked-by-timeout',
      runId: 'run-auth-1',
      agentId: 'agent-a',
      taskType: 'api-call',
      modelUsed: 'gpt-4o',
      strategyUsed: 'direct',
      success: false,
      durationMs: 5000,
      tokenCost: 120,
      errorPattern:
        'OAuth authentication request timed out before the token could be refreshed',
      lessons: ['verify token lifecycle'],
      toolsUsed: ['http'],
      timestamp: '2024-01-01T00:00:00Z',
    },
  },
  {
    id: 'hallucination-masked-by-tool-error',
    prompt: 'Classify a hallucination that invents a tool error excuse',
    expectedCategory: 'hallucination',
    experience: {
      id: 'hallucination-masked-by-tool-error',
      runId: 'run-hall-1',
      agentId: 'agent-b',
      taskType: 'research',
      modelUsed: 'gpt-4o',
      strategyUsed: 'iterative',
      success: false,
      durationMs: 3000,
      tokenCost: 200,
      errorPattern:
        "Model invented a 'command not found' tool error to explain its failure",
      lessons: ['verify tool existence before calling'],
      toolsUsed: ['search'],
      timestamp: '2024-01-01T00:00:00Z',
    },
  },
  {
    id: 'timeout-masked-by-rate-limit',
    prompt: 'Classify a timeout that is masked by rate-limit keywords',
    expectedCategory: 'timeout',
    experience: {
      id: 'timeout-masked-by-rate-limit',
      runId: 'run-to-1',
      agentId: 'agent-c',
      taskType: 'batch-job',
      modelUsed: 'gpt-4o-mini',
      strategyUsed: 'parallel',
      success: false,
      durationMs: 31000,
      tokenCost: 80,
      errorPattern: 'Request throttled by rate limit and eventually timed out',
      lessons: ['add client-side deadline'],
      toolsUsed: ['batch'],
      timestamp: '2024-01-01T00:00:00Z',
    },
  },
  {
    id: 'missing-capability-masked-by-auth',
    prompt: 'Classify a missing-capability failure masked by auth keywords',
    expectedCategory: 'missing_capability',
    experience: {
      id: 'missing-capability-masked-by-auth',
      runId: 'run-mc-1',
      agentId: 'agent-d',
      taskType: 'filesystem',
      modelUsed: 'gpt-4o',
      strategyUsed: 'direct',
      success: false,
      durationMs: 1500,
      tokenCost: 90,
      errorPattern:
        "Required tool is not installed and command returned 'permission denied'",
      lessons: ['install dependencies'],
      toolsUsed: ['bash'],
      timestamp: '2024-01-01T00:00:00Z',
    },
  },
  {
    id: 'data-validation-masked-by-resource',
    prompt: 'Classify a data-validation failure masked by resource-exhaustion keywords',
    expectedCategory: 'data_validation',
    experience: {
      id: 'data-validation-masked-by-resource',
      runId: 'run-dv-1',
      agentId: 'agent-e',
      taskType: 'parse',
      modelUsed: 'gpt-4o-mini',
      strategyUsed: 'direct',
      success: false,
      durationMs: 800,
      tokenCost: 60,
      errorPattern: 'Schema violation caused a stack overflow in the parser',
      lessons: ['validate against schema'],
      toolsUsed: ['parser'],
      timestamp: '2024-01-01T00:00:00Z',
    },
  },
];

const taskSuite: Task[] = taskSpecs.map((spec) => ({
  id: spec.id,
  prompt: spec.prompt,
  expected: (output: string) => {
    try {
      const insights = JSON.parse(output) as EvolutionInsight[];
      const first = insights[0];
      if (!first) return false;
      return first.failureCategory === spec.expectedCategory;
    } catch {
      return false;
    }
  },
}));

const experiences: Record<string, ExecutionExperience> = Object.fromEntries(
  taskSpecs.map((spec) => [spec.id, spec.experience]),
);

function estimateTokens(text: string): TokenUsage {
  const total = Math.max(1, Math.ceil(text.length / 4));
  return {
    input: 0,
    output: total,
    total,
    cached: 0,
    reasoning: 0,
  };
}

function toRuntimeTokenUsage(tokens: TokenUsage): RuntimeTokenUsage {
  return {
    promptTokens: tokens.input,
    completionTokens: tokens.output,
    totalTokens: tokens.total,
    cacheReadTokens: tokens.cached,
    cacheWriteTokens: 0,
  };
}

function classifyByPrompt(prompt: string): FailureCategory {
  if (prompt.includes('OAuth authentication request timed out')) {
    return 'authentication';
  }
  if (prompt.includes("Model invented a 'command not found' tool error")) {
    return 'hallucination';
  }
  if (prompt.includes('throttled by rate limit and eventually timed out')) {
    return 'timeout';
  }
  if (prompt.includes('Required tool is not installed')) {
    return 'missing_capability';
  }
  if (prompt.includes('Schema violation caused a stack overflow')) {
    return 'data_validation';
  }
  return 'unclassified';
}

function createScriptedClassifier(): LLMClient {
  return {
    async complete(prompt: string) {
      const category = classifyByPrompt(prompt);
      const answer = JSON.stringify({
        category,
        confidence: 0.95,
        evidence: [category],
        suggestion: 'address root cause',
      });
      return { text: answer, tokens: estimateTokens(answer) };
    },
  };
}

function createProvider(llm: LLMClient): LLMProvider {
  return {
    name: 'scripted-llm-adapter',
    async call(req: LLMRequest): Promise<LLMResponse> {
      const prompt = req.messages
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n\n');
      const { text, tokens } = await llm.complete(prompt, { model: req.model });
      return {
        content: text,
        model: req.model ?? 'scripted',
        usage: toRuntimeTokenUsage(tokens),
        finishReason: 'stop' as const,
      };
    },
  };
}

interface TrajectoryAnalyzerImplementation {
  analyze: (task: Task) => Promise<EvolutionInsight[]>;
}

export const trajectoryAnalyzerModule: BenchmarkModule = {
  id: 'trajectoryAnalyzer',
  name: 'Trajectory Analyzer',
  description:
    'Validates that thorough LLM-based trajectory analysis correctly classifies failure modes that heuristic light mode misclassifies.',
  path: 'selfEvolution/trajectoryAnalyzer.ts',
  baselineFactory: () => {
    const analyzer = new TrajectoryAnalyzer('light');
    return {
      analyze: async (task: Task) => analyzer.analyze([experiences[task.id]]),
    };
  },
  treatmentFactory: () => {
    const scriptedLLM = createScriptedClassifier();
    const provider = createProvider(scriptedLLM);
    const analyzer = new TrajectoryAnalyzer('thorough', provider, 'scripted');
    return {
      analyze: async (task: Task) => analyzer.analyze([experiences[task.id]]),
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as TrajectoryAnalyzerImplementation;
    const insights = await impl.analyze(task);
    const output = JSON.stringify(insights);
    return {
      output,
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite,
  metrics: ['successRate'],
};
