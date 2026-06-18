/**
 * End-to-end agent loop tests — tests the full LLM → Tool → LLM cycle.
 *
 * Uses MockLLMProvider to simulate LLM responses with tool calls,
 * verifying the agent runtime correctly orchestrates multi-step execution.
 *
 * Inspired by Codex CLI's wiremock pattern: test the full agent behavior
 * through realistic mock interactions rather than isolated unit tests.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import type {
  AgentExecutionContext,
  LLMResponse,
  Tool,
  ToolDefinition,
} from '../../src/runtime/types';

// ── Tool call mock provider ──────────────────────────────────────────────────

/**
 * Extended mock provider that can return tool calls in sequence.
 * Simulates the LLM → tool call → tool result → LLM → final answer cycle.
 */
class ToolCallMockProvider extends MockLLMProvider {
  private responses: LLMResponse[] = [];
  private responseIndex = 0;
  public toolCallHistory: Array<{ name: string; args: Record<string, unknown> }> = [];

  setResponseSequence(responses: LLMResponse[]): void {
    this.responses = responses;
    this.responseIndex = 0;
  }

  async call(request: import('../../src/runtime/types').LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    this.lastRequest = request;

    if (this.responseIndex < this.responses.length) {
      const resp = this.responses[this.responseIndex++];
      // Track tool calls
      if (resp.toolCalls) {
        for (const tc of resp.toolCalls) {
          this.toolCallHistory.push({
            name: tc.name,
            args: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments,
          });
        }
      }
      return resp;
    }

    return super.call(request);
  }

  reset(): void {
    super.reset();
    this.responses = [];
    this.responseIndex = 0;
    this.toolCallHistory = [];
  }
}

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
  return {
    agentId: 'test-agent',
    projectId: 'test-project',
    goal: 'Test task',
    contextData: { governanceProfile: { riskLevel: 'LOW' } },
    availableTools: ['echo_tool'],
    maxSteps: 5,
    tokenBudget: 8000,
    ...overrides,
  };
}

function makeToolResponse(name: string, args: Record<string, unknown>): LLMResponse {
  return {
    content: '',
    model: 'mock',
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    finishReason: 'tool_calls',
    toolCalls: [
      {
        id: `call_${Date.now()}`,
        name,
        arguments: JSON.stringify(args),
      },
    ],
  };
}

