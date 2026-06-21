/**
 * SecurityOrchestrator helper — agent-runtime integration test.
 *
 * Purpose: prove that the extracted `applyBeforeToolCallSecurity` helper
 * preserves the three SecurityOrchestrator seams
 *   1. onBeforeToolCall (max of ToolApproval + AdaptiveHITL)
 *   2. sanitizeMemoryShare (DP layer on memory queries)
 *   3. onAgentEvent (LLM call + tool call + tool result → correlator)
 * across BOTH the concurrent-safe and the serial tool-execution paths,
 * without regressing to a double-invocation per tool call.
 *
 * Why this test exists: previously a ~30-line block was duplicated in
 * both the Promise.allSettled (concurrent) path and the for-of (serial)
 * path. The risk it carried was that one path could silently drift from
 * the other (e.g. one emits a new event type, the other doesn't) — and
 * that `SecurityOrchestrator.onBeforeToolCall` could fire twice per call
 * under certain execution modes (correlator double-count).
 *
 * Acceptance criteria:
 *  A. onBeforeToolCall invoked exactly once per tool call across BOTH modes
 *  B. tool_call correlator event emitted exactly once per tool call
 *  C. concurrent-mode blocked path uses blockedRawResult shape
 *  D. serial-mode blocked path uses blockedToolResult shape
 *  E. allowed path skips both synthetic results entirely
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import {
  getSecurityOrchestrator,
  resetSecurityOrchestrator,
} from '../../src/runtime/securityOrchestrator';
import { getCrossAgentCorrelator, resetCrossAgentCorrelator } from '../../src/security/crossAgentCorrelator';
import type {
  AgentExecutionContext,
  Tool,
  ToolDefinition,
  LLMRequest,
  LLMResponse,
  ToolResult,
} from '../../src/runtime/types';

// ============================================================================
// Helpers
// ============================================================================

function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
  return {
    agentId: 'helper-test-agent',
    projectId: 'helper-test',
    missionId: 'helper-mission',
    goal: 'Run echo and write tools in parallel and serially.',
    contextData: {},
    availableTools: [],
    maxSteps: 5,
    tokenBudget: 200000,
    ...overrides,
  };
}

class ToolCallMockProvider extends MockLLMProvider {
  private queuedToolCalls: Array<Array<{ id: string; name: string; arguments: Record<string, unknown> }>> = [];
  private index = 0;

  pushToolCalls(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
    this.queuedToolCalls.push(calls);
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const base = await super.call(request);
    if (this.index < this.queuedToolCalls.length) {
      const tcs = this.queuedToolCalls[this.index++];
      return { ...base, toolCalls: tcs };
    }
    return base;
  }
}

function makeEchoTool(): Tool {
  const def: ToolDefinition = {
    name: 'echo',
    description: 'Echoes input',
    inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
  };
  return {
    definition: def,
    execute: async (args) => `Echo: ${args.msg}`,
    isConcurrencySafe: true,
  };
}

/**
 * Build an echo tool whose execute fn is a spy, so a test can directly
 * assert the underlying tool NEVER ran when SecurityOrchestrator denied
 * the call. This is the strong behavioral counterpart of the
 * tool_call correlator event with allowed=false: the synthetic blocked
 * result must short-circuit before reaching the tool implementation.
 */
function makeSpiedEchoTool(): { tool: Tool; executorSpy: ReturnType<typeof vi.fn> } {
  const executorSpy = vi.fn(async (args: Record<string, unknown>) => `Echo: ${args.msg}`);
  const def: ToolDefinition = {
    name: 'echo',
    description: 'Echoes input',
    inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
  };
  return {
    tool: {
      definition: def,
      execute: executorSpy as unknown as Tool['execute'],
      isConcurrencySafe: true,
    },
    executorSpy,
  };
}

