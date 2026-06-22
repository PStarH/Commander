/**
 * Shared harness for AgentRuntime gate-pipeline tests.
 *
 * Used by:
 *   - `tests/runtime/toolGateHelper.test.ts`   — pre-tool-call gate coverage
 *   - `tests/runtime/toolResultShape.test.ts`  — real-execution row-parity
 *
 * Single source of truth for:
 *   - agent-execution context construction
 *   - mock LLM provider that emits a queued list of tool calls
 *   - canonical echo + shell tools (concurrent-safe vs serial-only)
 *   - full singleton reset (model router, message bus, trace recorder,
 *     memory, SecurityOrchestrator, CrossAgentCorrelator, hook manager)
 *
 * Convention: helpers are exported as named exports from this module; tests
 * import them directly. New tests SHOULD import from this file rather than
 * re-implementing these helpers inline — please update this file rather than
 * duplicating when adding new shared setup.
 */
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import { resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import { resetSecurityOrchestrator } from '../../src/runtime/securityOrchestrator';
import { resetCrossAgentCorrelator } from '../../src/security/crossAgentCorrelator';
import { getHookManager } from '../../src/pluginManager';
import type {
  AgentExecutionContext,
  LLMRequest,
  LLMResponse,
  Tool,
  ToolDefinition,
} from '../../src/runtime/types';

/**
 * Build an `AgentExecutionContext` with sensible defaults for gate tests.
 * Tests override `availableTools` and `goal`; everything else stays constant.
 */
export function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
  return {
    agentId: 'gate-test-agent',
    projectId: 'gate-test',
    missionId: 'gate-mission',
    goal: 'Run delivery cycle tools.',
    contextData: {},
    availableTools: [],
    maxSteps: 6,
    tokenBudget: 200000,
    ...overrides,
  };
}

/**
 * Mock LLM provider that emits a queued list of tool calls in order.
 *
 * Each call to `pushToolCalls([...])` adds a new "round" of tool calls;
 * the next `call()` invocation returns them. After all rounds are
 * consumed, falls through to the default response (no tool calls).
 */
export class ToolCallMockProvider extends MockLLMProvider {
  private queuedToolCalls: Array<
    Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  > = [];
  private index = 0;
  public lastRequest: LLMRequest | undefined;

  pushToolCalls(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
    this.queuedToolCalls.push(calls);
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const base = await super.call(request);
    this.lastRequest = request;
    if (this.index < this.queuedToolCalls.length) {
      const tcs = this.queuedToolCalls[this.index++];
      return { ...base, toolCalls: tcs };
    }
    return base;
  }
}

/**
 * Concurrency-safe "echo" tool. Returns the input msg prefixed with
 * "Echo: ". Suitable for testing the concurrent-safe path of agentRuntime.
 */
export function makeEchoTool(): Tool {
  const def: ToolDefinition = {
    name: 'echo',
    description: 'Echoes input',
    inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
  };
  return {
    definition: def,
    execute: async (args) => `Echo: ${args.msg as string}`,
    isConcurrencySafe: true,
  };
}

/**
 * Concurrent-unsafe "shell_execute" tool. Throws an Error on every call
 * so tests can drive the siblingAbort path and serial-only execution.
 */
export function makeShellTool(): Tool {
  const def: ToolDefinition = {
    name: 'shell_execute',
    description: 'Execute a shell command (concurrent-unsafe)',
    inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } },
  };
  return {
    definition: def,
    execute: async (args) => {
      throw new Error(`shell error: ${args.cmd as string}`);
    },
    isConcurrencySafe: false,
  };
}

/**
 * Reset every runtime singleton that tests touch. Call from `beforeEach`
 * to guarantee test isolation regardless of the global registry's prior
 * state from earlier tests in the same file (or other test files).
 */
export function fullReset(): void {
  resetModelRouter();
  resetMessageBus();
  resetTraceRecorder();
  resetGlobalThreeLayerMemory();
  resetSecurityOrchestrator();
  resetCrossAgentCorrelator();
  try {
    getHookManager().unregisterAll?.();
  } catch {
    /* defensive — older hookmanager versions may not have unregisterAll */
  }
}
