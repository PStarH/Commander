import { AgentRuntime, getMetricsCollector } from '../../src';
import type { LLMProvider, LLMRequest, LLMResponse, Tool } from '../../src';

const hugeOutput = 'x'.repeat(12000);
const tool: Tool = {
  definition: {
    name: 'truncator',
    description: 'x',
    inputSchema: { type: 'object', properties: {} },
  },
  async execute() {
    return hugeOutput;
  },
};
const provider: LLMProvider = {
  name: 'mock',
  async call(): Promise<LLMResponse> {
    return {
      content: '',
      model: 'm',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls',
      toolCalls: [{ id: '1', name: 'truncator', arguments: {} }],
    };
  },
};
async function main() {
  const rt = new AgentRuntime({ maxRetries: 0, maxConcurrency: 1 });
  rt.registerProvider('openai', provider);
  rt.registerTool('truncator', tool);
  const before = getMetricsCollector().getCounterTotal('tool_truncations_total');
  const result = await rt.execute({
    agentId: 't',
    projectId: 'd',
    goal: 'g',
    contextData: {},
    availableTools: ['truncator'],
    maxSteps: 3,
    tokenBudget: 4000,
  });
  const after = getMetricsCollector().getCounterTotal('tool_truncations_total');
  console.log('status', result.status, 'before', before, 'after', after);
}
main().catch(console.error);
