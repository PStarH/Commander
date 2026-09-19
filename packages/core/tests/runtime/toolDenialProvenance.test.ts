/**
 * RUN-02 — security-denial provenance is preserved and bound to the call.
 *
 * The defect this file pins down (register item RUN-02, patch-provenance risk):
 *
 *   1. `toolExecutionHandler.executeStep()` kept ONE function-scoped
 *      `lastSecurityDenial`, written when *any* call was denied and read back at
 *      the retry-loop branch for a *different* call — so call A's denial could
 *      be surfaced as call B's error ("A denied, B retried").
 *   2. Hook/policy denials were relabelled `GUARDIAN_BLOCKED` purely so a
 *      downstream string assertion (demo-qa) could match, which erases which
 *      layer actually denied the call.
 *
 * The counter-example below issues a serial (and a concurrent) batch in which
 * call A is denied by one layer and call B is retry-blocked, then reads the
 * tool rows by `tool_call_id` (the call identity the runtime already threads
 * through). It asserts:
 *
 *   - A's row names A's real denying layer (`HOOK_DENIED`), never
 *     `GUARDIAN_BLOCKED`.
 *   - B's row is B's own retry-loop cause, never A's denial text.
 *
 * Zero tool execution: every tool body records a call and the test asserts the
 * record stayed empty.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  createTestRuntime,
  ScriptedLLMProvider,
  makeTool,
  makeContext,
  resetGlobalState,
} from './e2eTestHelpers';
import { getHookManager } from '../../src/pluginManager';
import {
  SideEffectGateError,
  resetSideEffectGate,
  setSideEffectGate,
  type SideEffectRequest,
} from '../../src/runtime/sideEffectGate';
import { ToolExecutionService } from '../../src/runtime/toolExecutionService';

type ToolMessage = { tool_call_id: string; content: string };

/** Collect every `role: 'tool'` message the runtime sent back to the provider. */
function toolMessagesByCallId(provider: ScriptedLLMProvider): Map<string, string> {
  const byId = new Map<string, string>();
  for (const request of provider.requests) {
    for (const message of request.messages as Array<Record<string, unknown>>) {
      if (message.role !== 'tool') continue;
      const id = String(message.tool_call_id ?? '');
      if (!byId.has(id)) byId.set(id, String(message.content ?? ''));
    }
  }
  return byId;
}

function denyHookFor(toolName: string): void {
  vi.spyOn(getHookManager(), 'fireBeforeToolCall').mockImplementation(async (ctx) => {
    if (ctx.toolName !== toolName) return null;
    return {
      toolCallId: '',
      name: ctx.toolName,
      output: '',
      error: `plugin denied ${toolName}`,
      durationMs: 0,
    };
  });
}

function forceRetryFor(
  runtime: ReturnType<typeof createTestRuntime>['runtime'],
  toolName: string,
): void {
  const detector = (
    runtime as unknown as {
      toolCallRetryLoopDetector: {
        checkRetryLoop: (...args: unknown[]) => { detected: boolean; count: number };
      };
    }
  ).toolCallRetryLoopDetector;
  vi.spyOn(detector, 'checkRetryLoop').mockImplementation((...args: unknown[]) =>
    args[0] === toolName ? { detected: true, count: 3 } : { detected: false, count: 1 },
  );
}