function makeTextResponse(content: string): LLMResponse {
  return {
    content,
    model: 'mock',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    finishReason: 'stop',
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Agent Loop E2E', () => {
  let runtime: AgentRuntime;
  let provider: ToolCallMockProvider;
  let router: ModelRouter;

  beforeEach(() => {
    resetModelRouter();
    resetMessageBus();
    resetTraceRecorder();
    resetGlobalThreeLayerMemory();
    router = new ModelRouter();
    runtime = new AgentRuntime({ maxRetries: 1, timeoutMs: 10000 }, router);
    provider = new ToolCallMockProvider('openai', { defaultResponse: 'Done.' });
    runtime.registerProvider('openai', provider);

    // Register a simple echo tool
    const echoDef: ToolDefinition = {
      name: 'echo_tool',
      description: 'Echoes the input back',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    };
    const echoTool: Tool = {
      definition: echoDef,
      execute: async (args) => `Echo: ${args.message}`,
    };
    runtime.registerTool('echo_tool', echoTool);
  });

  // ── Simple text response ───────────────────────────────────────────────────

  describe('simple text response', () => {
    it('completes with a single LLM call for simple tasks', async () => {
      provider.setResponseSequence([makeTextResponse('The answer is 42.')]);

      const result = await runtime.execute(
        makeContext({
          goal: 'What is the answer?',
          availableTools: [],
        }),
      );

      assert.strictEqual(result.status, 'success');
      assert.strictEqual(provider.callCount, 1);
      assert.ok(result.summary.includes('42'));
    });

    it('tracks token usage across calls', async () => {
      provider.setResponseSequence([makeTextResponse('Done.')]);

      const result = await runtime.execute(
        makeContext({
          goal: 'Simple task',
          availableTools: [],
        }),
      );

      assert.ok(result.totalTokenUsage.totalTokens > 0);
      assert.ok(result.totalTokenUsage.promptTokens > 0);
      assert.ok(result.totalTokenUsage.completionTokens > 0);
    });
  });

  // ── Tool call cycle ────────────────────────────────────────────────────────

  describe('tool call cycle', () => {
    it('executes tool calls and returns final answer', async () => {
      provider.setResponseSequence([
        makeToolResponse('echo_tool', { message: 'hello' }),
        makeTextResponse('The tool said: Echo: hello'),
      ]);

      const result = await runtime.execute(
        makeContext({
          goal: 'Echo hello and tell me the result',
        }),
      );

      assert.strictEqual(result.status, 'success');
      assert.strictEqual(provider.callCount, 2); // 1 for tool call + 1 for final answer
      assert.strictEqual(provider.toolCallHistory.length, 1);
      assert.strictEqual(provider.toolCallHistory[0].name, 'echo_tool');
    });

    it('handles multiple sequential tool calls', async () => {
      provider.setResponseSequence([
        makeToolResponse('echo_tool', { message: 'first' }),
        makeToolResponse('echo_tool', { message: 'second' }),
        makeTextResponse('Both calls completed.'),
      ]);

      const result = await runtime.execute(
        makeContext({
          goal: 'Echo two messages',
        }),
      );

      assert.strictEqual(result.status, 'success');
      assert.ok(provider.callCount >= 2); // At least 2 LLM calls
    });
  });

  // ── Max steps enforcement ──────────────────────────────────────────────────

  describe('max steps enforcement', () => {
    it('stops after maxSteps is reached', async () => {
      // Create a provider that always returns tool calls (never finishes)
      const infiniteProvider = new ToolCallMockProvider('openai');
      const responses: LLMResponse[] = [];
      for (let i = 0; i < 20; i++) {
        responses.push(makeToolResponse('echo_tool', { message: `step-${i}` }));
      }
      infiniteProvider.setResponseSequence(responses);

      const infiniteRuntime = new AgentRuntime({ maxRetries: 1, timeoutMs: 10000 }, router);
      infiniteRuntime.registerProvider('openai', infiniteProvider);
      infiniteRuntime.registerTool('echo_tool', {
        definition: {
          name: 'echo_tool',
          description: 'Echo',
          parameters: { type: 'object', properties: {} },
        },
        execute: async () => 'echo',
      });

      const result = await infiniteRuntime.execute(
        makeContext({
          goal: 'Keep going forever',
          maxSteps: 3,
        }),
      );

      // Should stop due to maxSteps, not run all 20
      assert.ok(
        infiniteProvider.callCount <= 7,
        `Expected <= 7 calls (3 steps × 2 max per step + margin), got ${infiniteProvider.callCount}`,
      );
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('handles tool execution errors gracefully', async () => {
      // Register a failing tool
      const failDef: ToolDefinition = {
        name: 'fail_tool',
        description: 'Always fails',
        parameters: { type: 'object', properties: {} },
      };
      runtime.registerTool('fail_tool', {
        definition: failDef,
        execute: async () => {
          throw new Error('Tool exploded');
        },
      });

      provider.setResponseSequence([
        makeToolResponse('fail_tool', {}),
        makeTextResponse('The tool failed, but I can still respond.'),
      ]);

      const result = await runtime.execute(
        makeContext({
          goal: 'Use the failing tool',
          availableTools: ['fail_tool'],
        }),
      );

      // Runtime should handle the error and continue
      assert.ok(result.status === 'success' || result.status === 'partial');
    });

    it('handles LLM provider errors', async () => {
      const errorProvider = new MockLLMProvider('error-provider');
      errorProvider.setDefaultResponse('This should not be reached');

      // Override the call to throw
      const originalCall = errorProvider.call.bind(errorProvider);
      errorProvider.call = async (req) => {
        if (errorProvider.callCount === 1) {
          errorProvider.callCount++;
          throw new Error('API rate limited');
        }
        return originalCall(req);
      };

      const errorRuntime = new AgentRuntime({ maxRetries: 1, timeoutMs: 10000 }, router);
      errorRuntime.registerProvider('openai', errorProvider);
      errorRuntime.registerTool('echo_tool', {
        definition: {
          name: 'echo_tool',
          description: 'Echo',
          parameters: { type: 'object', properties: {} },
        },
        execute: async () => 'echo',
      });

      const result = await errorRuntime.execute(
        makeContext({
          goal: 'Test error recovery',
        }),
      );

      // Should handle error gracefully (success, partial, or failed)
      assert.ok(['success', 'partial', 'failed'].includes(result.status));
    });
  });

  // ── Execution trace ────────────────────────────────────────────────────────

  describe('execution trace', () => {
    it('records execution steps', async () => {
      provider.setResponseSequence([
        makeToolResponse('echo_tool', { message: 'trace test' }),
        makeTextResponse('Done with trace test.'),
      ]);

      const result = await runtime.execute(
        makeContext({
          goal: 'Test tracing',
        }),
      );

      assert.ok(result.steps.length > 0);
      // Should have at least a response step
      const responseSteps = result.steps.filter((s) => s.type === 'response');
      assert.ok(responseSteps.length > 0);
    });
  });

  // ── Duration tracking ──────────────────────────────────────────────────────

  describe('duration tracking', () => {
    it('tracks total execution duration', async () => {
      provider.setResponseSequence([makeTextResponse('Quick response.')]);

      const result = await runtime.execute(
        makeContext({
          goal: 'Quick task',
          availableTools: [],
        }),
      );

      assert.ok(result.totalDurationMs >= 0);
    });
  });
});
