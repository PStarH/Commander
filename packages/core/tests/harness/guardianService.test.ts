/**
 * Tests for GuardianService — automated tool call approval reviewer.
 *
 * Covers:
 *   - Disabled guardian auto-approves
 *   - Read-only tools auto-approved without LLM call
 *   - Edit tools auto-approved via policy
 *   - LLM-based review (approve / reject / with suggestion)
 *   - Provider not available → fail-open
 *   - Empty response → auto-approve
 *   - Unparseable response → auto-approve
 *   - Provider call error → fail-open
 *   - Config update
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { GuardianService, DEFAULT_GUARDIAN_CONFIG } from '../../src/harness/guardianService';
import type { ToolCall } from '../../src/runtime/types';
import type { HarnessServices } from '../../src/harness/harnessTypes';

function makeToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `tc_${Date.now()}`, name, arguments: args };
}

function makeServices(providerOverride?: unknown): HarnessServices {
  // Use explicit undefined check so null is preserved (for "provider not available" tests)
  const provider =
    providerOverride !== undefined
      ? providerOverride
      : {
          call: async () => ({
            content: JSON.stringify({ approved: true, reason: 'Looks safe' }),
          }),
        };
  return {
    getProvider: () => provider as any,
  } as unknown as HarnessServices;
}

describe('GuardianService', () => {
  describe('constructor and config', () => {
    it('uses default config', () => {
      const svc = new GuardianService();
      const config = svc.getConfig();
      assert.strictEqual(config.enabled, DEFAULT_GUARDIAN_CONFIG.enabled);
      assert.strictEqual(config.model, DEFAULT_GUARDIAN_CONFIG.model);
    });

    it('merges custom config', () => {
      const svc = new GuardianService({ enabled: false, model: 'claude-3' });
      const config = svc.getConfig();
      assert.strictEqual(config.enabled, false);
      assert.strictEqual(config.model, 'claude-3');
    });

    it('updateConfig merges new values', () => {
      const svc = new GuardianService();
      svc.updateConfig({ maxTokens: 1024 });
      assert.strictEqual(svc.getConfig().maxTokens, 1024);
    });

    it('getConfig returns a copy', () => {
      const svc = new GuardianService();
      const c1 = svc.getConfig();
      c1.enabled = false;
      assert.strictEqual(svc.getConfig().enabled, DEFAULT_GUARDIAN_CONFIG.enabled);
    });
  });

  describe('review', () => {
    it('auto-approves when disabled', async () => {
      const svc = new GuardianService({ enabled: false });
      const decision = await svc.review(
        makeToolCall('shell_execute', { cmd: 'rm -rf /' }),
        'test goal',
        makeServices(),
      );
      assert.strictEqual(decision.approved, true);
      assert.ok(decision.reason.includes('disabled'));
    });

    it('auto-approves read-only tools without LLM call', async () => {
      const svc = new GuardianService({ enabled: true });
      const readOnlyTools = [
        'file_read',
        'file_search',
        'file_list',
        'code_search',
        'glob',
        'grep',
        'web_search',
        'web_fetch',
      ];
      for (const toolName of readOnlyTools) {
        const decision = await svc.review(makeToolCall(toolName, {}), 'test goal', makeServices());
        assert.strictEqual(decision.approved, true, `${toolName} should be auto-approved`);
        assert.ok(decision.reason.includes('Read-only'));
      }
    });

    it('auto-approves file edit tools via policy', async () => {
      const svc = new GuardianService({ enabled: true });
      const decision = await svc.review(
        makeToolCall('file_write', { path: '/test' }),
        'test goal',
        makeServices(),
      );
      assert.strictEqual(decision.approved, true);
      assert.ok(decision.reason.includes('auto-approved via policy'));
    });

    it('auto-approves file_edit tool via policy', async () => {
      const svc = new GuardianService({ enabled: true });
      const decision = await svc.review(
        makeToolCall('file_edit', { path: '/test' }),
        'test goal',
        makeServices(),
      );
      assert.strictEqual(decision.approved, true);
    });

    it('calls LLM for non-read-only, non-edit tools', async () => {
      let llmCalled = false;
      const services = makeServices({
        call: async () => {
          llmCalled = true;
          return { content: JSON.stringify({ approved: true, reason: 'Safe' }) };
        },
      });
      const svc = new GuardianService({ enabled: true });
      const decision = await svc.review(
        makeToolCall('shell_execute', { cmd: 'ls' }),
        'test goal',
        services,
      );
      assert.strictEqual(llmCalled, true);
      assert.strictEqual(decision.approved, true);
      assert.strictEqual(decision.reason, 'Safe');
    });

    it('returns rejection from LLM', async () => {
      const services = makeServices({
        call: async () => ({
          content: JSON.stringify({
            approved: false,
            reason: 'Dangerous command',
            suggestion: 'Use ls instead',
          }),
        }),
      });
      const svc = new GuardianService({ enabled: true });
      const decision = await svc.review(
        makeToolCall('shell_execute', { cmd: 'rm -rf /' }),
        'test goal',
        services,
      );
      assert.strictEqual(decision.approved, false);
      assert.strictEqual(decision.reason, 'Dangerous command');
      assert.strictEqual(decision.suggestion, 'Use ls instead');
    });

    it('auto-approves when provider is not available', async () => {
      const services = makeServices(null);
      const svc = new GuardianService({ enabled: true });
      const decision = await svc.review(makeToolCall('shell_execute', {}), 'test goal', services);
      assert.strictEqual(decision.approved, true);
      assert.ok(decision.reason.includes('not available'));
    });

    it('auto-approves on empty LLM response', async () => {
      const services = makeServices({
        call: async () => ({ content: '' }),
      });
      const svc = new GuardianService({ enabled: true });
      const decision = await svc.review(makeToolCall('shell_execute', {}), 'test goal', services);
      assert.strictEqual(decision.approved, true);
      assert.ok(decision.reason.includes('empty'));
    });

    it('auto-approves on unparseable LLM response', async () => {
      const services = makeServices({
        call: async () => ({ content: 'I cannot decide' }),
      });
      const svc = new GuardianService({ enabled: true });
      const decision = await svc.review(makeToolCall('shell_execute', {}), 'test goal', services);
      assert.strictEqual(decision.approved, true);
      assert.ok(decision.reason.includes('parse'));
    });

    it('handles JSON embedded in text response', async () => {
      const services = makeServices({
        call: async () => ({
          content: 'Analysis complete.\n{"approved": false, "reason": "Risky"}\nEnd.',
        }),
      });
      const svc = new GuardianService({ enabled: true });
      const decision = await svc.review(
        makeToolCall('shell_execute', { cmd: 'curl' }),
        'test goal',
        services,
      );
      assert.strictEqual(decision.approved, false);
      assert.strictEqual(decision.reason, 'Risky');
    });

    it('fail-opens on provider call error', async () => {
      const services = makeServices({
        call: async () => {
          throw new Error('Network timeout');
        },
      });
      const svc = new GuardianService({ enabled: true });
      const decision = await svc.review(makeToolCall('shell_execute', {}), 'test goal', services);
      assert.strictEqual(decision.approved, true);
      assert.ok(decision.reason.includes('fail-open'));
    });

    it('treats approved field being absent as approved', async () => {
      const services = makeServices({
        call: async () => ({
          content: JSON.stringify({ reason: 'No decision field' }),
        }),
      });
      const svc = new GuardianService({ enabled: true });
      const decision = await svc.review(makeToolCall('shell_execute', {}), 'test goal', services);
      // approved !== false → approved
      assert.strictEqual(decision.approved, true);
    });
  });
});
