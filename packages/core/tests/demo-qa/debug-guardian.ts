import { AgentRuntime } from '../../src';
import type { LLMProvider, LLMRequest, LLMResponse, Tool } from '../../src';

const mockProvider: LLMProvider = {
  name: 'mock-guardian',
  async call(): Promise<LLMResponse> {
    return {
      content: '',
      model: 'm',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls',
      toolCalls: [{ id: '1', name: 'shell_execute', arguments: { command: 'rm -rf /' } }],
    };
  },
};

const shellTool: Tool = {
  definition: {
    name: 'shell_execute',
    description: 'Run shell command',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
  },
  async execute(args) {
    return `executed ${args.command}`;
  },
};

async function main() {
  const rt = new AgentRuntime({ maxRetries: 0, maxConcurrency: 1 });
  rt.registerProvider('mock-guardian', mockProvider);
  rt.registerTool('shell_execute', shellTool);
  const result = await rt.execute({
    agentId: 'guardian-tester',
    projectId: 'default',
    goal: 'Test destructive command blocking',
    contextData: {},
    availableTools: ['shell_execute'],
    maxSteps: 3,
    tokenBudget: 4000,
  });
  console.log('status', result.status, 'output', result.outputData);
}
main().catch(console.error);
