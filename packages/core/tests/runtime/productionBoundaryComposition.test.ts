/**
 * Production boundary composition — SideEffectGate → ToolExecutionService.
 *
 * What this file proves (and what it deliberately does not)
 * --------------------------------------------------------
 * The rest of the tool-loop suite installs the always-admit unit fixture
 * (`tests/helpers/runtimeUnitFixture.ts`) so that tool bodies run without a
 * full ATR run handle. That fixture makes "admitted" the default, which means
 * a regression in the *production* admission path is invisible to those tests.
 *
 * This file is the counterpart: it installs the **real** `SideEffectGate`
 * (`resetSideEffectGate()` → `getSideEffectGate()` constructs a real gate) and
 * asserts the composed behaviour of the two layers together:
 *
 *   - denial  → the tool body is invoked **0** times and the caller receives a
 *               structured `SIDE_EFFECT_GATE` error, and
 *   - grant   → the tool body is invoked exactly **1** time.
 *
 * Invariant under test: *no external effect without a valid ATR RunHandle*
 * (`sideEffectGate.ts` invariant 1). Before this file existed, `NO_RUN_HANDLE`
 * was only ever asserted against the `SideEffectGate` class in isolation —
 * never through the service that production actually calls.
 *
 * This file must NOT import the always-admit fixture for its denial cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ToolExecutionService } from '../../src/runtime/toolExecutionService';
import { getSideEffectGate, resetSideEffectGate } from '../../src/runtime/sideEffectGate';
import { installAlwaysAdmitGate } from '../helpers/runtimeUnitFixture';

/** Build a ToolExecutionService whose tool body records its invocations. */
function makeService(toolName: string, execute: () => Promise<string>) {
  const recordAction = vi.fn();
  const service = new ToolExecutionService({
    tools: new Map([
      [
        toolName,
        {
          definition: { name: toolName, description: 'boundary fixture', inputSchema: {} },
          execute,
        },
      ],
    ]) as never,
    compensationService: {
      getRegistry: () => ({
        assessReversibility: vi.fn(() => 'partially_reversible'),
        recordAction,
        compensate: async () => ({ success: true }),
      }),
      handleMutationToolFailure: async () => undefined,
    } as never,
    cacheManager: {} as never,
    dlq: { record: vi.fn() } as never,
    // No ATR run handle: this is the production-unsafe precondition the gate
    // must refuse.
    getRunHandle: () => null,
    config: { timeoutMs: 1000, observationMaskWindow: 4 } as never,
    reflexionGenerator: {} as never,
    // Pass-through timeout wrapper: the real one races the tool against a
    // timer. An empty stub would make `tool.execute` throw (TypeError on
    // `.wrap`), which the retry boundary would then re-invoke — turning a
    // one-shot assertion into a confusing "called 2 times".
    stepTimeout: {
      wrap: <T>(promise: Promise<T>) => promise,
    } as never,
    getPromotedTools: () => new Set(),
    generateActionId: () => 'action-boundary-1',
    getBreakerRegistry: () => ({ get: () => null }) as never,
    reversibilityGate: {
      evaluate: vi.fn(async () => ({
        allowed: true,
        reversibility: 'reversible',
        reason: 'test',
        requiresHumanApproval: false,
      })),
    } as never,
  });
  return { service, recordAction };
}

const CALL = {
  id: 'call-boundary-1',
  name: 'file',
  arguments: { action: 'write', path: 'boundary.txt' },
};

describe('production boundary composition: gate → ToolExecutionService', () => {
  beforeEach(() => {
    // Real gate, not the unit fixture.
    resetSideEffectGate();
  });

  afterEach(() => {
    resetSideEffectGate();
  });

  it('constructs the real (fail-closed) gate by default, not a permissive stub', () => {
    const gate = getSideEffectGate();
    // A real gate exposes admit() and refuses without a run handle. The unit
    // stub answers every request; this asserts we are NOT looking at it.
    expect(typeof gate.admit).toBe('function');
    expect(gate).not.toHaveProperty('__alwaysAdmit');
  });

  it('denies a side effect with no ATR RunHandle and never invokes the tool body', async () => {
    const execute = vi.fn(async () => 'MUST NOT RUN');
    const { service } = makeService('file', execute);

    const result = await service.execute('run-boundary-1', CALL, 'agent-boundary-1');

    // 0 tool-body invocations: the effect never happened.
    expect(execute).not.toHaveBeenCalled();
    // Structured, caller-visible rejection.
    expect(result.output).toBe('');
    expect(result.error).toMatch(/SIDE_EFFECT_GATE: NO_RUN_HANDLE/);
  });

  it('invokes the tool body exactly once when admission is explicitly granted', async () => {
    const restore = installAlwaysAdmitGate();
    try {
      const execute = vi.fn(async () => 'ran');
      const { service } = makeService('file', execute);

      const result = await service.execute('run-boundary-2', CALL, 'agent-boundary-2');

      // 1 tool-body invocation: the grant is what lets the effect through.
      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.error).toBeUndefined();
      expect(result.output).toBe('ran');
    } finally {
      restore();
    }
  });

  it('restores the real fail-closed gate once the fixture is torn down', async () => {
    const restore = installAlwaysAdmitGate();
    restore();

    const execute = vi.fn(async () => 'MUST NOT RUN');
    const { service } = makeService('file', execute);
    const result = await service.execute('run-boundary-3', CALL, 'agent-boundary-3');

    expect(execute).not.toHaveBeenCalled();
    expect(result.error).toMatch(/SIDE_EFFECT_GATE: NO_RUN_HANDLE/);
  });
});
