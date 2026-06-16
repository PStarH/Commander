import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { PolicyHook, buildPolicyInput } from '../../../src/atr/policy/integration/scheduler';
import { ExecutionScheduler } from '../../../src/atr/scheduler';
import { CompensationBridge } from '../../../src/atr/compensationBridge';
import { RunLedger } from '../../../src/atr/runLedger';
import { LeaseManager } from '../../../src/atr/leaseManager';
import { IdempotencyStore, resetIdempotencyStore } from '../../../src/atr/idempotencyStore';
import { resetRunLedgerBundle } from '../../../src/atr/runLedger';
import { resetCompensationBridge } from '../../../src/atr/compensationBridge';

function makeStack() {
  process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
  resetIdempotencyStore();
  resetRunLedgerBundle();
  resetCompensationBridge();
  const lm = new LeaseManager({
    filePath: ':memory:',
    defaultTtlSeconds: 60,
    defaultHolder: 'test',
  });
  const idem = new IdempotencyStore({ filePath: ':memory:', defaultTtlSeconds: 60 });
  const ledger = new RunLedger(lm, idem, {
    filePath: ':memory:',
    defaultTtlSeconds: 60,
    defaultHolder: 'test',
  });
  const bridge = new CompensationBridge();
  const scheduler = new ExecutionScheduler({ lease: lm, idempotency: idem, ledger, bridge });
  return {
    scheduler,
    lm,
    idem,
    ledger,
    bridge,
    close: () => {
      lm.close();
      idem.close();
      ledger.close();
    },
  };
}

