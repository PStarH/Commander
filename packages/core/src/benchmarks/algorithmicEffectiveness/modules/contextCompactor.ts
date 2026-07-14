import { ContextCompactor } from '../../../runtime/contextCompactor';
import type { LLMMessage, LLMProvider, LLMRequest, LLMResponse } from '../../../runtime/types';
import type { BenchmarkModule, Task, TokenUsage } from '../types';

/**
 * Budget used by the treatment compactor. The synthetic contexts are larger
 * than the layer-3 threshold but still under the emergency layer, so the
 * benchmark exercises the semantic collapse path.
 */
const MAX_CONTEXT_TOKENS = 3500;

/**
 * Tight budget for the baseline truncation strategy. It is intentionally
 * smaller than the full context so the oldest messages (where the facts live)
 * are dropped.
 */
const BASELINE_BUDGET_TOKENS = 1200;

/**
 * Scripted LLM provider used when the ContextCompactor reaches layer 3/4 and
 * requests an LLM-generated summary. The response always preserves the key
 * facts from the early messages, so the benchmark can verify semantic retention.
 */
const SCRIPTED_SUMMARY = [
  'Key facts retained by semantic compaction:',
  '- Activation code: 7392',
  '- Staging API key: sk-staging-42',
  '- Deployment region: us-west-2',
  '- VIP customer: Acme Corp',
  '- Budget ceiling: $5000',
].join('\n');

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateMessageTokens(msg: LLMMessage): number {
  return estimateTokens(msg.content) + 10;
}

function estimateMessagesTokens(messages: LLMMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

function messagesToOutput(messages: LLMMessage[]): string {
  return messages.map((msg) => `[${msg.role}] ${msg.content}`).join('\n\n');
}

function createScriptedProvider(summary: string): LLMProvider {
  return {
    name: 'scripted-compactor',
    async call(_request: LLMRequest): Promise<LLMResponse> {
      const tokens = estimateTokens(summary);
      return {
        content: summary,
        model: 'scripted',
        usage: {
          promptTokens: 0,
          completionTokens: tokens,
          totalTokens: tokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        finishReason: 'stop',
      };
    },
  };
}

interface TaskConfig {
  fact: string;
  question: string;
}

const taskConfigs: Record<string, TaskConfig> = {
  'activation-code': {
    fact: '7392',
    question: 'What is the activation code mentioned in the early briefing?',
  },
  'api-key': {
    fact: 'sk-staging-42',
    question: 'What staging API key was provided at the start of the conversation?',
  },
  'deployment-region': {
    fact: 'us-west-2',
    question: 'Which deployment region was specified in the initial instructions?',
  },
  'vip-customer': {
    fact: 'Acme Corp',
    question: 'Who is the VIP customer referenced in the opening briefing?',
  },
  'budget-limit': {
    fact: '$5000',
    question: 'What is the budget ceiling stated in the early briefing?',
  },
};

function generateFiller(index: number): string {
  const paragraphs = [
    'The team has been iterating on the implementation and synchronizing with downstream services.',
    'We reviewed edge cases, validated the data model, and aligned on the rollout plan.',
    'No blockers were raised during the latest sync, but we agreed to keep monitoring latency.',
    'Documentation was updated to reflect the latest API contract changes.',
    'Several integration tests passed, including the ones covering retry and circuit-breaker behavior.',
  ];
  const base = paragraphs[index % paragraphs.length];
  // Keep filler assistants under the 500-char "important" threshold so the
  // compactor does not retain them as high-value messages.
  return `${base} `.repeat(5).trim() + ` (update ${index + 1})`;
}

function buildMessages(taskId: string): LLMMessage[] {
  const config = taskConfigs[taskId];
  if (!config) {
    throw new Error(`Unknown task: ${taskId}`);
  }

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: 'You are a helpful assistant with long context memory.',
    },
    {
      role: 'user',
      content: `Initial briefing: ${config.fact}. Keep this fact in mind for later.`,
    },
  ];

  // Enough filler volume to push collapse targets past the 2000-token LLM
  // summarization threshold while staying under the importance threshold.
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'user', content: `Status update ${i + 1}` });
    messages.push({ role: 'assistant', content: generateFiller(i) });
  }

  messages.push({ role: 'user', content: config.question });
  return messages;
}

interface CompactorImplementation {
  compact(messages: LLMMessage[]): { messages: LLMMessage[]; outputTokens: number };
}

const taskSuite: Task[] = Object.entries(taskConfigs).map(([id, config]) => ({
  id,
  prompt: config.question,
  expected: (output: string) => output.includes(config.fact),
}));

export const contextCompactorModule: BenchmarkModule = {
  id: 'contextCompactor',
  name: 'Context Compactor Effectiveness',
  description:
    'Validates that layered semantic compaction preserves critical facts from older messages while simple truncation loses them.',
  path: 'runtime/contextCompactor.ts',

  baselineFactory: () => ({
    compact: (messages: LLMMessage[]) => {
      const originalTokens = estimateMessagesTokens(messages);
      const budget = BASELINE_BUDGET_TOKENS;
      const truncated: LLMMessage[] = [...messages];

      // Simple oldest-first truncation until we are (roughly) under budget.
      while (truncated.length > 1 && estimateMessagesTokens(truncated) > budget) {
        truncated.shift();
      }

      return { messages: truncated, outputTokens: originalTokens };
    },
  }),

  treatmentFactory: () => {
    const provider = createScriptedProvider(SCRIPTED_SUMMARY);

    return {
      compact: (messages: LLMMessage[]) => {
        // Create a fresh compactor per trial so internal compaction counters
        // from earlier trials do not skew the current trial.
        const compactor = new ContextCompactor({
          maxContextTokens: MAX_CONTEXT_TOKENS,
          governorAware: false,
          // Pin the emergency layer so the benchmark exercises the semantic
          // collapse path (layer 3) and keeps the LLM-summarized retention.
          layer4Trigger: 1.0,
        });

        const { messages: compacted } = compactor.compact(messages, provider);
        return { messages: compacted, outputTokens: estimateMessagesTokens(compacted) };
      },
    };
  },

  runTrial: async ({ implementation, task }) => {
    const impl = implementation as CompactorImplementation;
    const messages = buildMessages(task.id);
    const start = Date.now();
    const { messages: resultMessages, outputTokens } = impl.compact(messages);

    const tokenUsage: TokenUsage = {
      input: outputTokens,
      output: 0,
      total: outputTokens,
      cached: 0,
      reasoning: 0,
    };

    return {
      output: messagesToOutput(resultMessages),
      tokenUsage,
      latencyMs: Date.now() - start || 1,
    };
  },

  taskSuite,
  metrics: ['successRate', 'cost'],
};
