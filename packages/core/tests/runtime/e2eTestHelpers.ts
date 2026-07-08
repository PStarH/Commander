/**
 * Shared test helpers for e2e tests that exercise the full AgentRuntime pipeline.
 *
 * These helpers create real AgentRuntime instances with mock LLM providers
 * that return scripted tool calls. The AgentRuntime's internal machinery
 * (CircuitBreaker, DeadLetterQueue, CostGuard, ToolOrchestrator) is all real
 * — only the LLM endpoint is mocked, which is necessary for CI.
 */
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetPatternTracker } from '../../src/runtime/speculativeExecutor';
import { resetGuardianAgent } from '../../src/security/guardianAgent';
import { resetRuntimeGuardian } from '../../src/runtime/runtimeGuardianBridge';
import { resetUnifiedCostAuthority } from '../../src/security/unifiedCostAuthority';
import { resetBillExplosionGuard } from '../../src/security/billExplosionGuard';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import type { AgentExecutionContext, Tool, LLMRequest, LLMResponse } from '../../src/runtime/types';

/**
 * A mock LLM provider that returns scripted tool calls in sequence.
 * Each invocation returns the next step in the script. Once the script
 * is exhausted, returns a final stop response.
 */
export class ScriptedLLMProvider extends MockLLMProvider {
  private script: ScriptStep[];
  public callCount = 0;
  public lastRequest: LLMRequest | null = null;
  public requests: LLMRequest[] = [];

  constructor(script: ScriptStep[]) {
    super('scripted-mock');
    this.script = script;
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    this.lastRequest = request;
    this.requests.push(request);

    const idx = Math.min(this.callCount - 1, this.script.length - 1);
    const step = this.script[idx] ?? { response: 'Done.', finishReason: 'stop' as const };

    const content = step.response ?? 'Processing...';
    const promptTokens = JSON.stringify(request.messages).length;
    const completionTokens = content.length + (step.toolCalls?.length ?? 0) * 50;

    return {
      content,
      model: request.model,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      finishReason: step.finishReason ?? (step.toolCalls ? 'tool_calls' : 'stop'),
      // Return tool calls in the internal LLMResponse format (flat with
      // name and arguments as object). The runtime's ToolResultCache and
      // tool orchestrator expect this format from mock providers.
      toolCalls: step.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments ?? {},
      })),
    };
  }
}

export interface ScriptStep {
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  response?: string;
  finishReason?: 'tool_calls' | 'stop';
}

/** A mock LLM provider that simulates transient failures (429/500) then recovery. */
export class FlakyLLMProvider extends MockLLMProvider {
  private failureCount: number;
  private remainingFailures: number;
  private statusCode: number;
  public callCount = 0;
  public requests: LLMRequest[] = [];

  constructor(opts: { failuresBeforeSuccess: number; statusCode?: number }) {
    super('flaky-mock');
    this.failureCount = opts.failuresBeforeSuccess;
    this.remainingFailures = opts.failuresBeforeSuccess;
    this.statusCode = opts.statusCode ?? 429;
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    this.requests.push(request);

    if (this.remainingFailures > 0) {
      this.remainingFailures--;
      const err = new Error(`Simulated ${this.statusCode} error`) as Error & {
        statusCode?: number;
      };
      err.statusCode = this.statusCode;
      throw err;
    }

    return {
      content: 'Recovered after retry.',
      model: request.model,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      finishReason: 'stop',
    };
  }

  get totalFailuresInjected(): number {
    return this.failureCount;
  }
}

/** Create a tool with the given name and executor. */
export function makeTool(
  name: string,
  execute: (args: Record<string, unknown>) => Promise<string>,
  opts?: { isConcurrencySafe?: boolean; isReadOnly?: boolean },
): Tool {
  return {
    definition: {
      name,
      description: `Tool: ${name}`,
      inputSchema: { type: 'object', properties: {} },
    },
    execute,
    isConcurrencySafe: opts?.isConcurrencySafe ?? true,
    isReadOnly: opts?.isReadOnly ?? false,
  };
}

/** Create a tool that always fails. */
export function makeFailingTool(name: string, errorMessage?: string): Tool {
  return makeTool(name, async () => {
    throw new Error(errorMessage ?? `${name} failed intentionally`);
  });
}

/** Create a tool that fails N times then succeeds. */
export function makeFlakyTool(
  name: string,
  failuresBeforeSuccess: number,
  opts?: { isConcurrencySafe?: boolean },
): Tool & { callCount: number } {
  let callCount = 0;
  const tool = makeTool(
    name,
    async () => {
      callCount++;
      if (callCount <= failuresBeforeSuccess) {
        throw new Error(`${name} failure #${callCount}`);
      }
      return `${name} succeeded on attempt #${callCount}`;
    },
    opts,
  );
  return Object.assign(tool, {
    callCount: 0,
    get callCount() {
      return callCount;
    },
  });
}

/** Create a standard AgentExecutionContext for tests. */
export function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
  return {
    agentId: 'test-agent',
    projectId: 'test-project',
    goal: 'Complete the test task.',
    contextData: {},
    availableTools: [],
    maxSteps: 10,
    tokenBudget: 50000,
    ...overrides,
  };
}

/** Reset all global singletons that can leak state between tests. */
export function resetGlobalState(): void {
  resetModelRouter();
  resetMessageBus();
  resetTraceRecorder();
  resetPatternTracker();
  resetGuardianAgent();
  resetRuntimeGuardian();
  resetUnifiedCostAuthority();
  resetBillExplosionGuard();
}

/**
 * Create a fresh AgentRuntime with a clean state.
 * Uses low retry settings for fast tests, but real CircuitBreaker/DLQ/CostGuard.
 */
export function createTestRuntime(config?: Record<string, unknown>): {
  runtime: AgentRuntime;
  router: ModelRouter;
} {
  resetGlobalState();
  const router = new ModelRouter();
  const runtime = new AgentRuntime(
    {
      maxRetries: 2,
      timeoutMs: 10000,
      ...config,
    },
    router,
  );
  return { runtime, router };
}
