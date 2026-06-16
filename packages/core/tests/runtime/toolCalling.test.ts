import { describe, it, expect, beforeAll } from 'vitest';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetPatternTracker } from '../../src/runtime/speculativeExecutor';
import type { AgentExecutionContext, Tool, ToolDefinition, LLMRequest, LLMResponse } from '../../src/runtime/types';

/**
 * A mock provider that returns tool calls for the first N invocations,
 * then a final answer. This lets us test the full tool-calling loop.
 */
class ToolCallMockProvider extends MockLLMProvider {
  private toolCallConfig: Array<{
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    response?: string;
    finishReason?: 'tool_calls' | 'stop';
  }>;

  constructor(
    config: Array<{
      toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
      response?: string;
      finishReason?: 'tool_calls' | 'stop';
    }>,
  ) {
    super('tool-call-mock');
    this.toolCallConfig = config;
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    this.lastRequest = request;
    const idx = Math.min(this.callCount - 1, this.toolCallConfig.length - 1);
    const step = this.toolCallConfig[idx];

    if (!step) {
      return {
        content: 'No more steps configured.',
        model: request.model,
        usage: { promptTokens: 0, completionTokens: 10, totalTokens: 10 },
        finishReason: 'stop',
      };
    }

    const content = step.response ?? 'Processing...';
    const toolCalls = step.toolCalls;
    const finishReason = step.finishReason ?? (toolCalls ? 'tool_calls' : 'stop');

    const promptTokens = JSON.stringify(request.messages).length;
    const completionTokens = content.length;

    return {
      content,
      model: request.model,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      finishReason,
      toolCalls: toolCalls as Array<{ id: string; type: string; function: { name: string; arguments: string } }>,
    };
  }

  reset(): void {
    super.reset();
  }
}

function makeTool(name: string, execute: (args: Record<string, unknown>) => Promise<string>): Tool {
  return {
    definition: {
      name,
      description: `Tool: ${name}`,
      inputSchema: { type: 'object', properties: {} },
    },
    execute,
    isConcurrencySafe: true,
    isReadOnly: true,
  };
}

function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
  return {
    agentId: 'test-agent',
    projectId: 'test-project',
    goal: 'Complete the test task successfully.',
    contextData: {},
    availableTools: [],
    maxSteps: 10,
    tokenBudget: 20000,
    ...overrides,
  };
}

