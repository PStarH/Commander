import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  ApprovalSystem,
  type ApprovalRequest,
  type ApprovalDecision,
} from '../../src/sandbox/approval';
import { ExecPolicyEngine } from '../../src/sandbox/execPolicy';
import { createTestEnvSync, type TestEnv } from '../helpers/testEnv';

function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 'req-1',
    timestamp: Date.now(),
    gate: {
      category: 'file_write',
      action: 'write file',
      riskLevel: 'medium',
    },
    toolName: 'file_write',
    toolArgs: { path: '/tmp/test.txt', content: 'hello' },
    agentId: 'agent-1',
    runId: 'run-1',
    ...overrides,
  };
}

describe('ApprovalSystem', () => {
  let system: ApprovalSystem;
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnvSync('approval');
    const execPolicy = new ExecPolicyEngine();
    system = new ApprovalSystem(execPolicy, env.approvalDir);
  });

  afterEach(() => {
    env.cleanup();
  });

  // ── Mode management ────────────────────────────────────────────────────────

  describe('mode management', () => {
    it('defaults to suggest mode', () => {
      assert.strictEqual(system.getMode(), 'suggest');
    });

    it('can set and get mode', () => {
      system.setMode('full-auto');
      assert.strictEqual(system.getMode(), 'full-auto');
    });

    it('supports all 5 modes', () => {
      const modes = ['suggest', 'auto-edit', 'full-auto', 'read-only', 'plan'] as const;
      for (const mode of modes) {
        system.setMode(mode);
        assert.strictEqual(system.getMode(), mode);
      }
    });
  });

  // ── read-only mode ─────────────────────────────────────────────────────────

  describe('read-only mode', () => {
    beforeEach(() => system.setMode('read-only'));

    it('allows file_read', async () => {
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'file_read', action: 'read', riskLevel: 'low' },
        }),
      );
      assert.strictEqual(result.decision, 'approved');
    });

    it('blocks file_write', async () => {
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'file_write', action: 'write', riskLevel: 'medium' },
        }),
      );
      assert.strictEqual(result.decision, 'denied');
    });

    it('blocks shell_exec', async () => {
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'shell_exec', action: 'exec', riskLevel: 'high' },
        }),
      );
      assert.strictEqual(result.decision, 'denied');
    });

    it('blocks destructive', async () => {
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'destructive', action: 'rm -rf /', riskLevel: 'critical' },
        }),
      );
      assert.strictEqual(result.decision, 'denied');
    });

    it('blocks network', async () => {
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'network', action: 'curl', riskLevel: 'medium' },
        }),
      );
      assert.strictEqual(result.decision, 'denied');
    });

    it('blocks sandbox_escape', async () => {
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'sandbox_escape', action: 'escape', riskLevel: 'critical' },
        }),
      );
      assert.strictEqual(result.decision, 'denied');
    });
  });

  // ── plan mode ──────────────────────────────────────────────────────────────

  describe('plan mode', () => {
    beforeEach(() => system.setMode('plan'));

    it('blocks file_write', async () => {
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'file_write', action: 'write', riskLevel: 'medium' },
        }),
      );
      assert.strictEqual(result.decision, 'denied');
    });

    it('blocks destructive', async () => {
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'destructive', action: 'destroy', riskLevel: 'critical' },
        }),
      );
      assert.strictEqual(result.decision, 'denied');
    });

    it('allows file_read', async () => {
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'file_read', action: 'read', riskLevel: 'low' },
        }),
      );
      assert.strictEqual(result.decision, 'approved');
    });

    it('blocks shell_exec (treated as write)', async () => {
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'shell_exec', action: 'ls', riskLevel: 'low' },
        }),
      );
      assert.strictEqual(result.decision, 'denied');
    });
  });

  // ── suggest mode ───────────────────────────────────────────────────────────

  describe('suggest mode', () => {
    beforeEach(() => system.setMode('suggest'));

    it('allows file_write (defers to callback)', async () => {
      // No callback set, but non-destructive/non-escape should be approved
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'file_write', action: 'write', riskLevel: 'medium' },
        }),
      );
      assert.strictEqual(result.decision, 'approved');
    });

    it('defers destructive to callback', async () => {
      // No callback → denied (safe default when deferred)
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'destructive', action: 'rm -rf', riskLevel: 'critical' },
        }),
      );
      assert.strictEqual(result.decision, 'denied');
    });

    it('defers sandbox_escape to callback', async () => {
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'sandbox_escape', action: 'escape', riskLevel: 'critical' },
        }),
      );
      assert.strictEqual(result.decision, 'denied');
    });

    it('calls callback for deferred decisions', async () => {
      let callbackCalled = false;
      system.setCallback(async () => {
        callbackCalled = true;
        return 'approved_once';
      });

      await system.evaluate(
        makeRequest({
          gate: { category: 'destructive', action: 'rm -rf', riskLevel: 'critical' },
        }),
      );
      assert.strictEqual(callbackCalled, true);
    });

    it('callback approved_once returns approved_once', async () => {
      system.setCallback(async () => 'approved_once');
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'destructive', action: 'rm -rf', riskLevel: 'critical' },
        }),
      );
      assert.strictEqual(result.decision, 'approved_once');
    });

    it('callback approved_session caches approval', async () => {
      let callCount = 0;
      system.setCallback(async () => {
        callCount++;
        return 'approved_session';
      });

      const req = makeRequest({
        gate: { category: 'destructive', action: 'rm -rf', riskLevel: 'critical' },
      });
      await system.evaluate(req);
      await system.evaluate(req);
      assert.strictEqual(callCount, 1); // Second call uses cache
    });

    it('callback denied_forever blocks after threshold', async () => {
      system.setCallback(async () => 'denied_forever');

      const req = makeRequest({
        toolName: 'dangerous_tool',
        toolArgs: { cmd: 'destroy' },
        gate: { category: 'destructive', action: 'destroy', riskLevel: 'critical' },
      });

      // DENIED_THRESHOLD = 3: first 3 calls go to callback (denyCount 0,1,2),
      // 4th call sees denyCount=3 >= threshold and blocks without callback
      await system.evaluate(req); // denyCount -> 1
      await system.evaluate(req); // denyCount -> 2
      await system.evaluate(req); // denyCount -> 3
      const result = await system.evaluate(req); // blocked by threshold
      assert.strictEqual(result.decision, 'denied');
      assert.ok(result.reason.includes('Blocked after'));
    });
  });

  // ── auto-edit mode ─────────────────────────────────────────────────────────

  describe('auto-edit mode', () => {
    beforeEach(() => system.setMode('auto-edit'));

    it('allows file_write', async () => {
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'file_write', action: 'write', riskLevel: 'medium' },
        }),
      );
      assert.strictEqual(result.decision, 'approved');
    });

    it('allows shell_exec', async () => {
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'shell_exec', action: 'npm test', riskLevel: 'low' },
        }),
      );
      assert.strictEqual(result.decision, 'approved');
    });

    it('defers sandbox_escape', async () => {
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'sandbox_escape', action: 'escape', riskLevel: 'critical' },
        }),
      );
      assert.strictEqual(result.decision, 'denied'); // no callback → denied
    });

    it('defers destructive', async () => {
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'destructive', action: 'rm -rf /', riskLevel: 'critical' },
        }),
      );
      assert.strictEqual(result.decision, 'denied');
    });
  });

  // ── full-auto mode ─────────────────────────────────────────────────────────

  describe('full-auto mode', () => {
    beforeEach(() => system.setMode('full-auto'));

    it('approves everything', async () => {
      const categories = [
        'file_write',
        'shell_exec',
        'destructive',
        'network',
        'sandbox_escape',
        'mcp',
      ] as const;
      for (const category of categories) {
        const result = await system.evaluate(
          makeRequest({
            gate: { category, action: 'test', riskLevel: 'critical' },
          }),
        );
        assert.strictEqual(result.decision, 'approved', `full-auto should approve ${category}`);
      }
    });
  });

  // ── Policy evaluation (forbidden commands) ─────────────────────────────────

  describe('policy evaluation', () => {
    it('blocks forbidden commands regardless of mode', async () => {
      system.setMode('full-auto');
      // Use the command directly as toolName so ExecPolicyEngine matches 'sudo' pattern
      const result = await system.evaluate(
        makeRequest({
          toolName: 'sudo',
          toolArgs: { command: 'rm -rf /' },
        }),
      );
      assert.strictEqual(result.decision, 'denied');
    });

    it('blocks mkfs regardless of mode', async () => {
      system.setMode('full-auto');
      const result = await system.evaluate(
        makeRequest({
          toolName: 'mkfs',
          toolArgs: { device: '/dev/sda' },
        }),
      );
      assert.strictEqual(result.decision, 'denied');
    });
  });

  // ── Session approval caching ───────────────────────────────────────────────

  describe('session approval caching', () => {
    it('caches approved_session decisions', async () => {
      let callCount = 0;
      system.setMode('suggest');
      system.setCallback(async () => {
        callCount++;
        return 'approved_session';
      });

      const req = makeRequest({
        toolName: 'file_write',
        toolArgs: { path: '/tmp/test.txt' },
        gate: { category: 'file_write', action: 'write', riskLevel: 'medium' },
      });

      // In suggest mode, file_write is approved without callback
      // Let's use a category that defers
      const req2 = makeRequest({
        toolName: 'custom_tool',
        toolArgs: { cmd: 'test' },
        gate: { category: 'destructive', action: 'test', riskLevel: 'critical' },
      });

      await system.evaluate(req2);
      await system.evaluate(req2);
      assert.strictEqual(callCount, 1); // Second call uses cache
    });

    it('clearSessionApprovals clears cache', async () => {
      let callCount = 0;
      system.setMode('suggest');
      system.setCallback(async () => {
        callCount++;
        return 'approved_session';
      });

      const req = makeRequest({
        toolName: 'custom_tool',
        toolArgs: { cmd: 'test' },
        gate: { category: 'destructive', action: 'test', riskLevel: 'critical' },
      });

      await system.evaluate(req);
      system.clearSessionApprovals();
      await system.evaluate(req);
      assert.strictEqual(callCount, 2); // Cache cleared, callback called again
    });
  });

  // ── No callback fallback ───────────────────────────────────────────────────

  describe('no callback fallback', () => {
    it('denies deferred decisions when no callback is set', async () => {
      system.setMode('suggest');
      // No callback set
      const result = await system.evaluate(
        makeRequest({
          gate: { category: 'destructive', action: 'destroy', riskLevel: 'critical' },
        }),
      );
      assert.strictEqual(result.decision, 'denied');
    });
  });
});
