/**
 * Deliberation output snapshot tests — verify plan display format is stable.
 *
 * Tests the deliberation output formatting used by `cmdPlan` to ensure
 * the CLI output doesn't regress when deliberation fields change.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { deliberate } from '../../src/ultimate/deliberation';
import { $ } from '../../src/cli/util';

// Strip ANSI codes for stable comparison
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('Deliberation Output', () => {
  // ── Plan field presence ────────────────────────────────────────────────────

  describe('plan fields', () => {
    it('returns all required fields for CLI display', () => {
      const plan = deliberate('Research the latest AI papers');

      // Fields used by cmdPlan
      assert.ok(typeof plan.taskType === 'string', 'taskType should be string');
      assert.ok(
        typeof plan.recommendedTopology === 'string',
        'recommendedTopology should be string',
      );
      assert.ok(
        typeof plan.estimatedAgentCount === 'number',
        'estimatedAgentCount should be number',
      );
      assert.ok(typeof plan.estimatedSteps === 'number', 'estimatedSteps should be number');
      assert.ok(typeof plan.confidence === 'number', 'confidence should be number');
      assert.ok(
        typeof plan.requiresExternalInfo === 'boolean',
        'requiresExternalInfo should be boolean',
      );
      assert.ok(typeof plan.estimatedTokens === 'number', 'estimatedTokens should be number');
      assert.ok(plan.tokenBudget !== undefined, 'tokenBudget should exist');
      assert.ok(
        typeof plan.tokenBudget.thinking === 'number',
        'tokenBudget.thinking should be number',
      );
      assert.ok(
        typeof plan.tokenBudget.execution === 'number',
        'tokenBudget.execution should be number',
      );
      assert.ok(
        typeof plan.estimatedDurationMs === 'number',
        'estimatedDurationMs should be number',
      );
      assert.ok(
        typeof plan.timeBudgetPerAgentMs === 'number',
        'timeBudgetPerAgentMs should be number',
      );
      assert.ok(typeof plan.taskNature === 'string', 'taskNature should be string');
      assert.ok(
        typeof plan.suitableForSpeculation === 'boolean',
        'suitableForSpeculation should be boolean',
      );
      assert.ok(Array.isArray(plan.capabilitiesNeeded), 'capabilitiesNeeded should be array');
    });

    it('returns valid taskNature values', () => {
      const tasks = [
        'Research AI papers',
        'Write a sorting algorithm',
        'Analyze and summarize data',
      ];

      for (const task of tasks) {
        const plan = deliberate(task);
        assert.ok(
          ['IO_BOUND', 'COMPUTE_BOUND', 'MIXED'].includes(plan.taskNature),
          `taskNature should be valid, got: ${plan.taskNature}`,
        );
      }
    });

    it('returns valid topology values', () => {
      const plan = deliberate('Complex multi-step task');
      const validTopologies = [
        'SINGLE',
        'SEQUENTIAL',
        'PARALLEL',
        'HIERARCHICAL',
        'DEBATE',
        'CONSENSUS',
        'ENSEMBLE',
        'HYBRID',
      ];
      assert.ok(
        validTopologies.includes(plan.recommendedTopology),
        `topology should be valid, got: ${plan.recommendedTopology}`,
      );
    });
  });

  // ── Duration formatting ────────────────────────────────────────────────────

  describe('duration formatting', () => {
    it('duration values are positive', () => {
      const plan = deliberate('Quick task');
      assert.ok(plan.estimatedDurationMs > 0, 'estimatedDurationMs should be positive');
      assert.ok(plan.timeBudgetPerAgentMs > 0, 'timeBudgetPerAgentMs should be positive');
    });

    it('formats duration as seconds string', () => {
      const plan = deliberate('Test task');
      const formatted = (plan.estimatedDurationMs / 1000).toFixed(1);
      assert.ok(formatted.match(/^\d+\.\d$/), `Should format as X.X, got: ${formatted}`);
    });
  });

  // ── Confidence formatting ──────────────────────────────────────────────────

  describe('confidence formatting', () => {
    it('confidence is between 0 and 1', () => {
      const plan = deliberate('Any task');
      assert.ok(
        plan.confidence >= 0 && plan.confidence <= 1,
        `confidence should be 0-1, got: ${plan.confidence}`,
      );
    });

    it('formats confidence as percentage', () => {
      const plan = deliberate('Test task');
      const formatted = `${(plan.confidence * 100).toFixed(0)}%`;
      assert.ok(formatted.match(/^\d+%$/), `Should format as N%, got: ${formatted}`);
    });
  });

  // ── Token budget formatting ────────────────────────────────────────────────

  describe('token budget formatting', () => {
    it('token budget components are positive', () => {
      const plan = deliberate('Test task');
      assert.ok(plan.tokenBudget.thinking > 0, 'thinking should be positive');
      assert.ok(plan.tokenBudget.execution > 0, 'execution should be positive');
      assert.ok(plan.tokenBudget.synthesis > 0, 'synthesis should be positive');
    });

    it('formats tokens with locale separators', () => {
      const plan = deliberate('Test task');
      const formatted = plan.estimatedTokens.toLocaleString();
      // Should not throw and should contain digits
      assert.ok(formatted.match(/[\d,]+/), `Should format with separators, got: ${formatted}`);
    });
  });
});
