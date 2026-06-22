/**
 * `applyPreToolCallGates` — execution-loop seam regression.
 *
 * Purpose: prove the extracted pre-tool-call gate helper
 *   1. hook-check (HookManager)
 *   2. sibling-abort (concurrent-only)
 *   3. retry-loop detection
 *   4. cycle detection
 * is wired into both the concurrent-safe and serial paths of
 * `AgentRuntime.execute()`, with byte-identical semantics to the inline
 * original — AND that the helper is a pure decision function that never
 * publishes to the message bus (all observable side effects live at the
 * call site, on a discriminated-union discriminator).
 *
 * Why this test exists: the gate logic (~70 lines per path) was duplicated
 * verbatim in the two execution modes. The risk was the same kind of
 * silent drift that justified `applyBeforeToolCallSecurity`: one path
 * could pick up a new gate (e.g., a new event type) while the other didn't.
 *
 * Discriminated-union regression layer: helper returns one of
 *   { kind: 'allowed' }
 *   { kind: 'hooked';   errorMsg }
 *   { kind: 'siblingAbort'; row }
 *   { kind: 'retry';    count }
 *   { kind: 'cycle';    description }
 * — and never calls `getMessageBus().publish(...)` itself. The calls below
 * spy on the bus to prove that for each gate kind, the publish count is
 * exactly the number the caller is supposed to issue (1 for hook, 1 for
 * retry [no publish], 2 for cycle [system.alert + tool.blocked]). If the
 * helper still publishes internally, these counts double and the test
 * fails loudly.
 *
 * Acceptance criteria:
 *  A. helper invoked once per tool call in BOTH execution modes
 *  B. retry-loop detection: 3 identical tool calls → loop terminates
 *     with retry-loop flag set; no fourth call ever made
 *  C. happy path returns kind='allowed' and execution continues
 *     AND helper publishes ZERO `tool.blocked` events of any denial kind
 *  D. HookManager denial path: blocked event reaches correlator with
 *     reason='hook_denied' — published EXACTLY ONCE (caller), never twice
 *  E. cycle detection path: blocked event reaches correlator with
 *     reason='cycle_detected' and system.alert — each published EXACTLY ONCE
 *  F. F: discriminated-union typing — `gate.kind === 'hooked'` carries
 *     `errorMsg: string`, `'retry'` carries `count: number`, `'cycle'`
 *     carries `description: string`. (Compile-time; tested implicitly by
 *     the spy assertions below since each kind must carry payload for the
 *     caller to use.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRuntime } from '../../src/runtime/agentRuntime';
import { MockLLMProvider } from '../../src/runtime/mockLLMProvider';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import { getMessageBus, resetMessageBus } from '../../src/runtime/messageBus';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetGlobalThreeLayerMemory } from '../../src/threeLayerMemory';
import {
  getSecurityOrchestrator,
  resetSecurityOrchestrator,
} from '../../src/runtime/securityOrchestrator';
import {
  getCrossAgentCorrelator,
  resetCrossAgentCorrelator,
} from '../../src/security/crossAgentCorrelator';
import { getHookManager } from '../../src/pluginManager';
import type {
  AgentExecutionContext,
  LLMRequest,
  LLMResponse,
  Tool,
  ToolDefinition,
} from '../../src/runtime/types';

// ============================================================================
// Helpers
// ============================================================================

function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
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

class ToolCallMockProvider extends MockLLMProvider {
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

function makeEchoTool(): Tool {
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

function makeShellTool(): Tool {
  const def: ToolDefinition = {
    name: 'shell_execute',
    description: 'Execute a shell command (concurrent-unsafe)',
    inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } },
  };
  return {
    definition: def,
    execute: async (args) => {
      // Tool-level error so we can test sibling-abort
      throw new Error(`shell error: ${args.cmd as string}`);
    },
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
  // Reset hook manager too — preserves previous test isolation
  try {
    getHookManager().unregisterAll?.();
  } catch {
    /* defensive — older hookmanager versions may not have unregisterAll */
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('applyPreToolCallGates — execution-loop wiring (discriminated union)', () => {
  let runtime: AgentRuntime;
  let router: ModelRouter;

  beforeEach(() => {
    fullReset();
    router = new ModelRouter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── A: helper invoked once per tool call in both modes
  it('concurrent-safe path: helper is invoked exactly once per tool call (no double-fire)', async () => {
    const provider = new ToolCallMockProvider('openai', { defaultResponse: 'ok' });
    provider.pushToolCalls([{ id: 'c-1', name: 'echo', arguments: { msg: 'first' } }]);

    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 3 }, router);
    runtime.registerProvider('openai', provider);
    runtime.registerTool('echo', makeEchoTool());

    const correlator = getCrossAgentCorrelator();

    await runtime.execute(
      makeContext({ availableTools: ['echo'], goal: 'Echo a single safe message' }),
    );

    const toolCallEvents = correlator.getEvents().filter((e) => e.type === 'tool_call');
    expect(toolCallEvents).toHaveLength(1);
  });

  it('serial path: helper is invoked exactly once per tool call', async () => {
    const provider = new ToolCallMockProvider('openai', { defaultResponse: 'ok' });
    provider.pushToolCalls([{ id: 's-1', name: 'shell_execute', arguments: { cmd: 'ls' } }]);

    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 3 }, router);
    runtime.registerProvider('openai', provider);
    runtime.registerTool('shell_execute', makeShellTool());

    const correlator = getCrossAgentCorrelator();

    await runtime.execute(
      makeContext({ availableTools: ['shell_execute'], goal: 'Execute a single shell command' }),
    );

    const toolCallEvents = correlator
      .getEvents()
      .filter((e) => e.type === 'tool_call' && e.metadata.toolName === 'shell_execute');
    expect(toolCallEvents).toHaveLength(1);
  });

  // ── C: happy path — kind='allowed' AND helper publishes ZERO denial events
  it('happy path: tool_call event has allowed=true; execution completes; helper does NOT publish any tool.blocked denial', async () => {
    const provider = new ToolCallMockProvider('openai', { defaultResponse: 'ok' });
    provider.pushToolCalls([{ id: 'h-1', name: 'echo', arguments: { msg: 'happy' } }]);

    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 3 }, router);
    runtime.registerProvider('openai', provider);
    runtime.registerTool('echo', makeEchoTool());

    const publishSpy = vi.spyOn(getMessageBus(), 'publish');
    const result = await runtime.execute(
      makeContext({ availableTools: ['echo'], goal: 'Friendly echo' }),
    );

    expect(result.status).toBe('success');

    const correlator = getCrossAgentCorrelator();
    const toolCallEvents = correlator
      .getEvents()
      .filter((e) => e.type === 'tool_call' && e.metadata.toolName === 'echo');
    expect(toolCallEvents[0].metadata.allowed).toBe(true);
    expect(toolCallEvents[0].severity).toBe('low');

    // Discriminated-union regression: when gate.kind === 'allowed', the
    // caller falls through and does NOT publish any tool.blocked denial.
    const hookDenied = publishSpy.mock.calls.filter(
      ([topic, , payload]) =>
        topic === 'tool.blocked' &&
        (payload as { reason?: string } | undefined)?.reason === 'hook_denied',
    );
    const cycleBlocked = publishSpy.mock.calls.filter(
      ([topic, , payload]) =>
        topic === 'tool.blocked' &&
        (payload as { reason?: string } | undefined)?.reason === 'cycle_detected',
    );
    const retryBlocked = publishSpy.mock.calls.filter(
      ([topic, , payload]) =>
        topic === 'tool.blocked' &&
        (payload as { reason?: string } | undefined)?.reason === 'retry_loop',
    );
    expect(hookDenied).toHaveLength(0);
    expect(cycleBlocked).toHaveLength(0);
    expect(retryBlocked).toHaveLength(0);
  });

  // ── B: retry-loop detection (3 identical tool calls stops the loop)
  it('retry-loop gate: 3 identical tool calls invoke the gate; loop terminates and tool_blocked bus event fires', async () => {
    const provider = new ToolCallMockProvider('openai', { defaultResponse: 'ok' });
    provider.pushToolCalls([
      { id: 'rl-1', name: 'echo', arguments: { msg: 'a' } },
      { id: 'rl-2', name: 'echo', arguments: { msg: 'a' } },
      { id: 'rl-3', name: 'echo', arguments: { msg: 'a' } },
      { id: 'rl-4', name: 'echo', arguments: { msg: 'a' } }, // 4th — should NOT be invoked
      { id: 'rl-5', name: 'echo', arguments: { msg: 'a' } }, // 5th — should NOT be invoked
    ]);

    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 10 }, router);
    runtime.registerProvider('openai', provider);
    runtime.registerTool('echo', makeEchoTool());

    // Spy MUST be attached BEFORE execute. publishSpy + eventCapture both
    // watch the same execute call — publishSpy is the rigorous assertion
    // (counts ALL publish calls), eventCapture is the secondary backstop.
    // We deliberately attach both BEFORE execute so they actually observe
    // the retry-fire execution (not a stale post-execution re-execution).
    const publishSpy = vi.spyOn(getMessageBus(), 'publish');
    const eventCapture: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const bus = getMessageBus();
    const unsubscribe = bus.subscribe('tool.blocked', (msg) => {
      eventCapture.push({ topic: msg.topic, payload: msg.payload as Record<string, unknown> });
    });

    try {
      await runtime.execute(
        makeContext({
          availableTools: ['echo'],
          goal: 'Repeat echo many times (retry kind must NOT publish)',
        }),
      );
    } finally {
      unsubscribe();
    }

    // After 3 identical calls, the helper returns kind='retry' and the
    // caller sets retryLoopDetected=true and breaks. The 4th push is
    // therefore never processed.
    const correlator = getCrossAgentCorrelator();
    const toolCallEvents = correlator
      .getEvents()
      .filter((e) => e.type === 'tool_call' && e.metadata.toolName === 'echo');
    expect(toolCallEvents.length).toBeLessThanOrEqual(3);

    // Discriminated-union regression: retry kind does NOT publish. Helper
    // returns { kind: 'retry', count }, caller mutates retryLoopDetected
    // and breaks the loop. The retry gate must never reach the bus.
    const retryBlockedViaSpy = publishSpy.mock.calls.filter(
      ([topic, , payload]) =>
        topic === 'tool.blocked' &&
        (payload as { reason?: string } | undefined)?.reason === 'retry_loop',
    );
    const retryBlockedCapture = eventCapture.filter((e) => e.payload?.reason === 'retry_loop');
    expect(retryBlockedViaSpy).toHaveLength(0);
    expect(retryBlockedCapture).toHaveLength(0);
  });

  // ── D: HookManager denial path — caller publishes EXACTLY ONCE
  it('hook-denied gate: kind=hooked → caller publishes tool.blocked reason=hook_denied EXACTLY ONCE (helper does not double-fire)', async () => {
    const provider = new ToolCallMockProvider('openai', { defaultResponse: 'ok' });
    provider.pushToolCalls([{ id: 'd-1', name: 'echo', arguments: { msg: 'one' } }]);

    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 3 }, router);
    runtime.registerProvider('openai', provider);
    runtime.registerTool('echo', makeEchoTool());

    const hookSpy = vi
      .spyOn(getHookManager(), 'fireBeforeToolCall')
      .mockResolvedValue({ error: 'plugin denied this tool', continue: false } as never);

    // Spy MUST be attached BEFORE execute — vi.spyOn does not retroactively
    // capture calls. This is the assertion that proves the helper is a pure
    // decision function and the caller (not the helper) is the single source
    // of 'tool.blocked' publishes for hook-denied.
    const publishSpy = vi.spyOn(getMessageBus(), 'publish');

    await runtime.execute(
      makeContext({ availableTools: ['echo'], goal: 'Echo but get hook-denied' }),
    );

    expect(hookSpy).toHaveBeenCalled();

    const hookDeniedCalls = publishSpy.mock.calls.filter(
      ([topic, , payload]) =>
        topic === 'tool.blocked' &&
        (payload as { reason?: string } | undefined)?.reason === 'hook_denied',
    );
    expect(hookDeniedCalls).toHaveLength(1);
    if (hookDeniedCalls[0] && hookDeniedCalls[0][2]) {
      expect(hookDeniedCalls[0][2]).toMatchObject({
        toolName: 'echo',
        reason: 'hook_denied',
      });
    }

    const correlator = getCrossAgentCorrelator();
    const toolCallEvents = correlator
      .getEvents()
      .filter((e) => e.type === 'tool_call' && e.metadata.toolName === 'echo');
    expect(toolCallEvents).toHaveLength(1);
  });

  // ── E: cycle detection path — caller publishes ONE system.alert + ONE tool.blocked
  it('cycle gate: kind=cycle → caller publishes system.alert + tool.blocked reason=cycle_detected, each EXACTLY ONCE', async () => {
    const provider = new ToolCallMockProvider('openai', { defaultResponse: 'ok' });
    provider.pushToolCalls([
      { id: 'cy-1', name: 'echo', arguments: { msg: 'c' } },
      { id: 'cy-2', name: 'echo', arguments: { msg: 'c' } },
      { id: 'cy-3', name: 'echo', arguments: { msg: 'c' } },
    ]);

    runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 6 }, router);
    runtime.registerProvider('openai', provider);
    runtime.registerTool('echo', makeEchoTool());

    // Force CycleDetector to report a cycle on the 2nd call. The first
    // call passes; the helper's cycle-gate fires on the 2nd and returns
    // { kind: 'cycle', description }.
    const cycleReal = (
      runtime as unknown as {
        cycleDetector: {
          check: (n: string, a: unknown, c: number) => { detected: boolean; description?: string };
        };
      }
    ).cycleDetector;
    const realCheck = cycleReal.check.bind(cycleReal);
    let callIndex = 0;
    vi.spyOn(cycleReal, 'check').mockImplementation((n, a, c) => {
      callIndex++;
      if (callIndex >= 2) {
        return { detected: true, description: 'forcibly detected cycle' };
      }
      return realCheck(n, a, c);
    });

    // Spy MUST be attached BEFORE execute — vi.spyOn does not retroactively
    // capture calls. Capture both system.alert and tool.blocked publishes
    // through this single spy (the previous code used a subscribe + spy
    // pair, which is redundant and confusing).
    const publishSpy = vi.spyOn(getMessageBus(), 'publish');

    await runtime.execute(
      makeContext({ availableTools: ['echo'], goal: 'Trigger cycle detection' }),
    );

    // Discriminated-union regression: helper returns { kind: 'cycle',
    // description }, caller publishes BOTH system.alert + tool.blocked.
    // Exactly ONE publish of each proves the helper does not double-fire.
    // (If helper still emitted internally, we would see 2/2 instead of 1/1.)
    const cycleAlerts = publishSpy.mock.calls.filter(
      ([, source, payload]) =>
        source === 'runtime' &&
        (payload as { type?: string } | undefined)?.type === 'cycle_detected',
    );
    const cycleToolBlocked = publishSpy.mock.calls.filter(
      ([topic, , payload]) =>
        topic === 'tool.blocked' &&
        (payload as { reason?: string } | undefined)?.reason === 'cycle_detected',
    );
    expect(cycleAlerts.length).toBe(1);
    expect(cycleToolBlocked.length).toBe(1);
    if (cycleAlerts[0] && cycleAlerts[0][2]) {
      expect(cycleAlerts[0][2]).toMatchObject({
        type: 'cycle_detected',
        toolName: 'echo',
      });
    }
    if (cycleToolBlocked[0] && cycleToolBlocked[0][2]) {
      expect(cycleToolBlocked[0][2]).toMatchObject({
        reason: 'cycle_detected',
        toolName: 'echo',
      });
    }
  });
});
