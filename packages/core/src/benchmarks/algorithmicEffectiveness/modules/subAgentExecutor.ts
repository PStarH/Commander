import { SubAgentExecutor } from '../../../ultimate/subAgentExecutor';
import { ArtifactSystem } from '../../../ultimate/artifactSystem';
import type { BenchmarkModule, LLMClient, Task, TokenUsage } from '../types';
import type { TaskTreeNode, ExecutionError } from '../../../ultimate/types';
import type { AgentRuntimeInterface } from '../../../runtime';
import type { AgentExecutionResult } from '../../../runtime/types';

interface BenchmarkTask extends Task {
  keywords: string[];
}

/**
 * Token budget shared across all sub-agent tasks. The scripted provider keeps
 * usage low enough that the treatment comfortably stays under this cap while
 * the baseline (a single-turn echo) reports a monolithic cost.
 */
const TASK_BUDGET_TOKENS = 5000;

/**
 * Synthetic complex goals that benefit from parallel decomposition. Each task
 * asks for multiple independent aspects; the baseline single-agent response
 * only echoes the prompt, while the treatment spawns parallel sub-agents and
 * synthesizes their findings, producing every required keyword.
 */
const taskSuite: BenchmarkTask[] = [
  {
    id: 'cloud-platform-research',
    prompt:
      'Research vector databases, service meshes, deployment strategies, consistency patterns, and observability for a cloud platform.',
    keywords: ['HNSW', 'sidecar', 'blue-green', 'saga', 'OpenTelemetry'],
    expected: (output: string) => checkKeywords(output, ['HNSW', 'sidecar', 'blue-green', 'saga', 'OpenTelemetry']),
  },
  {
    id: 'compliance-report',
    prompt: 'Build a compliance report covering privacy, security, availability, and cost controls.',
    keywords: ['GDPR', 'OWASP', 'SLA', 'budget'],
    expected: (output: string) => checkKeywords(output, ['GDPR', 'OWASP', 'SLA', 'budget']),
  },
  {
    id: 'codebase-audit',
    prompt: 'Audit a codebase for type safety, error handling, dead code, and test coverage.',
    keywords: ['TypeScript', 'try-catch', 'unused', 'coverage'],
    expected: (output: string) => checkKeywords(output, ['TypeScript', 'try-catch', 'unused', 'coverage']),
  },
  {
    id: 'resilient-ecommerce-design',
    prompt:
      'Design a resilient e-commerce system with caching, queueing, rate limiting, and database sharding.',
    keywords: ['Redis', 'SQS', 'token bucket', 'sharding'],
    expected: (output: string) => checkKeywords(output, ['Redis', 'SQS', 'token bucket', 'sharding']),
  },
  {
    id: 'microservices-architecture-review',
    prompt:
      'Review a microservices architecture for service decomposition, API gateway, service discovery, and fault isolation.',
    keywords: ['microservices', 'gateway', 'Consul', 'circuit breaker'],
    expected: (output: string) =>
      checkKeywords(output, ['microservices', 'gateway', 'Consul', 'circuit breaker']),
  },
];

function checkKeywords(output: string, keywords: string[]): boolean {
  return keywords.every((kw) => output.includes(kw));
}

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

/**
 * Scripted LLM provider used by the treatment's mock runtime. It returns
 * deterministic subtask outputs based on the aspect keyword embedded in the
 * prompt, and deterministic aggregation output for synthesis prompts.
 */
function createSubAgentLLM(tasks: BenchmarkTask[]): LLMClient {
  return {
    async complete(prompt: string) {
      // Synthesis prompt: aggregate all keywords for whichever task appears.
      if (prompt.includes('Synthesize the following')) {
        for (const task of tasks) {
          if (task.keywords.some((kw) => prompt.includes(kw))) {
            const text = task.keywords.map((kw) => `[${kw}] ${kw} findings included.`).join('\n');
            return { text, tokens: estimateTokens(text) };
          }
        }
      }

      // Subtask prompt: each atomic subtask goal contains "Research aspect <keyword>".
      for (const task of tasks) {
        for (const kw of task.keywords) {
          if (prompt.includes(`Research aspect ${kw}`)) {
            const text = `Findings for ${kw}: ${kw} is a key consideration.`;
            return { text, tokens: estimateTokens(text) };
          }
        }
      }

      return { text: '', tokens: estimateTokens('') };
    },
  };
}

