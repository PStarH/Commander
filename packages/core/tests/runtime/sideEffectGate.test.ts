/**
 * SideEffectGate — Architecture V2 mandatory PEP for every external effect.
 *
 * Verifies the fail-closed invariants of the gate that all tool/provider side
 * effects must pass through. The success path (allow → scheduleAction) is
 * exercised end-to-end by the worker-plane integration suite; this file
 * isolates the **negative** paths that are easy to regress in a refactor
 * and are the security-critical half of the gate:
 *
 *   1. NO_RUN_HANDLE: effect must be rejected when no ATR RunHandle is
 *      supplied in fail-closed mode (production / V2 default).
 *   2. Soft bypass shim removed (WS2): COMMANDER_EFFECT_BROKER_COMPAT no longer
 *      admits without a runHandle — missing handle always rejects.
 *   3. Explicit failClosed / production / V2 mode remain fail-closed.
 *   4. SideEffectGateError surfaces code, decision, and interactionId for
 *      callers that need to translate the rejection into a structured
 *      response (HTTP 4xx, gap registry, etc.).
 *   5. The module-level singleton (`getSideEffectGate` /
 *      `resetSideEffectGate` / `setSideEffectGate`) is wired correctly so
 *      that the global getter used by ToolExecutionService and the
 *      instance injected by tests don't drift.
 *
 * These paths are unit-isolated: they do not require a live scheduler
 * (which depends on better-sqlite3) — the gate throws before reaching
 * `getExecutionScheduler().scheduleAction` when the precondition fails.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  SideEffectGate,
  SideEffectGateError,
  getSideEffectGate,
  resetSideEffectGate,
  setSideEffectGate,
  buildSideEffectPolicyInput,
  type SideEffectRequest,
} from '../../src/runtime/sideEffectGate';
import type { RunHandle } from '../../src/atr/scheduler';
import { classifyToolEffect, isMutationTool } from '../../src/runtime/runtimeHelpers';
import { ToolExecutionService } from '../../src/runtime/toolExecutionService';
import { trackExecutedMutation } from '../../src/runtime/toolExecutionHandler';
import { ReversibilityGate } from '../../src/security/reversibilityGate';

const CONSOLIDATED_EFFECT_CASES = [
  ['file', 'write', true, true, 'file_write', 'file_write', 'file_write'],
  ['file', 'edit', true, true, 'file_write', 'file_edit', 'file_edit'],
  ['file', 'read', false, false, 'file_read', 'file_read', undefined],
  ['file', 'search', false, false, 'file_read', 'file_search', undefined],
  ['file', 'list', false, false, 'file_read', 'file_list', undefined],
  ['file', 'glob', false, false, 'file_read', 'glob', undefined],
  ['memory', 'store', true, true, 'destructive', 'memory_store', 'memory_store'],
  ['memory', 'recall', false, false, 'api', 'memory_recall', undefined],
  ['memory', 'list', false, false, 'api', 'memory_list', undefined],
  ['web', 'search', false, false, 'network', 'web_search', undefined],
  ['web', 'fetch', false, false, 'network', 'web_fetch', undefined],
  ['browser', 'search', false, false, 'network', 'browser_search', undefined],
  ['browser', 'fetch', false, false, 'network', 'browser_fetch', undefined],
  ['code', 'refine', true, true, 'file_write', 'refine_code', 'code_refiner'],
  ['code', 'fix', true, true, 'file_write', 'fix_code', 'code_fixer'],
  ['code', 'search', false, false, 'compute', 'code_search', undefined],
  ['checkpoint', 'save', true, false, 'destructive', 'checkpoint_save', undefined],
  ['checkpoint', 'rewind', true, false, 'destructive', 'checkpoint_rewind', undefined],
  ['checkpoint', 'collapse', true, false, 'destructive', 'checkpoint_collapse', undefined],
  ['checkpoint', 'list', false, false, 'api', 'checkpoint_list', undefined],
  ['handoff', 'send', true, false, 'api', 'handoff', undefined],
  ['handoff', 'check', false, false, 'api', 'handoff_check', undefined],
  ['exec', 'shell', true, false, 'shell', 'shell_execute', undefined],
  ['exec', 'python', true, false, 'shell', 'python_execute', undefined],
  ['exec', 'script', true, false, 'shell', 'execute_script', undefined],
  ['media', 'screenshot', true, false, 'file_write', 'screenshot_capture', undefined],
  ['media', 'analyze_image', false, false, 'compute', 'vision_analyze', undefined],
  ['media', 'extract_pdf', false, false, 'compute', 'pdf_extract', undefined],
  ['system', 'human_input', true, false, 'api', 'request_human_input', undefined],
  ['system', 'tool_schema', false, false, 'api', 'request_tool', undefined],
  ['file', 'unknown_action', true, false, 'unknown', 'file', undefined],
  ['unknown_tool', 'read', true, false, 'unknown', 'unknown_tool', undefined],
] as const;

describe('consolidated tool effect classification', () => {
  const scheduler = {
    getRun: () => ({
      state: 'EXECUTING',
      fencingEpoch: 1,
      intentHash: 'intent-1',
      tenantId: 'tenant-A',
      createdAt: new Date().toISOString(),
      actions: [],
      metadata: {},
    }),
  } as never;

  it.each(CONSOLIDATED_EFFECT_CASES)(
    'maps %s action=%s into its policy and compensation effect',
    (name, action, destructive, compensable, category, semanticToolName, compensationToolName) => {
      const args = { action };
      const effect = classifyToolEffect(name, args);
      expect(isMutationTool(name, args)).toBe(destructive);
      expect(effect.compensable).toBe(compensable);
      expect(effect.semanticToolName).toBe(semanticToolName);
      expect(effect.compensationToolName).toBe(compensationToolName);

      const input = buildSideEffectPolicyInput(
        {
          ...baseRequest({ toolName: name, args, effect }),
          runHandle: _fakeHandle,
        },
        scheduler,
      );
      expect(input.tool).toMatchObject({
        destructive,
        isReadOnly: !destructive,
        category,
        riskLevel: destructive ? 'high' : 'medium',
      });
    },
  );

  it.each(CONSOLIDATED_EFFECT_CASES)(
    'passes %s action=%s through ToolExecutionService',
    async (
      name,
      action,
      destructive,
      recordsCompensation,
      _category,
      semanticToolName,
      compensationToolName,
    ) => {
      const args = { action };
      let captured: SideEffectRequest | undefined;
      setSideEffectGate({
        admit: async (request: SideEffectRequest) => {
          captured = request;
          throw new SideEffectGateError('POLICY_DENIED', 'captured for test');
        },
      } as never);

      const recordAction = vi.fn();
      const assessReversibility = vi.fn(() => 'partially_reversible');
      const evaluateReversibility = vi.fn(async () => ({
        allowed: true,
        reversibility: 'reversible',
        reason: 'test',
        requiresHumanApproval: false,
      }));
      const service = new ToolExecutionService({
        tools: new Map([
          [
            name,
            {
              definition: { name, description: 'effect fixture', inputSchema: {} },
              execute: async () => 'not reached',
            },
          ],
        ]) as never,
        compensationService: {
          getRegistry: () => ({
            assessReversibility,
            recordAction,
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
        generateActionId: () => `action-${name}-${String(args.action)}`,
        getBreakerRegistry: () => ({ get: () => null }) as never,
        reversibilityGate: { evaluate: evaluateReversibility } as never,
      });

      try {
        await service.execute(
          'run-effect',
          { id: `call-${name}-${String(args.action)}`, name, arguments: { ...args } },
          'agent-effect',
        );
      } finally {
        resetSideEffectGate();
      }

      const expectedEffect = classifyToolEffect(name, args);
      expect(captured?.effect).toEqual(expectedEffect);
      expect(captured?.effect.destructive).toBe(destructive);
      if (destructive) {
        expect(assessReversibility).toHaveBeenCalledWith(semanticToolName);
      } else {
        expect(assessReversibility).not.toHaveBeenCalled();
      }
      expect(evaluateReversibility).toHaveBeenCalledWith(
        semanticToolName,
        args,
        expect.objectContaining({ runId: 'run-effect', agentId: 'agent-effect' }),
      );
      expect(recordAction).toHaveBeenCalledTimes(recordsCompensation ? 1 : 0);
      if (recordsCompensation) {
        expect(recordAction).toHaveBeenCalledWith(
          expect.objectContaining({ toolName: compensationToolName }),
        );
      }
    },
  );

  it.each(CONSOLIDATED_EFFECT_CASES)(
    'tracks %s action=%s through ToolExecutionHandler',
    (name, action, destructive) => {
      const executedMutations: Array<{ toolName: string; args: Record<string, unknown> }> = [];

      trackExecutedMutation(executedMutations, {
        name,
        arguments: { action },
      });

      expect(executedMutations).toEqual(destructive ? [{ toolName: name, args: { action } }] : []);
    },
  );

  it.each([
    ['file_read', { path: 'README.md' }],
    ['memory_recall', { key: 'decision' }],
  ])('keeps the local semantic read control %s reversible', async (toolName, args) => {
    const decision = await new ReversibilityGate().evaluate(toolName, args);
    expect(decision).toMatchObject({ allowed: true, reversibility: 'reversible' });
  });

  it.each([
    ['web_fetch', { url: 'https://example.test' }],
    ['browser_search', { query: 'security boundary' }],
    ['browser_fetch', { url: 'https://example.test' }],
  ])('keeps the external network control %s irreversible', async (toolName, args) => {
    const decision = await new ReversibilityGate().evaluate(toolName, args);
    expect(decision).toMatchObject({
      allowed: false,
      reversibility: 'irreversible',
      requiresHumanApproval: true,
    });
  });

  it.each(['checkpoint_save', 'checkpoint_rewind', 'checkpoint_collapse'])(
    'does not let the checkpoint prefix mark %s reversible',
    async (toolName) => {
      const decision = await new ReversibilityGate().evaluate(toolName, {});
      expect(decision).toMatchObject({
        allowed: false,
        reversibility: 'irreversible',
        requiresHumanApproval: true,
      });
    },
  );
});

const baseRequest = (overrides: Partial<SideEffectRequest> = {}): SideEffectRequest => ({
  runHandle: null,
  toolName: 'shell_execute',
  externalSystem: 'os.shell',
  args: { command: 'ls' },
  stepId: 'step-1',
  effect: classifyToolEffect('shell_execute', { command: 'ls' }),
  tenantId: 'tenant-A',
  ...overrides,
});

// A plausible RunHandle stub — the gate only inspects runId/tenantId/
// intentHash when computing the idempotency key, but the handle must
// be truthy for the success path. Not used by these negative-path
// tests, but kept here so future positive-path tests can import it.
const _fakeHandle: RunHandle = {
  runId: 'run-1',
  state: 'EXECUTING',
  leaseToken: 'lease-1',
  fencingEpoch: 1,
  intentHash: 'intent-1',
  tenantId: 'tenant-A',
  metadata: {},
  createdAt: new Date().toISOString(),
  resumed: false,
  acquired: true,
};
void _fakeHandle;

describe('SideEffectGate — V2 mandatory PEP', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalV2Mode = process.env.COMMANDER_V2_MODE;
  const originalCompat = process.env.COMMANDER_EFFECT_BROKER_COMPAT;

  beforeEach(() => {
    // Clean slate — every test starts with the gate in its default
    // (fail-closed) posture regardless of how the previous test left
    // the env.
    resetSideEffectGate();
    delete process.env.COMMANDER_EFFECT_BROKER_COMPAT;
    delete process.env.COMMANDER_V2_MODE;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    resetSideEffectGate();
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalV2Mode === undefined) {
      delete process.env.COMMANDER_V2_MODE;
    } else {
      process.env.COMMANDER_V2_MODE = originalV2Mode;
    }
    if (originalCompat === undefined) {
      delete process.env.COMMANDER_EFFECT_BROKER_COMPAT;
    } else {
      process.env.COMMANDER_EFFECT_BROKER_COMPAT = originalCompat;
    }
  });

  // ─── 1. NO_RUN_HANDLE fail-closed ─────────────────────────────────────────

  describe('NO_RUN_HANDLE in fail-closed mode (default)', () => {
    it('rejects effect when runHandle is null and failClosed is forced', async () => {
      const gate = new SideEffectGate({ failClosed: true });
      const req = baseRequest({ runHandle: null });

      try {
        await gate.admit(req);
        throw new Error('expected SideEffectGateError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SideEffectGateError);
        const e = err as SideEffectGateError;
        expect(e.code).toBe('NO_RUN_HANDLE');
        expect(e.name).toBe('SideEffectGateError');
        expect(e.message).toMatch(/no ATR RunHandle/);
        expect(e.message).toMatch(/Architecture V2 invariant/);
        // No decision was evaluated; interactionId must be absent.
        expect(e.decision).toBeUndefined();
        expect(e.interactionId).toBeUndefined();
      }
    });

    it('rejects effect when runHandle is undefined (typed as null | undefined)', async () => {
      const gate = new SideEffectGate({ failClosed: true });
      const req = baseRequest({ runHandle: undefined });

      await expect(gate.admit(req)).rejects.toMatchObject({
        name: 'SideEffectGateError',
        code: 'NO_RUN_HANDLE',
      });
    });

    it('fails closed in production regardless of compat flag', async () => {
      process.env.NODE_ENV = 'production';
      process.env.COMMANDER_EFFECT_BROKER_COMPAT = '1';
      // In production, the gate defaults failClosed=true; we *also*
      // force it explicitly to catch a future refactor that might
      // accidentally narrow the constructor default.
      // Inject a stub interaction store: production refuses SqliteInteractionStore(':memory:'),
      // and this test only asserts admit() fail-closed on missing runHandle.
      const gate = new SideEffectGate({
        failClosed: true,
        interactionStore: {
          create: vi.fn(),
          get: vi.fn(),
          answer: vi.fn(),
          listPending: vi.fn(),
        } as never,
      });
      await expect(gate.admit(baseRequest({ runHandle: null }))).rejects.toMatchObject({
        code: 'NO_RUN_HANDLE',
      });
    });

    it('fails closed under COMMANDER_V2_MODE=1 even outside production', async () => {
      process.env.COMMANDER_V2_MODE = '1';
      process.env.COMMANDER_EFFECT_BROKER_COMPAT = '1';
      const gate = new SideEffectGate({ failClosed: true });
      await expect(gate.admit(baseRequest({ runHandle: null }))).rejects.toMatchObject({
        code: 'NO_RUN_HANDLE',
      });
    });
  });

  // ─── 2. Soft bypass (dev-only) ────────────────────────────────────────────

  describe('Soft bypass when explicit compat flag is set', () => {
    it('still rejects missing runHandle — soft bypass shim is removed', async () => {
      process.env.COMMANDER_EFFECT_BROKER_COMPAT = '1';
      process.env.NODE_ENV = 'test';
      const gate = new SideEffectGate();
      const req = baseRequest({ runHandle: null, stepId: 's-soft' });

      await expect(gate.admit(req)).rejects.toMatchObject({
        name: 'SideEffectGateError',
        code: 'NO_RUN_HANDLE',
      });
    });

    it('explicit failClosed rejects missing runHandle', async () => {
      process.env.COMMANDER_EFFECT_BROKER_COMPAT = '1';
      const gate = new SideEffectGate({ failClosed: true });
      await expect(gate.admit(baseRequest({ runHandle: null }))).rejects.toMatchObject({
        code: 'NO_RUN_HANDLE',
      });
    });

    it('does not bypass without the explicit env flag (silent fail-closed)', async () => {
      // No COMMANDER_EFFECT_BROKER_COMPAT set. failClosed is also off
      // (test mode), so the gate should still throw — soft bypass is
      // opt-in, never implicit.
      const gate = new SideEffectGate();
      await expect(gate.admit(baseRequest({ runHandle: null }))).rejects.toMatchObject({
        code: 'NO_RUN_HANDLE',
      });
    });
  });

  // ─── 3. SideEffectGateError shape ────────────────────────────────────────

  describe('SideEffectGateError shape', () => {
    it('exposes a typed code union, never a free string', () => {
      const codes: SideEffectGateError['code'][] = [
        'NO_RUN_HANDLE',
        'POLICY_DENIED',
        'POLICY_REQUIRES_APPROVAL',
        'SCHEDULE_FAILED',
        'ATR_REQUIRED',
      ];
      const e = new SideEffectGateError(codes[0]!, 'msg');
      expect(codes).toContain(e.code);
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(SideEffectGateError);
    });

    it('preserves the decision and interactionId passed by the gate', () => {
      const fakeDecision = {
        effect: 'require_approval' as const,
        reason: 'needs human',
        decisionPath: ['destructive'],
        matchedRule: 'r1',
        riskScore: 0.5,
        budget: {
          tokensUsed: 0,
          tokensBudget: 0,
          actionsUsed: 0,
          actionsBudget: 0,
          estimatedCostUsd: 0,
        },
        latencyMs: 0,
        cached: false,
        cacheable: false,
        decisionId: 'd1',
        packVersion: 1,
        packName: 'defaultCoding',
        tenantId: 't',
        runId: 'r',
      };
      const e = new SideEffectGateError(
        'POLICY_REQUIRES_APPROVAL',
        'needs approval',
        fakeDecision,
        'interaction-xyz',
      );
      expect(e.decision).toBe(fakeDecision);
      expect(e.interactionId).toBe('interaction-xyz');
      // The cause is not a wrapped Error — callers should read .code
      // and .message, never `instanceof` against a specific subclass.
      expect(e.cause).toBeUndefined();
    });
  });

  // ─── 4. Singleton lifecycle ───────────────────────────────────────────────

  describe('module-level singleton', () => {
    it('getSideEffectGate returns the same instance on repeated calls', () => {
      const a = getSideEffectGate();
      const b = getSideEffectGate();
      expect(a).toBe(b);
    });

    it('resetSideEffectGate clears the cached singleton', () => {
      const a = getSideEffectGate();
      resetSideEffectGate();
      const b = getSideEffectGate();
      expect(b).not.toBe(a);
    });

    it('setSideEffectGate injects a custom instance used by subsequent gets', () => {
      const custom = new SideEffectGate({ failClosed: true });
      setSideEffectGate(custom);
      expect(getSideEffectGate()).toBe(custom);
    });

    it('setSideEffectGate is overridable by reset+get, so tests can recover', () => {
      const custom = new SideEffectGate({ failClosed: true });
      setSideEffectGate(custom);
      resetSideEffectGate();
      // After reset, getSideEffectGate must return a fresh default
      // instance, not the previously injected one.
      const fresh = getSideEffectGate();
      expect(fresh).not.toBe(custom);
      expect(fresh).toBeInstanceOf(SideEffectGate);
    });
  });

  // ─── 5. Logger noise guard (regression: a regression introduced a
  //       test that called the global logger from a no-handle path
  //       and produced 50+ lines per test run). We assert that the
  //       gate does not invoke the global logger on the fast-fail
  //       path, because audit volume from "every shell call has no
  //       run handle" would dwarf real signals.

  it('does not invoke the global logger when the gate fast-fails', async () => {
    const warn = vi.fn();
    const loggerModule = await import('../../src/logging');
    const original = loggerModule.getGlobalLogger();
    const spy = vi
      .spyOn(loggerModule, 'getGlobalLogger')
      .mockReturnValue({ ...original, warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() });

    const gate = new SideEffectGate({ failClosed: true });
    await expect(gate.admit(baseRequest({ runHandle: null }))).rejects.toMatchObject({
      code: 'NO_RUN_HANDLE',
    });

    // The fast-fail NO_RUN_HANDLE branch must not produce a warn
    // entry — the throw is itself the signal. The soft-bypass branch
    // does warn (see integration tests), and we want to keep that
    // behavior distinct.
    expect(warn).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