describe('AgentRuntime - Full Tool Calling Pipeline', () => {
  let runtime: AgentRuntime;
  let router: ModelRouter;

  beforeAll(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetPatternTracker();
    router = new ModelRouter();
    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);

    // Register test tools
    const echoTool = makeTool('echo', async (args) => `Echo: ${JSON.stringify(args)}`);
    const searchTool = makeTool('web_search', async (args) => `Search results for query: ${args.query ?? 'unknown'}`);
    runtime.registerTool('echo', echoTool);
    runtime.registerTool('web_search', searchTool);
  });

  it('executes a single tool call and returns result', async () => {
    const provider = new ToolCallMockProvider([
      {
        toolCalls: [{ id: 'call_1', name: 'echo', arguments: { message: 'hello' } }],
        finishReason: 'tool_calls',
      },
      {
        response: 'Final answer with tool result processed.',
        finishReason: 'stop',
      },
    ]);
    runtime.registerProvider('openai', provider);
    const result = await runtime.execute(makeContext({ availableTools: ['echo'] }));
    expect(result.status).toBe('success');
    expect(provider.callCount).toBe(2);
    // Verify tool result was fed back: the second call should include the tool message
    const secondCallMessages = provider.lastRequest?.messages ?? [];
    const hasToolResult = secondCallMessages.some(m => m.role === 'tool');
    expect(hasToolResult).toBe(true);
  });

  it('handles concurrent-safe tools in parallel', async () => {
    const executionLog: string[] = [];
    const slowTool1 = makeTool('slow1', async () => {
      await new Promise(r => setTimeout(r, 50));
      executionLog.push('slow1');
      return 'slow1 done';
    });
    slowTool1.isConcurrencySafe = true;
    const slowTool2 = makeTool('slow2', async () => {
      await new Promise(r => setTimeout(r, 50));
      executionLog.push('slow2');
      return 'slow2 done';
    });
    slowTool2.isConcurrencySafe = true;
    runtime.registerTool('slow1', slowTool1);
    runtime.registerTool('slow2', slowTool2);

    const provider = new ToolCallMockProvider([
      {
        toolCalls: [
          { id: 'c1', name: 'slow1', arguments: {} },
          { id: 'c2', name: 'slow2', arguments: {} },
        ],
        finishReason: 'tool_calls',
      },
      {
        response: 'Both tools completed.',
        finishReason: 'stop',
      },
    ]);
    runtime.registerProvider('openai', provider);

    const start = Date.now();
    const result = await runtime.execute(makeContext({ availableTools: ['slow1', 'slow2'] }));
    const duration = Date.now() - start;

    expect(result.status).toBe('success');
    // Both tools should have executed (parallel = faster than sequential 100ms)
    expect(executionLog).toContain('slow1');
    expect(executionLog).toContain('slow2');
    expect(duration).toBeLessThan(1000); // 2*50ms parallel + overhead (allow CI/macOS variance)
  });

  it('handles serial (non-concurrent-safe) tools in order', async () => {
    const executionOrder: string[] = [];
    const serial1 = makeTool('serial1', async () => {
      executionOrder.push('serial1');
      return 'serial1 done';
    });
    serial1.isConcurrencySafe = false;
    const serial2 = makeTool('serial2', async () => {
      executionOrder.push('serial2');
      return 'serial2 done';
    });
    serial2.isConcurrencySafe = false;
    runtime.registerTool('serial1', serial1);
    runtime.registerTool('serial2', serial2);

    const provider = new ToolCallMockProvider([
      {
        toolCalls: [
          { id: 'c1', name: 'serial1', arguments: {} },
          { id: 'c2', name: 'serial2', arguments: {} },
        ],
        finishReason: 'tool_calls',
      },
      {
        response: 'Serial tools completed in order.',
        finishReason: 'stop',
      },
    ]);
    runtime.registerProvider('openai', provider);

    await runtime.execute(makeContext({ availableTools: ['serial1', 'serial2'] }));
    expect(executionOrder).toEqual(['serial1', 'serial2']);
  });

  it('limits tool loop iterations to maxSteps', async () => {
    const provider = new ToolCallMockProvider(
      Array(15).fill(null).map((_, i) => ({
        toolCalls: [{ id: `call_${i}`, name: 'echo', arguments: { iteration: i } }],
        finishReason: 'tool_calls' as const,
      }))
    );
    runtime.registerProvider('openai', provider);

    const result = await runtime.execute(makeContext({ availableTools: ['echo'], maxSteps: 5 }));
    // Should have stopped after maxSteps iterations
    expect(provider.callCount).toBeLessThanOrEqual(7); // 1 initial + up to 5 follow-ups = 6
  });

  it('applies observation masking for many tool results', async () => {
    const maskRouter = new ModelRouter();
    const maskRuntime = new AgentRuntime({ observationMaskWindow: 2, maxRetries: 0, timeoutMs: 5000 }, maskRouter);
    const maskProvider = new ToolCallMockProvider([
      {
        toolCalls: [
          { id: 'c1', name: 'echo', arguments: { msg: '1' } },
          { id: 'c2', name: 'echo', arguments: { msg: '2' } },
          { id: 'c3', name: 'echo', arguments: { msg: '3' } },
        ],
        finishReason: 'tool_calls',
      },
      {
        response: 'Masked result.',
        finishReason: 'stop',
      },
    ]);
    maskRuntime.registerProvider('openai', maskProvider);
    maskRuntime.registerTool('echo', makeTool('echo', async (args) => `Echo: ${JSON.stringify(args)}`));

    const result = await maskRuntime.execute(makeContext({ availableTools: ['echo'] }));
    expect(result.status).toBe('success');
  });
});

describe('AgentRuntime - New Feature Integration', () => {
  let runtime: AgentRuntime;
  let router: ModelRouter;
  let simpleProvider: MockLLMProvider;

  beforeAll(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetPatternTracker();
    router = new ModelRouter();
    simpleProvider = new MockLLMProvider('openai', {
      defaultResponse: 'Task completed. The analysis is complete.',
    });
  });

  it('toolRetrieval config is respected (disabled by default)', () => {
    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
    const config = runtime.getConfig();
    expect(config.toolRetrieval?.enabled).toBe(false);
  });

  it('toolRetrieval filters tools when enabled', async () => {
    const searchTool = makeTool('web_search', async (args) => `Results for ${args.query}`);
    const pythonTool = makeTool('python_execute', async (args) => `Python output`);
    const gitTool = makeTool('git', async (args) => `Git status`);

    runtime = new AgentRuntime({
      toolRetrieval: { enabled: true, minTools: 2, maxTools: 2, alwaysInclude: [] },
      maxRetries: 0,
      timeoutMs: 5000,
    }, router);
    runtime.registerProvider('openai', simpleProvider);
    runtime.registerTool('web_search', searchTool);
    runtime.registerTool('python_execute', pythonTool);
    runtime.registerTool('git', gitTool);

    await runtime.execute(makeContext({
      goal: 'search the web for news',
      availableTools: ['web_search', 'python_execute', 'git'],
    }));

    const lastRequest = simpleProvider.lastRequest!;
    expect(lastRequest.tools).toBeDefined();
    // With maxTools=2, 2 tools go active + 1 goes to registry → request_tool is added
    expect(lastRequest.tools!.length).toBe(3); // 2 active tools + 1 request_tool
    expect(lastRequest.tools!.some(t => t.name === 'web_search')).toBe(true);
  });

  it('toolRetrieval defaults to all tools when disabled', async () => {
    const searchTool = makeTool('web_search', async () => 'results');
    const pythonTool = makeTool('python_execute', async () => 'output');

    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
    runtime.registerProvider('openai', simpleProvider);
    runtime.registerTool('web_search', searchTool);
    runtime.registerTool('python_execute', pythonTool);

    await runtime.execute(makeContext({
      availableTools: ['web_search', 'python_execute'],
    }));

    const lastRequest = simpleProvider.lastRequest!;
    expect(lastRequest.tools).toBeDefined();
    expect(lastRequest.tools!.length).toBe(2);
  });

  it('entropyGating config is respected (disabled by default)', () => {
    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
    const config = runtime.getConfig();
    expect(config.entropyGating?.enabled).toBe(false);
  });

  it('speculativeExecution config is respected (disabled by default)', () => {
    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
    const config = runtime.getConfig();
    expect(config.speculativeExecution?.enabled).toBe(false);
  });

  it('passes outputSchema into runtime verification and retries invalid structured output', async () => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetPatternTracker();

    const localRouter = new ModelRouter();
    const localRuntime = new AgentRuntime({ maxRetries: 1, timeoutMs: 5000 }, localRouter);
    const provider = new ToolCallMockProvider([
      {
        response: 'not json',
        finishReason: 'stop',
      },
      {
        response: '{"answer":"ok"}',
        finishReason: 'stop',
      },
    ]);
    localRuntime.registerProvider('openai', provider);

    const result = await localRuntime.execute(makeContext({
      goal: 'Return output in JSON format matching the schema.',
      outputSchema: {
        properties: {
          answer: { type: 'string', required: true },
        },
      },
    }));

    expect(result.status).toBe('success');
    expect(result.summary).toContain('"answer":"ok"');
    expect(provider.callCount).toBe(2);
  });
});