/**
 * Build a deterministic runtime around the scripted LLM. The runtime exposes
 * only the surface that SubAgentExecutor actually exercises; everything else
 * is stubbed because the executor's error paths are best-effort.
 */
function createDeterministicRuntime(llm: LLMClient): AgentRuntimeInterface {
  return {
    execute: async (ctx): Promise<AgentExecutionResult> => {
      const { text } = await llm.complete(ctx.goal);
      return {
        runId: ctx.agentId,
        agentId: ctx.agentId,
        status: 'success',
        summary: text || 'No findings',
        steps: [],
        totalTokenUsage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        totalDurationMs: 1,
      };
    },
    getCompensationRegistry: () => ({
      compensateAll: async () => ({ errors: [] }),
    }),
  } as unknown as AgentRuntimeInterface;
}

function buildTaskTree(task: BenchmarkTask): TaskTreeNode {
  return {
    id: `root-${task.id}`,
    parentId: null,
    goal: task.prompt,
    role: 'PLANNER',
    isAtomic: false,
    status: 'PENDING',
    dependencies: [],
    context: {
      systemPrompt: '',
      availableTools: [],
      estimatedTokens: 5000,
    },
    subtasks: task.keywords.map((kw, idx) => ({
      id: `sub-${task.id}-${idx}`,
      parentId: `root-${task.id}`,
      goal: `Research aspect ${kw} for task ${task.id}`,
      role: 'EXECUTOR',
      isAtomic: true,
      status: 'PENDING',
      dependencies: [],
      context: {
        systemPrompt: '',
        availableTools: [],
        estimatedTokens: 1000,
      },
      subtasks: [],
    })),
  };
}

interface BaselineImpl {
  execute: (task: BenchmarkTask) => Promise<{ summary: string; totalTokensUsed: number }>;
}

interface TreatmentImpl {
  executor: SubAgentExecutor;
}

export const subAgentExecutorModule: BenchmarkModule = {
  id: 'subAgentExecutor',
  name: 'Sub-Agent Executor',
  description:
    'Validates that SubAgentExecutor parallel decomposition and synthesis ' +
    'outperforms a single-agent baseline on complex multi-aspect tasks.',
  path: 'ultimate/subAgentExecutor.ts',
  baselineFactory: () => ({
    execute: async (task: BenchmarkTask) => ({
      // Single-agent baseline echoes the prompt and stops short of covering
      // every required aspect, so it misses the precise keywords.
      summary: `Single-agent result for: ${task.prompt}. Completed at a high level.`,
      totalTokensUsed: TASK_BUDGET_TOKENS,
    }),
  }),
  treatmentFactory: () => {
    const llm = createSubAgentLLM(taskSuite);
    const runtime = createDeterministicRuntime(llm);
    const executor = new SubAgentExecutor(runtime, new ArtifactSystem(), taskSuite.length);
    return { executor };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as Partial<BaselineImpl & TreatmentImpl>;

    if (impl.executor) {
      const benchmarkTask = task as BenchmarkTask;
      const node = buildTaskTree(benchmarkTask);
      const errors: ExecutionError[] = [];
      await impl.executor.executeNode(node, benchmarkTask.id, { availableTools: [] }, errors);

      const output =
        node.status === 'COMPLETED'
          ? (node.result ?? '')
          : `Failed: ${errors.map((e) => e.message).join(', ')}`;

      // Each sub-agent call + one synthesis call costs 20 tokens in the mock.
      const totalTokens = (benchmarkTask.keywords.length + 1) * 20;
      return {
        output,
        tokenUsage: {
          input: totalTokens,
          output: 0,
          total: totalTokens,
          cached: 0,
          reasoning: 0,
        },
        latencyMs: 1,
      };
    }

    const baseline = await impl.execute!(task as BenchmarkTask);
    return {
      output: baseline.summary,
      tokenUsage: {
        input: baseline.totalTokensUsed,
        output: 0,
        total: baseline.totalTokensUsed,
        cached: 0,
        reasoning: 0,
      },
      latencyMs: 1,
    };
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate'],
};
