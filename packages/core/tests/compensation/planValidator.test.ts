/**
 * Tests for PlanValidator — pre-flight compensation plan feasibility check.
 *
 * Covers:
 *   - Feasible plans (all non-buffered steps have handlers)
 *   - Infeasible plans (missing handlers)
 *   - Buffered steps without handlers (warned but not blocking)
 *   - assertPlanFeasible throws on infeasible plans
 *   - CompensationPlanInfeasibleError contains full report
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  validatePlanFeasibility,
  assertPlanFeasible,
  CompensationPlanInfeasibleError,
  type HandlerMap,
} from '../../src/compensation/planValidator';
import { generateRollbackPlan } from '../../src/compensation/rollbackPlanner';
import type { CompensationPlan, PlanStep } from '../../src/compensation/types';
import type { CompensableAction } from '../../src/runtime/compensationRegistry';

function makePlan(steps: Partial<PlanStep>[]): CompensationPlan {
  return {
    trigger: {
      actionId: 'trigger',
      toolName: 'trigger_tool',
      args: {},
      description: 'test trigger',
      tags: [],
      runId: 'test',
    },
    steps: steps.map((s, i) => ({
      stepId: s.stepId ?? `step_${i}`,
      description: s.description ?? `Step ${i}`,
      forwardAction: s.forwardAction ?? {
        actionId: `action_${i}`,
        toolName: s.forwardAction?.toolName ?? `tool_${i}`,
        args: {},
        description: 'test',
        tags: [],
        runId: 'test',
      },
      handlerName: s.handlerName ?? `tool_${i}`,
      plan: s.plan ?? 'test plan',
      status: s.status ?? 'pending',
      attempts: s.attempts ?? 0,
      buffered: s.buffered,
      bufferedReason: s.bufferedReason,
    })),
    requiresApproval: false,
    estimatedCostUsd: 0,
    risk: 'safe',
    createdAt: new Date().toISOString(),
  };
}

describe('PlanValidator', () => {
  describe('validatePlanFeasibility', () => {
    it('returns feasible when all non-buffered steps have handlers', () => {
      const plan = makePlan([
        { forwardAction: { toolName: 'tool_a', actionId: 'a', args: {}, description: '', tags: [], runId: '' } },
        { forwardAction: { toolName: 'tool_b', actionId: 'b', args: {}, description: '', tags: [], runId: '' } },
      ]);
      const handlers: HandlerMap = {
        tool_a: async () => ({ success: true }),
        tool_b: async () => ({ success: true }),
      };
      const report = validatePlanFeasibility(plan, handlers);
      assert.strictEqual(report.feasible, true);
      assert.strictEqual(report.gaps.length, 0);
      assert.strictEqual(report.affectedSteps.length, 0);
      assert.ok(report.summary.includes('All'));
    });

    it('returns infeasible when a non-buffered step lacks a handler', () => {
      const plan = makePlan([
        { forwardAction: { toolName: 'tool_a', actionId: 'a', args: {}, description: '', tags: [], runId: '' } },
        { forwardAction: { toolName: 'tool_b', actionId: 'b', args: {}, description: '', tags: [], runId: '' } },
      ]);
      const handlers: HandlerMap = {
        tool_a: async () => ({ success: true }),
        // tool_b handler missing
      };
      const report = validatePlanFeasibility(plan, handlers);
      assert.strictEqual(report.feasible, false);
      assert.strictEqual(report.gaps.length, 1);
      assert.ok(report.gaps.includes('tool_b'));
      assert.strictEqual(report.affectedSteps.length, 1);
      assert.ok(report.summary.includes('ROLLBACK BLOCKED'));
    });

    it('does not block on buffered steps without handlers', () => {
      const plan = makePlan([
        {
          forwardAction: { toolName: 'send_email', actionId: 'a', args: {}, description: '', tags: [], runId: '' },
          buffered: true,
          bufferedReason: 'Irreversible',
        },
        { forwardAction: { toolName: 'file_write', actionId: 'b', args: {}, description: '', tags: [], runId: '' } },
      ]);
      const handlers: HandlerMap = {
        file_write: async () => ({ success: true }),
        // send_email handler missing but it's buffered → OK
      };
      const report = validatePlanFeasibility(plan, handlers);
      assert.strictEqual(report.feasible, true);
      assert.strictEqual(report.gaps.length, 0);
    });

    it('returns feasible for empty plan', () => {
      const plan = makePlan([]);
      const report = validatePlanFeasibility(plan);
      assert.strictEqual(report.feasible, true);
      assert.strictEqual(report.gaps.length, 0);
    });

    it('deduplicates gap entries for the same tool', () => {
      const plan = makePlan([
        { forwardAction: { toolName: 'missing_tool', actionId: 'a', args: {}, description: '', tags: [], runId: '' } },
        { forwardAction: { toolName: 'missing_tool', actionId: 'b', args: {}, description: '', tags: [], runId: '' } },
        { forwardAction: { toolName: 'missing_tool', actionId: 'c', args: {}, description: '', tags: [], runId: '' } },
      ]);
      const report = validatePlanFeasibility(plan, {});
      assert.strictEqual(report.feasible, false);
      assert.strictEqual(report.gaps.length, 1, 'Should deduplicate tool names');
      assert.strictEqual(report.gaps[0], 'missing_tool');
      assert.strictEqual(report.affectedSteps.length, 3);
    });

    it('works with no handlers at all (all steps become gaps)', () => {
      const plan = makePlan([
        { forwardAction: { toolName: 'tool_a', actionId: 'a', args: {}, description: '', tags: [], runId: '' } },
      ]);
      const report = validatePlanFeasibility(plan);
      assert.strictEqual(report.feasible, false);
      assert.strictEqual(report.gaps.length, 1);
    });
  });

  describe('assertPlanFeasible', () => {
    it('does not throw when plan is feasible', () => {
      const plan = makePlan([
        { forwardAction: { toolName: 'tool_a', actionId: 'a', args: {}, description: '', tags: [], runId: '' } },
      ]);
      const handlers: HandlerMap = {
        tool_a: async () => ({ success: true }),
      };
      assert.doesNotThrow(() => assertPlanFeasible(plan, handlers));
    });

    it('throws CompensationPlanInfeasibleError when plan is infeasible', () => {
      const plan = makePlan([
        { forwardAction: { toolName: 'missing_tool', actionId: 'a', args: {}, description: '', tags: [], runId: '' } },
      ]);
      assert.throws(
        () => assertPlanFeasible(plan, {}),
        CompensationPlanInfeasibleError,
      );
    });

    it('error contains full feasibility report', () => {
      const plan = makePlan([
        { forwardAction: { toolName: 'missing_tool', actionId: 'a', args: {}, description: '', tags: [], runId: '' } },
      ]);
      try {
        assertPlanFeasible(plan, {});
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof CompensationPlanInfeasibleError);
        const report = err.report;
        assert.strictEqual(report.feasible, false);
        assert.ok(report.gaps.includes('missing_tool'));
        assert.strictEqual(report.affectedSteps.length, 1);
        assert.ok(report.summary.includes('ROLLBACK BLOCKED'));
      }
    });

    it('integrates with generateRollbackPlan output', () => {
      const plan = generateRollbackPlan({
        plannedCalls: [
          { toolName: 'file_write', args: { path: '/a' } },
          { toolName: 'file_write', args: { path: '/b' } },
        ],
      });
      // Without handlers → infeasible
      assert.throws(
        () => assertPlanFeasible(plan, {}),
        CompensationPlanInfeasibleError,
      );
      // With handlers → feasible
      const handlers: HandlerMap = {
        file_write: async () => ({ success: true }),
      };
      assert.doesNotThrow(() => assertPlanFeasible(plan, handlers));
    });
  });
});