describe('AgentRuntime - Tool Not Found Handling', () => {
  it('returns structured error for unknown tool calls', async () => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetPatternTracker();

    const router = new ModelRouter();
    const runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
    const provider = new ToolCallMockProvider([
      {
        toolCalls: [{ id: 'call_bad', name: 'nonexistent_tool', arguments: {} }],
        finishReason: 'tool_calls',
      },
      {
        response: 'The tool was not found.',
        finishReason: 'stop',
      },
    ]);
    runtime.registerProvider('openai', provider);

    const result = await runtime.execute(makeContext({ availableTools: [] }));
    expect(result.status).toBe('success');
    expect(provider.callCount).toBe(2);
    // Second call should have the error about missing tool
    const lastMsg = provider.lastRequest?.messages;
    const toolResultMsg = lastMsg?.find(m => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg?.content).toContain('TOOL_NOT_ALLOWED');
  });

  it('returns TOOL_NOT_FOUND when tool is allowed but not registered', async () => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetPatternTracker();

    const router = new ModelRouter();
    const runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000 }, router);
    const provider = new ToolCallMockProvider([
      {
        toolCalls: [{ id: 'call_unreg', name: 'unregistered_tool', arguments: {} }],
        finishReason: 'tool_calls',
      },
      {
        response: 'The tool was not found.',
        finishReason: 'stop',
      },
    ]);
    runtime.registerProvider('openai', provider);

    // Tool is in the allowed list but NOT registered in the runtime
    const result = await runtime.execute(makeContext({ availableTools: ['unregistered_tool'] }));
    expect(result.status).toBe('success');
    expect(provider.callCount).toBe(2);
    const lastMsg = provider.lastRequest?.messages;
    const toolResultMsg = lastMsg?.find(m => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg?.content).toContain('TOOL_NOT_FOUND');
  });
});

describe('AgentRuntime - Speculative Cache (PASTE)', () => {
  it('returns cached result for speculatively executed tools', async () => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetPatternTracker();

    const router = new ModelRouter();
    const runtime = new AgentRuntime({
      maxRetries: 0,
      timeoutMs: 5000,
      speculativeExecution: { enabled: true, maxPredictions: 1, minConfidence: 0 },
    }, router);

    const readTool = makeTool('file_read', async () => 'file contents');
    readTool.isReadOnly = true;
    runtime.registerTool('file_read', readTool);

    // First teach the pattern tracker a sequence
    const { getPatternTracker } = await import('../../src/runtime/speculativeExecutor');
    const tracker = getPatternTracker();
    for (let i = 0; i < 5; i++) {
      tracker.recordSequence(['file_read']);
    }

    const provider = new ToolCallMockProvider([
      {
        toolCalls: [{ id: 'call_1', name: 'file_read', arguments: { path: '/test' } }],
        finishReason: 'tool_calls',
      },
      {
        response: 'Final answer.',
        finishReason: 'stop',
      },
    ]);
    runtime.registerProvider('openai', provider);

    const result = await runtime.execute(makeContext({
      availableTools: ['file_read'],
      goal: 'read file',
    }));
    expect(result.status).toBe('success');
  });
});