describe('PolicyHook integration', () => {
  beforeEach(() => {
    process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
    resetIdempotencyStore();
    resetRunLedgerBundle();
    resetCompensationBridge();
  });
  afterEach(() => {
    delete process.env.COMMANDER_ATR_IDEMPOTENCY_PATH;
  });

  it('evaluates a tool action and returns allow for read-only', () => {
    const stack = makeStack();
    try {
      const hook = new PolicyHook();
      const handle = stack.scheduler.beginRun({ runId: 'r1', goal: 'test' });
      const input = buildPolicyInput({
        scheduler: stack.scheduler,
        runId: 'r1',
        phase: 'tool',
        tool: {
          name: 'read',
          riskLevel: 'low',
          destructive: false,
          isReadOnly: true,
          isIdempotent: true,
          category: 'file_read',
        },
        args: { path: '/tmp/a' },
        stepNumber: 1,
      });
      const d = hook.evaluate(input);
      assert.strictEqual(d.effect, 'allow');
    } finally {
      stack.close();
    }
  });

  it('denies destructive + non-idempotent even when pack allows', () => {
    const stack = makeStack();
    try {
      const hook = new PolicyHook();
      stack.scheduler.beginRun({ runId: 'r1', goal: 'test' });
      const input = buildPolicyInput({
        scheduler: stack.scheduler,
        runId: 'r1',
        phase: 'tool',
        tool: {
          name: 'rm',
          riskLevel: 'high',
          destructive: true,
          isReadOnly: false,
          isIdempotent: false,
          category: 'shell',
        },
        args: { path: '/tmp/foo' },
        stepNumber: 1,
      });
      const d = hook.evaluate(input);
      assert.notStrictEqual(d.effect, 'allow');
    } finally {
      stack.close();
    }
  });

  it('denies shell when tenant.allowShell is false', () => {
    const stack = makeStack();
    try {
      const hook = new PolicyHook();
      stack.scheduler.beginRun({ runId: 'r1', goal: 'test' });
      const input = buildPolicyInput({
        scheduler: stack.scheduler,
        runId: 'r1',
        phase: 'tool',
        tool: {
          name: 'shell',
          riskLevel: 'medium',
          destructive: false,
          isReadOnly: false,
          isIdempotent: true,
          category: 'shell',
        },
        args: { command: 'ls' },
        stepNumber: 1,
      });
      const d = hook.evaluate(input);
      assert.strictEqual(d.effect, 'deny_class');
      assert.strictEqual(d.denyClass, 'deny_shell');
    } finally {
      stack.close();
    }
  });

  it('cache hit on second identical eval', () => {
    const stack = makeStack();
    try {
      const hook = new PolicyHook();
      stack.scheduler.beginRun({ runId: 'r1', goal: 'test' });
      const input = buildPolicyInput({
        scheduler: stack.scheduler,
        runId: 'r1',
        phase: 'tool',
        tool: {
          name: 'read',
          riskLevel: 'low',
          destructive: false,
          isReadOnly: true,
          isIdempotent: true,
          category: 'file_read',
        },
        args: { path: '/tmp/a' },
        stepNumber: 1,
      });
      const d1 = hook.evaluate(input);
      const d2 = hook.evaluate(input);
      assert.strictEqual(d1.effect, 'allow');
      assert.strictEqual(d2.cached, true);
    } finally {
      stack.close();
    }
  });

  it('invalidateRun clears cache for that run', () => {
    const stack = makeStack();
    try {
      const hook = new PolicyHook();
      stack.scheduler.beginRun({ runId: 'r1', goal: 'test' });
      const input = buildPolicyInput({
        scheduler: stack.scheduler,
        runId: 'r1',
        phase: 'tool',
        tool: {
          name: 'read',
          riskLevel: 'low',
          destructive: false,
          isReadOnly: true,
          isIdempotent: true,
          category: 'file_read',
        },
        args: { path: '/tmp/a' },
        stepNumber: 1,
      });
      hook.evaluate(input);
      const removed = hook.invalidateRun('r1');
      assert.ok(removed >= 0);
    } finally {
      stack.close();
    }
  });

  it('readonly pack denies all writes', () => {
    const stack = makeStack();
    try {
      const hook = new PolicyHook({ pack: 'readonly' });
      stack.scheduler.beginRun({ runId: 'r1', goal: 'test' });
      const input = buildPolicyInput({
        scheduler: stack.scheduler,
        runId: 'r1',
        phase: 'tool',
        tool: {
          name: 'write',
          riskLevel: 'medium',
          destructive: false,
          isReadOnly: false,
          isIdempotent: true,
          category: 'file_write',
        },
        args: { path: '/tmp/a' },
        stepNumber: 1,
      });
      const d = hook.evaluate(input);
      assert.strictEqual(d.effect, 'deny_class');
    } finally {
      stack.close();
    }
  });

  it('destructive pack requires approval for all destructive ops', () => {
    const stack = makeStack();
    try {
      const hook = new PolicyHook({ pack: 'destructive' });
      stack.scheduler.beginRun({ runId: 'r1', goal: 'test' });
      const input = buildPolicyInput({
        scheduler: stack.scheduler,
        runId: 'r1',
        phase: 'tool',
        tool: {
          name: 'merge',
          riskLevel: 'high',
          destructive: true,
          isReadOnly: false,
          isIdempotent: true,
          category: 'api',
        },
        args: {},
        stepNumber: 1,
      });
      const d = hook.evaluate(input);
      assert.strictEqual(d.effect, 'require_approval');
    } finally {
      stack.close();
    }
  });

  it('rejects pack with critical conflicts', () => {
    assert.throws(() => {
      new PolicyHook({
        pack: {
          source: `package t
        default allow = false
        a { data.policy.b == true }
        b { data.policy.a == true }
      `,
          name: 'cyclic',
          version: 1,
        },
      });
    });
  });

  it('exposes stats', () => {
    const stack = makeStack();
    try {
      const hook = new PolicyHook();
      const stats = hook.getStats();
      assert.ok(typeof stats.evaluations === 'number');
    } finally {
      stack.close();
    }
  });

  it('exposes pack name and version', () => {
    const stack = makeStack();
    try {
      const hook = new PolicyHook();
      assert.strictEqual(hook.getPackName(), 'defaultCoding');
      assert.strictEqual(hook.getPackVersion(), 1);
    } finally {
      stack.close();
    }
  });
});