describe('RUN-02 — security denial provenance is bound to the call', () => {
  const executed: string[] = [];

  beforeEach(() => {
    executed.length = 0;
    resetGlobalState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetGlobalState();
  });

  function registerTools(
    runtime: ReturnType<typeof createTestRuntime>['runtime'],
    concurrencySafe: boolean,
  ): void {
    for (const name of ['a_tool', 'b_tool']) {
      runtime.registerTool(
        name,
        makeTool(
          name,
          async () => {
            executed.push(name);
            return `${name} ran`;
          },
          { isConcurrencySafe: concurrencySafe },
        ),
      );
    }
  }

  it('serial batch: hook-denied A keeps HOOK_DENIED and retry-blocked B never carries A denial', async () => {
    const { runtime } = createTestRuntime({ maxStepsPerRun: 4 });
    registerTools(runtime, false);
    denyHookFor('a_tool');
    forceRetryFor(runtime, 'b_tool');

    const provider = new ScriptedLLMProvider([
      {
        toolCalls: [
          { id: 'call-a', name: 'a_tool', arguments: { a: 1 } },
          { id: 'call-b', name: 'b_tool', arguments: { b: 1 } },
        ],
      },
      { response: 'done', finishReason: 'stop' },
    ]);
    runtime.registerProvider('mock', provider);

    await runtime.execute(makeContext({ availableTools: ['a_tool', 'b_tool'] }));

    expect(executed).toEqual([]);

    const byId = toolMessagesByCallId(provider);
    const a = byId.get('call-a') ?? '';
    const b = byId.get('call-b') ?? '';

    // B is its own retry-loop cause; A's denial text never bleeds into B.
    expect(b).not.toContain('plugin denied a_tool');
    expect(b).toMatch(/Retry loop detected: b_tool/);

    // A names its actual denying layer.
    expect(a).toMatch(/HOOK_DENIED/);
    expect(a).not.toMatch(/GUARDIAN_BLOCKED/);
  });

  it('concurrent batch: hook-denied A keeps HOOK_DENIED and retry-blocked B never carries A denial', async () => {
    const { runtime } = createTestRuntime({ maxStepsPerRun: 4 });
    registerTools(runtime, true);
    denyHookFor('a_tool');
    forceRetryFor(runtime, 'b_tool');

    const provider = new ScriptedLLMProvider([
      {
        toolCalls: [
          { id: 'call-a', name: 'a_tool', arguments: { a: 1 } },
          { id: 'call-b', name: 'b_tool', arguments: { b: 1 } },
        ],
      },
      { response: 'done', finishReason: 'stop' },
    ]);
    runtime.registerProvider('mock', provider);

    await runtime.execute(makeContext({ availableTools: ['a_tool', 'b_tool'] }));

    expect(executed).toEqual([]);

    const byId = toolMessagesByCallId(provider);
    const a = byId.get('call-a') ?? '';
    const b = byId.get('call-b') ?? '';

    expect(a).toMatch(/HOOK_DENIED/);
    expect(a).not.toMatch(/GUARDIAN_BLOCKED/);
    expect(b).not.toContain('plugin denied a_tool');
  });

  it('POLICY_DENIED side-effect denial is surfaced as POLICY_DENIED, never as a Guardian denial', async () => {
    setSideEffectGate({
      admit: async (_request: SideEffectRequest) => {
        throw new SideEffectGateError('POLICY_DENIED', 'captured for test');
      },
    } as never);

    const execute = vi.fn(async () => 'must not execute');
    const service = new ToolExecutionService({
      tools: new Map([
        [
          'file_write',
          {
            definition: { name: 'file_write', description: 'effect fixture', inputSchema: {} },
            execute,
          },
        ],
      ]) as never,
      compensationService: {
        getRegistry: () => ({
          assessReversibility: () => 'partially_reversible',
          recordAction: vi.fn(),
          compensate: async () => ({ success: true }),
        }),
        handleMutationToolFailure: async () => undefined,
      } as never,
      cacheManager: {} as never,
      dlq: {} as never,
      getRunHandle: () => null,
      config: { timeoutMs: 1000, observationMaskWindow: 4 } as never,
      reflexionGenerator: {} as never,
      stepTimeout: {} as never,
      getPromotedTools: () => new Set(),
      generateActionId: () => 'action-policy-denied',
      getBreakerRegistry: () => ({ get: () => null }) as never,
      reversibilityGate: { evaluate: async () => ({ allowed: true }) } as never,
    });

    let result: Awaited<ReturnType<typeof service.execute>>;
    try {
      result = await service.execute(
        'run-policy-denied',
        { id: 'call-policy', name: 'file_write', arguments: { action: 'write' } },
        'agent-policy-denied',
      );
    } finally {
      resetSideEffectGate();
    }

    expect(result.error).toMatch(/^POLICY_DENIED/);
    expect(result.error).not.toContain('GUARDIAN_BLOCKED');
    expect(execute).not.toHaveBeenCalled();
  });
});
