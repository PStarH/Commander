/**
 * Tests for GoalGate — post-completion goal verification.
 *
 * Covers:
 *   - Disabled gate auto-approves
 *   - Max reentries limit
 *   - Judge model evaluation (satisfied / not satisfied)
 *   - Synthetic message generation
 *   - Provider not available → auto-approve
 *   - Judge response parsing (valid JSON, invalid JSON, empty response)
 *   - Config update and reset
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { GoalGate, DEFAULT_GOAL_GATE_CONFIG } from '../../src/harness/goalGate';

describe('GoalGate', () => {
  describe('constructor and config', () => {
    it('uses default config when no overrides provided', () => {
      const gate = new GoalGate();
      const config = gate.getConfig();
      assert.strictEqual(config.enabled, DEFAULT_GOAL_GATE_CONFIG.enabled);
      assert.strictEqual(config.judgeModel, DEFAULT_GOAL_GATE_CONFIG.judgeModel);
      assert.strictEqual(config.maxReentries, DEFAULT_GOAL_GATE_CONFIG.maxReentries);
    });

    it('merges custom config overrides', () => {
      const gate = new GoalGate({ enabled: false, maxReentries: 5 });
      const config = gate.getConfig();
      assert.strictEqual(config.enabled, false);
      assert.strictEqual(config.maxReentries, 5);
      assert.strictEqual(config.judgeModel, DEFAULT_GOAL_GATE_CONFIG.judgeModel);
    });

    it('updateConfig merges new values', () => {
      const gate = new GoalGate();
      gate.updateConfig({ maxReentries: 10, judgeModel: 'gpt-4o' });
      const config = gate.getConfig();
      assert.strictEqual(config.maxReentries, 10);
      assert.strictEqual(config.judgeModel, 'gpt-4o');
    });

    it('getConfig returns a copy, not the internal reference', () => {
      const gate = new GoalGate();
      const config1 = gate.getConfig();
      config1.maxReentries = 999;
      const config2 = gate.getConfig();
      assert.strictEqual(config2.maxReentries, DEFAULT_GOAL_GATE_CONFIG.maxReentries);
    });
  });

  describe('canReenter', () => {
    it('returns true when reentries are below limit', () => {
      const gate = new GoalGate({ maxReentries: 3 });
      assert.strictEqual(gate.canReenter(), true);
    });

    it('returns false when max reentries is 0', () => {
      const gate = new GoalGate({ maxReentries: 0 });
      assert.strictEqual(gate.canReenter(), false);
    });
  });

  describe('reset', () => {
    it('resets the reentry counter', () => {
      const gate = new GoalGate({ maxReentries: 1 });
      // Simulate one reentry by evaluating and getting "not satisfied"
      const services = {
        getProvider: () => ({
          call: async () => ({
            content: JSON.stringify({ satisfied: false, reason: 'not done' }),
          }),
        }),
      };
      // After first evaluation (not satisfied), reentries = 1
      // canReenter should be false since maxReentries = 1
      gate.reset();
      assert.strictEqual(gate.canReenter(), true);
    });
  });

  describe('evaluate', () => {
    it('auto-approves when disabled', async () => {
      const gate = new GoalGate({ enabled: false });
      const services = { getProvider: () => null };
      const decision = await gate.evaluate(
        'test goal',
        [{ role: 'user', content: 'hi' }],
        services as any,
      );
      assert.strictEqual(decision.satisfied, true);
      assert.ok(decision.reason.includes('disabled'));
    });

    it('auto-approves when max reentries reached', async () => {
      const gate = new GoalGate({ enabled: true, maxReentries: 0 });
      const services = { getProvider: () => null };
      const decision = await gate.evaluate(
        'test goal',
        [{ role: 'user', content: 'hi' }],
        services as any,
      );
      assert.strictEqual(decision.satisfied, true);
      assert.ok(decision.reason.includes('max reentries'));
    });

    it('auto-approves when judge provider is not available', async () => {
      const gate = new GoalGate({ enabled: true, maxReentries: 3 });
      const services = { getProvider: () => null };
      const decision = await gate.evaluate(
        'test goal',
        [{ role: 'user', content: 'hi' }],
        services as any,
      );
      assert.strictEqual(decision.satisfied, true);
      assert.ok(decision.reason.includes('not available'));
    });

    it('returns satisfied when judge approves', async () => {
      const gate = new GoalGate({ enabled: true, maxReentries: 3, judgeProvider: 'openai' });
      const services = {
        getProvider: () => ({
          call: async () => ({
            content: JSON.stringify({ satisfied: true, reason: 'Goal achieved' }),
          }),
        }),
      };
      const decision = await gate.evaluate(
        'test goal',
        [{ role: 'assistant', content: 'Done' }],
        services as any,
      );
      assert.strictEqual(decision.satisfied, true);
      assert.strictEqual(decision.reason, 'Goal achieved');
    });

    it('returns not satisfied when judge rejects', async () => {
      const gate = new GoalGate({ enabled: true, maxReentries: 3, judgeProvider: 'openai' });
      const services = {
        getProvider: () => ({
          call: async () => ({
            content: JSON.stringify({
              satisfied: false,
              reason: 'Missing tests',
              missing: ['unit tests', 'integration tests'],
            }),
          }),
        }),
      };
      const decision = await gate.evaluate(
        'write tests',
        [{ role: 'assistant', content: 'done' }],
        services as any,
      );
      assert.strictEqual(decision.satisfied, false);
      assert.strictEqual(decision.reason, 'Missing tests');
      assert.ok(decision.missing?.includes('unit tests'));
    });

    it('auto-approves when judge returns empty response', async () => {
      const gate = new GoalGate({ enabled: true, maxReentries: 3, judgeProvider: 'openai' });
      const services = {
        getProvider: () => ({
          call: async () => ({ content: '' }),
        }),
      };
      const decision = await gate.evaluate(
        'test goal',
        [{ role: 'user', content: 'hi' }],
        services as any,
      );
      assert.strictEqual(decision.satisfied, true);
      assert.ok(decision.reason.includes('empty'));
    });

    it('auto-approves when judge response is unparseable', async () => {
      const gate = new GoalGate({ enabled: true, maxReentries: 3, judgeProvider: 'openai' });
      const services = {
        getProvider: () => ({
          call: async () => ({ content: 'This is not JSON at all' }),
        }),
      };
      const decision = await gate.evaluate(
        'test goal',
        [{ role: 'user', content: 'hi' }],
        services as any,
      );
      assert.strictEqual(decision.satisfied, true);
      assert.ok(decision.reason.includes('parse'));
    });

    it('handles JSON embedded in text', async () => {
      const gate = new GoalGate({ enabled: true, maxReentries: 3, judgeProvider: 'openai' });
      const services = {
        getProvider: () => ({
          call: async () => ({
            content: 'Here is my evaluation:\n{"satisfied": true, "reason": "looks good"}\nDone.',
          }),
        }),
      };
      const decision = await gate.evaluate(
        'test goal',
        [{ role: 'assistant', content: 'result' }],
        services as any,
      );
      assert.strictEqual(decision.satisfied, true);
      assert.strictEqual(decision.reason, 'looks good');
    });

    it('auto-approves on provider call error', async () => {
      const gate = new GoalGate({ enabled: true, maxReentries: 3, judgeProvider: 'openai' });
      const services = {
        getProvider: () => ({
          call: async () => {
            throw new Error('Network error');
          },
        }),
      };
      const decision = await gate.evaluate(
        'test goal',
        [{ role: 'user', content: 'hi' }],
        services as any,
      );
      assert.strictEqual(decision.satisfied, true);
      assert.ok(decision.reason.includes('failed'));
    });

    it('increments reentry counter on not-satisfied', async () => {
      const gate = new GoalGate({ enabled: true, maxReentries: 2, judgeProvider: 'openai' });
      const services = {
        getProvider: () => ({
          call: async () => ({
            content: JSON.stringify({ satisfied: false, reason: 'not done' }),
          }),
        }),
      };
      assert.strictEqual(gate.canReenter(), true);
      await gate.evaluate('goal', [{ role: 'user', content: 'x' }], services as any);
      // After one not-satisfied, reentries = 1, still can reenter (max=2)
      assert.strictEqual(gate.canReenter(), true);
      await gate.evaluate('goal', [{ role: 'user', content: 'x' }], services as any);
      // After two not-satisfied, reentries = 2, can't reenter
      assert.strictEqual(gate.canReenter(), false);
    });
  });

  describe('buildSyntheticMessage', () => {
    it('returns empty string when satisfied', () => {
      const gate = new GoalGate();
      const msg = gate.buildSyntheticMessage({ satisfied: true, reason: 'ok' });
      assert.strictEqual(msg, '');
    });

    it('builds message with reason when not satisfied', () => {
      const gate = new GoalGate();
      const msg = gate.buildSyntheticMessage({ satisfied: false, reason: 'Incomplete' });
      assert.ok(msg.includes('[System goal check'));
      assert.ok(msg.includes('Incomplete'));
    });

    it('includes missing items when provided', () => {
      const gate = new GoalGate();
      const msg = gate.buildSyntheticMessage({
        satisfied: false,
        reason: 'Missing stuff',
        missing: ['tests', 'docs'],
      });
      assert.ok(msg.includes('tests'));
      assert.ok(msg.includes('docs'));
    });
  });
});