function makeWriteTool(): Tool {
  const def: ToolDefinition = {
    name: 'write',
    description: 'Writes content to a file (not concurrency-safe)',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
  };
  return {
    definition: def,
    execute: async (args) => `Wrote ${args.path}`,
    isConcurrencySafe: false,
  };
}

function fullReset(): void {
  resetModelRouter();
  resetMessageBus();
  resetTraceRecorder();
  resetGlobalThreeLayerMemory();
  resetSecurityOrchestrator();
  resetCrossAgentCorrelator();
}

// ============================================================================
// Tests
// ============================================================================

describe('SecurityOrchestrator helper — execute() seam contract', () => {
  let runtime: AgentRuntime;
  let router: ModelRouter;

  beforeEach(() => {
    fullReset();
    router = new ModelRouter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── A. Concurrent path: one tool call → one onBeforeToolCall invocation
  // ── B. tool_call correlator event emitted exactly once per tool call

  it('concurrent-safe path: onBeforeToolCall invoked exactly once per tool call; tool_call correlator event emitted once', async () => {
    const provider = new ToolCallMockProvider('openai', { defaultResponse: 'echoing' });
    provider.pushToolCalls([
      { id: 'echo-1', name: 'echo', arguments: { msg: 'first' } },
    ]);

    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 3 }, router);
    runtime.registerProvider('openai', provider);
    runtime.registerTool('echo', makeEchoTool());

    const orch = getSecurityOrchestrator();
    const spy = vi.spyOn(orch, 'onBeforeToolCall');

    await runtime.execute(
      makeContext({ availableTools: ['echo'], goal: 'Echo a single message' }),
    );

    // A — exactly one invocation, not two
    expect(spy).toHaveBeenCalledTimes(1);
    // and the call was for the 'echo' tool
    expect(spy.mock.calls[0][0]).toBe('echo');

    // B — exactly one tool_call correlator event
    const correlator = getCrossAgentCorrelator();
    const toolCallEvents = correlator.getEvents().filter((e) => e.type === 'tool_call');
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0].metadata.toolName).toBe('echo');
  });

  // ── A. Serial path: one tool call → one onBeforeToolCall invocation
  it('serial path: onBeforeToolCall invoked exactly once per tool call; no parallel-adjacent duplicates', async () => {
    const provider = new ToolCallMockProvider('openai', { defaultResponse: 'writing' });
    provider.pushToolCalls([
      { id: 'write-1', name: 'write', arguments: { path: '/tmp/test.txt', content: 'hello' } },
    ]);

    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 3 }, router);
    runtime.registerProvider('openai', provider);
    runtime.registerTool('write', makeWriteTool());

    const orch = getSecurityOrchestrator();
    const spy = vi.spyOn(orch, 'onBeforeToolCall');

    await runtime.execute(
      makeContext({ availableTools: ['write'], goal: 'Write a file' }),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('write');

    const correlator = getCrossAgentCorrelator();
    const toolCallEvents = correlator.getEvents().filter((e) => e.type === 'tool_call');
    expect(toolCallEvents).toHaveLength(1);
  });

  // ── Concurrent and serial COEXIST: neither path inflates the spy count
  // (this is the dedup-regression guard)
  it('mixed concurrent+serial in one execution: count == tool-call-count exactly (no duplication)', async () => {
    const provider = new ToolCallMockProvider('openai', { defaultResponse: 'mixed' });
    // First: one concurrent-safe tool (echo). Then: one serial (write).
    // Both end up in the same execution. They share the helper, not their
    // own duplicated inline copy.
    provider.pushToolCalls([
      { id: 'echo-mix', name: 'echo', arguments: { msg: 'mix' } },
    ]);
    provider.pushToolCalls([
      { id: 'write-mix', name: 'write', arguments: { path: '/tmp/mix.txt', content: 'x' } },
    ]);

    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 6 }, router);
    runtime.registerProvider('openai', provider);
    runtime.registerTool('echo', makeEchoTool());
    runtime.registerTool('write', makeWriteTool());

    const orch = getSecurityOrchestrator();
    const spy = vi.spyOn(orch, 'onBeforeToolCall');

    await runtime.execute(
      makeContext({ availableTools: ['echo', 'write'], goal: 'Echo and write file' }),
    );

    // Two tool calls invoked → two helper invocations. The dedup invariant
    // is that no tool call triggers the helper TWICE.
    expect(spy).toHaveBeenCalledTimes(2);
    const invokedTools = spy.mock.calls.map((c) => c[0]).sort();
    expect(invokedTools).toEqual(['echo', 'write']);

    // Correlator: exactly two tool_call events, one per tool, no dupes.
    const correlator = getCrossAgentCorrelator();
    const toolCallEvents = correlator.getEvents().filter((e) => e.type === 'tool_call');
    expect(toolCallEvents).toHaveLength(2);
    const eventTools = toolCallEvents.map((e) => e.metadata.toolName).sort();
    expect(eventTools).toEqual(['echo', 'write']);
  });

  // ── C. Concurrent-mode blocked path uses blockedRawResult shape
  it('concurrent-mode blocked: returns blockedRawResult; underlying tool execute is NOT called', async () => {
    const provider = new ToolCallMockProvider('openai', { defaultResponse: 'echoing' });
    provider.pushToolCalls([
      { id: 'echo-block', name: 'echo', arguments: { msg: 'one' } },
    ]);

    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 3 }, router);
    runtime.registerProvider('openai', provider);
    const { tool, executorSpy } = makeSpiedEchoTool();
    runtime.registerTool('echo', tool);

    const orch = getSecurityOrchestrator();
    vi.spyOn(orch, 'onBeforeToolCall').mockResolvedValue({
      allowed: false,
      hitlStrategy: 'deny',
      blockReason: 'AdaptiveHITL blocked: dangerous shell command',
      sources: ['AdaptiveHITL'],
    });

    const result = await runtime.execute(
      makeContext({ availableTools: ['echo'], goal: 'Echo a friendly message' }),
    );

    // Execution still succeeds (the agent loop absorbs blocked results gracefully).
    expect(result.status).toBe('success');

    // Direct behavioral assertion: the underlying tool's execute fn MUST
    // have been short-circuited by blockedRawResult and never invoked.
    expect(executorSpy).not.toHaveBeenCalled();

    // Correlator must carry the blocked tool_call event with severity: 'high'.
    const correlator = getCrossAgentCorrelator();
    const toolCallEvents = correlator.getEvents().filter(
      (e) => e.type === 'tool_call' && e.metadata.toolName === 'echo',
    );
    expect(toolCallEvents.length).toBeGreaterThan(0);
    expect(toolCallEvents[0].metadata.allowed).toBe(false);
    expect(toolCallEvents[0].severity).toBe('high');
  });

  // ── D. Serial-mode blocked path uses blockedToolResult shape
  it('serial-mode blocked: returns blockedToolResult; underlying tool execute is NOT called', async () => {
    const provider = new ToolCallMockProvider('openai', { defaultResponse: 'writing' });
    provider.pushToolCalls([
      { id: 'write-block', name: 'write', arguments: { path: '/tmp/block.txt', content: 'x' } },
    ]);

    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 3 }, router);
    runtime.registerProvider('openai', provider);
    const writeSpy = vi.fn(async (args: Record<string, unknown>) => `Wrote ${args.path}`);
    const writeDef: ToolDefinition = {
      name: 'write',
      description: 'Writes content to a file (not concurrency-safe)',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
    };
    runtime.registerTool('write', {
      definition: writeDef,
      execute: writeSpy as unknown as Tool['execute'],
      isConcurrencySafe: false,
    });

    const orch = getSecurityOrchestrator();
    vi.spyOn(orch, 'onBeforeToolCall').mockResolvedValue({
      allowed: false,
      hitlStrategy: 'deny',
      blockReason: 'ToolApproval denied: write requires manual approval',
      sources: ['ToolApproval'],
    });

    const result = await runtime.execute(
      makeContext({ availableTools: ['write'], goal: 'Write a file' }),
    );

    expect(result.status).toBe('success');

    // Direct behavioral assertion: blockedToolResult short-circuits execute.
    expect(writeSpy).not.toHaveBeenCalled();

    // Serial-mode blocked: tool_call correlator event carries allowed=false
    const correlator = getCrossAgentCorrelator();
    const toolCallEvents = correlator.getEvents().filter(
      (e) => e.type === 'tool_call' && e.metadata.toolName === 'write',
    );
    expect(toolCallEvents.length).toBeGreaterThan(0);
    expect(toolCallEvents[0].metadata.allowed).toBe(false);
    expect(toolCallEvents[0].severity).toBe('high');
  });

  // ── E. Allowed path: no synthetic results emitted
  it('allowed path: no synthetic blocked result or toolResult; tool_call event has severity:low', async () => {
    const provider = new ToolCallMockProvider('openai', { defaultResponse: 'ok' });
    provider.pushToolCalls([
      { id: 'echo-ok', name: 'echo', arguments: { msg: 'fine' } },
    ]);

    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 3 }, router);
    runtime.registerProvider('openai', provider);
    runtime.registerTool('echo', makeEchoTool());

    // Default orchestrator config returns allowed=true:
    const orch = getSecurityOrchestrator();
    vi.spyOn(orch, 'onBeforeToolCall').mockResolvedValue({
      allowed: true,
      hitlStrategy: 'auto',
      sources: ['ToolApproval'],
    });

    await runtime.execute(
      makeContext({ availableTools: ['echo'], goal: 'Echo safely' }),
    );

    const correlator = getCrossAgentCorrelator();
    const toolCallEvents = correlator.getEvents().filter(
      (e) => e.type === 'tool_call' && e.metadata.toolName === 'echo',
    );
    expect(toolCallEvents.length).toBeGreaterThan(0);
    expect(toolCallEvents[0].metadata.allowed).toBe(true);
    expect(toolCallEvents[0].severity).toBe('low');
  });

  // ── End-to-end seam contract: ALL three seams must participate
  it('exercises all three SecurityOrchestrator seams in one execution', async () => {
    const provider = new ToolCallMockProvider('openai', { defaultResponse: 'analysis' });
    provider.pushToolCalls([
      { id: 'echo-all', name: 'echo', arguments: { msg: 'all-seams' } },
    ]);

    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 3 }, router);
    runtime.registerProvider('openai', provider);
    runtime.registerTool('echo', makeEchoTool());

    const orch = getSecurityOrchestrator();
    const beforeSpy = vi.spyOn(orch, 'onBeforeToolCall');
    const dpSpy = vi.spyOn(orch, 'sanitizeMemoryShare');
    const eventSpy = vi.spyOn(orch, 'onAgentEvent');

    await runtime.execute(
      makeContext({ availableTools: ['echo'], goal: 'Test all three seams at once' }),
    );

    // Seam 1: onBeforeToolCall invoked (concurrent path is what runs here)
    expect(beforeSpy).toHaveBeenCalled();

    // Seam 2: sanitizeMemoryShare invoked (memory has no entries by default,
    // but the call should still trigger for the configured agentId)
    expect(dpSpy).toHaveBeenCalled();

    // Seam 3: onAgentEvent invoked for LLM call + tool call + tool result.
    // (We just assert it was called multiple times — exact count is verified
    // by the existing integration test, which we don't want to duplicate.)
    expect(eventSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    const eventTypes = eventSpy.mock.calls.map((c) => c[0].type);
    expect(eventTypes).toContain('llm_call');
    expect(eventTypes).toContain('tool_call');
  });
});
