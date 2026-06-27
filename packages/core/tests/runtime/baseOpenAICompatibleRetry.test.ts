/**
 * E2E tests for provider retry behavior through the full AgentRuntime pipeline.
 *
 * These tests exercise the real AgentRuntime.execute() call chain:
 *   LLMProvider → AgentRuntime.callProvider → retry loop → classifyLLMError
 *
 * The LLM provider is mocked (FlakyLLMProvider) to simulate 429/500 errors,
 * but everything else — retry loop, error classification, CostGuard, DLQ,
 * execution trace — is the real production code path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestRuntime,
  FlakyLLMProvider,
  makeContext,
  resetGlobalState,
} from './e2eTestHelpers';

describe('E2E: Provider retry through AgentRuntime.execute()', () => {
  beforeEach(() => {
    resetGlobalState();
  });

  it('retries on simulated 429 and succeeds via AgentRuntime', async () => {
    const { runtime, router } = createTestRuntime({ maxRetries: 3, retryDelayMs: 10 });
    const flaky = new FlakyLLMProvider({ failuresBeforeSuccess: 1, statusCode: 429 });
    runtime.registerProvider('mock', flaky);

    const result = await runtime.execute(makeContext());

    // The runtime should have retried and eventually succeeded
    expect(result.status).toBe('success');
    // Provider was called: 1 failure + 1 success = 2 calls minimum
    expect(flaky.callCount).toBeGreaterThanOrEqual(2);
  });

  it('retries on simulated 500 and succeeds via AgentRuntime', async () => {
    const { runtime } = createTestRuntime({ maxRetries: 3, retryDelayMs: 10 });
    const flaky = new FlakyLLMProvider({ failuresBeforeSuccess: 2, statusCode: 500 });
    runtime.registerProvider('mock', flaky);

    const result = await runtime.execute(makeContext());

    expect(result.status).toBe('success');
    expect(flaky.callCount).toBeGreaterThanOrEqual(3);
  });

  it('fails when retries are exhausted on persistent 429', async () => {
    const { runtime } = createTestRuntime({ maxRetries: 1, retryDelayMs: 10 });
    const flaky = new FlakyLLMProvider({ failuresBeforeSuccess: 99, statusCode: 429 });
    runtime.registerProvider('mock', flaky);

    const result = await runtime.execute(makeContext());

    expect(result.status).toBe('failed');
    // Should have attempted: 1 initial + 1 retry = 2 calls
    expect(flaky.callCount).toBe(2);
  });

  it('fails when retries are exhausted on persistent 500', async () => {
    const { runtime } = createTestRuntime({ maxRetries: 2, retryDelayMs: 10 });
    const flaky = new FlakyLLMProvider({ failuresBeforeSuccess: 99, statusCode: 500 });
    runtime.registerProvider('mock', flaky);

    const result = await runtime.execute(makeContext());

    expect(result.status).toBe('failed');
    expect(flaky.callCount).toBe(3); // 1 initial + 2 retries
  });

  it('records token usage from the successful response after retry', async () => {
    const { runtime } = createTestRuntime({ maxRetries: 3, retryDelayMs: 10 });
    const flaky = new FlakyLLMProvider({ failuresBeforeSuccess: 1, statusCode: 429 });
    runtime.registerProvider('mock', flaky);

    const result = await runtime.execute(makeContext());

    expect(result.status).toBe('success');
    // The FlakyLLMProvider returns usage with totalTokens: 15 on success
    expect(result.totalTokenUsage).toBeDefined();
    expect(result.totalTokenUsage!.totalTokens).toBeGreaterThan(0);
  });

  it('handles mixed 429→500→200 sequence through AgentRuntime', async () => {
    const { runtime } = createTestRuntime({ maxRetries: 5, retryDelayMs: 10 });

    // Custom provider that fails twice with different codes, then succeeds
    let callCount = 0;
    const mixedProvider = {
      name: 'mixed-mock',
      async call(request: any): Promise<any> {
        callCount++;
        if (callCount === 1) {
          const e = new Error('429 rate limited') as any;
          e.statusCode = 429;
          throw e;
        }
        if (callCount === 2) {
          const e = new Error('500 server error') as any;
          e.statusCode = 500;
          throw e;
        }
        return {
          content: 'Recovered after mixed errors.',
          model: request.model,
          usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          finishReason: 'stop',
        };
      },
    };
    runtime.registerProvider('mock', mixedProvider as any);

    const result = await runtime.execute(makeContext());

    expect(result.status).toBe('success');
    expect(callCount).toBe(3);
  });

  it('provider retry does not interfere with tool execution', async () => {
    const { runtime } = createTestRuntime({ maxRetries: 3, retryDelayMs: 10 });

    // Provider that fails once on the first call (no tools), then succeeds
    // with a tool call, then succeeds with a final response
    let callCount = 0;
    const provider = {
      name: 'tool-retry-mock',
      async call(request: any): Promise<any> {
        callCount++;
        if (callCount === 1) {
          const e = new Error('429') as any;
          e.statusCode = 429;
          throw e;
        }
        if (callCount === 2) {
          return {
            content: 'I will use the echo tool.',
            model: request.model,
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            finishReason: 'tool_calls',
            toolCalls: [{
            id: 'tc1',
            type: 'function' as const,
            function: { name: 'echo', arguments: JSON.stringify({ message: 'hello' }) },
          }],
          };
        }
        return {
          content: 'Tool execution complete.',
          model: request.model,
          usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          finishReason: 'stop',
        };
      },
    };
    runtime.registerProvider('mock', provider as any);

    let toolExecuted = false;
    runtime.registerTool('echo', {
      definition: {
        name: 'echo',
        description: 'Echo tool',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
      },
      execute: async (args) => {
        toolExecuted = true;
        return `Echo: ${args.message}`;
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    });

    const result = await runtime.execute(makeContext({ availableTools: ['echo'] }));

    expect(result.status).toBe('success');
    expect(toolExecuted).toBe(true);
    // 1 failed + 1 tool call + 1 final = 3
    expect(callCount).toBe(3);
  });
});
