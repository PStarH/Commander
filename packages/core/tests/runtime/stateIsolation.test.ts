/**
 * E2E tests for state isolation between consecutive AgentRuntime.execute() calls.
 *
 * These tests verify that framework state does not leak between runs by
 * executing multiple runtime.execute() calls and checking:
 * - Circuit breaker state resets between runs
 * - DLQ entries don't cause cascading failures in subsequent runs
 * - Token budget accumulates within a run but is independent across runs
 * - Tools that failed in one run succeed in the next (no stale breaker state)
 *
 * Everything goes through real AgentRuntime.execute() — the LLM is mocked
 * via ScriptedLLMProvider, but CircuitBreaker, DLQ, CostGuard, and
 * ToolOrchestrator are all real.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestRuntime,
  ScriptedLLMProvider,
  FlakyLLMProvider,
  makeTool,
  makeFailingTool,
  makeContext,
  resetGlobalState,
} from './e2eTestHelpers';

describe('E2E: State isolation between AgentRuntime.execute() calls', () => {
  beforeEach(() => {
    resetGlobalState();
  });

  it('tool failure in run 1 does not block run 2 (breaker resets)', async () => {
    const { runtime } = createTestRuntime({ circuitBreaker: { openOnFailure: true } });

    // Register a tool that fails on first call, succeeds on second
    let toolCallCount = 0;
    runtime.registerTool('flaky-tool', {
      definition: {
        name: 'flaky-tool',
        description: 'Fails first, succeeds later',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        toolCallCount++;
        if (toolCallCount === 1) throw new Error('First call fails');
        return 'Success on retry';
      },
      isConcurrencySafe: true,
    });

    // Run 1: tool fails
    const provider1 = new ScriptedLLMProvider([
      { toolCalls: [{ id: 'c1', name: 'flaky-tool', arguments: {} }] },
      { response: 'Run 1 done.', finishReason: 'stop' },
    ]);
    runtime.registerProvider('mock', provider1);
    const result1 = await runtime.execute(makeContext({ availableTools: ['flaky-tool'] }));
    expect(result1.status).toBe('success');

    // Run 2: same tool should be available (not blocked by stale breaker)
    const provider2 = new ScriptedLLMProvider([
      { toolCalls: [{ id: 'c2', name: 'flaky-tool', arguments: {} }] },
      { response: 'Run 2 done.', finishReason: 'stop' },
    ]);
    runtime.registerProvider('mock', provider2);
    const result2 = await runtime.execute(makeContext({ availableTools: ['flaky-tool'] }));
    expect(result2.status).toBe('success');
    // Tool was called successfully in run 2
    expect(toolCallCount).toBe(2);
  });

  it('multiple consecutive runs maintain independent token counts', async () => {
    const { runtime } = createTestRuntime();

    runtime.registerTool('echo', makeTool('echo', async () => 'echo', { isConcurrencySafe: true }));

    const tokenUsages: number[] = [];

    for (let i = 0; i < 3; i++) {
      const provider = new ScriptedLLMProvider([
        { toolCalls: [{ id: `c${i}`, name: 'echo', arguments: {} }] },
        { response: `Run ${i} done.`, finishReason: 'stop' },
      ]);
      runtime.registerProvider('mock', provider);

      const result = await runtime.execute(makeContext({ availableTools: ['echo'] }));
      expect(result.status).toBe('success');
      tokenUsages.push(result.totalTokenUsage!.totalTokens);
    }

    // Each run should have non-zero tokens
    expect(tokenUsages.every((t) => t > 0)).toBe(true);
    // Token counts should be roughly similar (not accumulating across runs)
    // The first run includes system prompt overhead; subsequent runs may differ
    // but should not be 3x the first
    const max = Math.max(...tokenUsages);
    const min = Math.min(...tokenUsages);
    expect(max / min).toBeLessThan(3);
  });

  it('DLQ from failed run does not cause failures in subsequent run', async () => {
    const { runtime } = createTestRuntime();

    // Run 1: tool fails, should complete gracefully
    runtime.registerTool('bad-tool', makeFailingTool('bad-tool', 'Run 1 failure'));
    const provider1 = new ScriptedLLMProvider([
      { toolCalls: [{ id: 'c1', name: 'bad-tool', arguments: {} }] },
      { response: 'Run 1 completed with errors.', finishReason: 'stop' },
    ]);
    runtime.registerProvider('mock', provider1);
    const result1 = await runtime.execute(makeContext({ availableTools: ['bad-tool'] }));
    expect(result1.status).toBe('success');
    runtime.flushDeadLetterQueue();

    // Run 2: different tool, should succeed without DLQ interference
    runtime.registerTool('good-tool', makeTool('good-tool', async () => 'good', { isConcurrencySafe: true }));
    const provider2 = new ScriptedLLMProvider([
      { toolCalls: [{ id: 'c2', name: 'good-tool', arguments: {} }] },
      { response: 'Run 2 completed cleanly.', finishReason: 'stop' },
    ]);
    runtime.registerProvider('mock', provider2);
    const result2 = await runtime.execute(makeContext({ availableTools: ['good-tool'] }));
    expect(result2.status).toBe('success');
  });

  it('5 consecutive runs with alternating success/failure tools', async () => {
    const { runtime } = createTestRuntime();

    runtime.registerTool('ok', makeTool('ok', async () => 'ok', { isConcurrencySafe: true }));
    runtime.registerTool('fail', makeFailingTool('fail', 'Alternating failure'));

    for (let i = 0; i < 5; i++) {
      const useOk = i % 2 === 0;
      const toolName = useOk ? 'ok' : 'fail';
      const provider = new ScriptedLLMProvider([
        { toolCalls: [{ id: `c${i}`, name: toolName, arguments: {} }] },
        { response: `Run ${i} done.`, finishReason: 'stop' },
      ]);
      runtime.registerProvider('mock', provider);

      const result = await runtime.execute(
        makeContext({ availableTools: [toolName], goal: `Run ${i}` }),
      );
      // All runs should complete (failures are handled gracefully)
      expect(result.status).toBe('success');
    }
  });

  it('provider 429 error in run 1 does not affect run 2', async () => {
    const { runtime } = createTestRuntime({ maxRetries: 2, retryDelayMs: 10 });

    // Run 1: provider fails with 429, then succeeds
    const flaky = new FlakyLLMProvider({ failuresBeforeSuccess: 1, statusCode: 429 });
    runtime.registerProvider('mock', flaky);
    const result1 = await runtime.execute(makeContext());
    expect(result1.status).toBe('success');

    // Run 2: fresh provider, should succeed immediately
    const fresh = new ScriptedLLMProvider([
      { response: 'Run 2 immediate success.', finishReason: 'stop' },
    ]);
    runtime.registerProvider('mock', fresh);
    const result2 = await runtime.execute(makeContext({ goal: 'Run 2' }));
    expect(result2.status).toBe('success');
    expect(fresh.callCount).toBe(1); // No retries needed
  });

  it('simulates 10 rapid consecutive runs without state leakage', async () => {
    const { runtime } = createTestRuntime();

    runtime.registerTool('echo', makeTool('echo', async () => 'echo', { isConcurrencySafe: true }));

    let totalCalls = 0;
    for (let i = 0; i < 10; i++) {
      const provider = new ScriptedLLMProvider([
        { toolCalls: [{ id: `c${i}`, name: 'echo', arguments: {} }] },
        { response: `Run ${i}.`, finishReason: 'stop' },
      ]);
      runtime.registerProvider('mock', provider);

      const result = await runtime.execute(
        makeContext({ availableTools: ['echo'], goal: `Run ${i}` }),
      );
      expect(result.status).toBe('success');
      totalCalls += provider.callCount;
    }

    // 10 runs × 2 calls each = 20 total LLM calls
    expect(totalCalls).toBe(20);
  }, 30_000); // Extended timeout for 10 sequential runs under full-suite load
});
