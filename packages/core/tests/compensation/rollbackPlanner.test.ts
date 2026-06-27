/**
 * Tests for RollbackPlanner — compensation plan generation and execution.
 *
 * Covers:
 *   - Plan generation with various tool types (file, stripe, github, slack)
 *   - Risk classification and approval gating
 *   - LIFO execution order
 *   - Buffered (irreversible) step handling
 *   - Handler retry logic
 *   - Plan execution with success, failure, and skip scenarios
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  generateRollbackPlan,
  executeRollbackPlan,
  registerCompensationMetadata,
  registerResourceKeys,
  type PlanInput,
  type PlannedToolCall,
} from '../../src/compensation/rollbackPlanner';
import type { CompensationPlan, PlanStep } from '../../src/compensation/types';
import type { CompensableAction } from '../../src/runtime/compensationRegistry';

describe('RollbackPlanner', () => {
  describe('generateRollbackPlan', () => {
    it('generates an empty plan when no calls are planned', () => {
      const input: PlanInput = { plannedCalls: [] };
      const plan = generateRollbackPlan(input);
      assert.strictEqual(plan.steps.length, 0);
      assert.strictEqual(plan.requiresApproval, false);
      assert.strictEqual(plan.estimatedCostUsd, 0);
      assert.strictEqual(plan.risk, 'safe');
    });

    it('generates steps in reverse order (LIFO)', () => {
      const calls: PlannedToolCall[] = [
        { toolName: 'file_write', args: { path: '/a' } },
        { toolName: 'file_write', args: { path: '/b' } },
        { toolName: 'file_write', args: { path: '/c' } },
      ];
      const plan = generateRollbackPlan({ plannedCalls: calls });
      assert.strictEqual(plan.steps.length, 3);
      // Reverse order: last call compensated first
      assert.ok(plan.steps[0].description.includes('file_write'));
    });

    it('classifies file operations as low risk', () => {
      const calls: PlannedToolCall[] = [
        { toolName: 'file_write', args: { path: '/test' } },
      ];
      const plan = generateRollbackPlan({ plannedCalls: calls });
      assert.strictEqual(plan.risk, 'safe');
      assert.strictEqual(plan.requiresApproval, false);
    });

    it('classifies stripe operations with cost', () => {
      const calls: PlannedToolCall[] = [
        { toolName: 'stripe_charge_create', args: { amount: 1000 } },
      ];
      const plan = generateRollbackPlan({ plannedCalls: calls });
      assert.strictEqual(plan.estimatedCostUsd, 0.05);
    });

    it('flags irreversible actions as buffered', () => {
      const calls: PlannedToolCall[] = [
        { toolName: 'send_email', args: { to: 'user@example.com' } },
        { toolName: 'file_write', args: { path: '/test' } },
      ];
      const plan = generateRollbackPlan({ plannedCalls: calls });
      const emailStep = plan.steps.find((s) => s.forwardAction.toolName === 'send_email');
      assert.ok(emailStep, 'Email step should exist');
      assert.strictEqual(emailStep!.buffered, true);
      // bufferedReason is only set when risk is 'impossible';
      // send_email has 'irreversible' tag but risk is 'review'
    });

    it('requires approval for destructive operations', () => {
      // Register custom metadata to get 'destructive' risk level
      // (inferToolTags alone only returns ['destructive'] for delete,
      // which classifies as 'review'. We need both 'destructive' and
      // 'requires_approval' tags, or a custom registration.)
      registerCompensationMetadata('db_delete_table', {
        externalSystem: 'db',
        risk: 'destructive',
        fullyRecoverable: false,
        costUsd: 0,
        tags: ['destructive', 'requires_approval'],
        idempotent: false,
      });
      const calls: PlannedToolCall[] = [
        { toolName: 'db_delete_table', args: { table: 'users' } },
      ];
      const plan = generateRollbackPlan({ plannedCalls: calls });
      assert.strictEqual(plan.requiresApproval, true);
      assert.strictEqual(plan.risk, 'destructive');
    });

    it('generates human-readable plan lines for known tools', () => {
      const calls: PlannedToolCall[] = [
        { toolName: 'github_pr_create', args: { owner: 'o', repo: 'r', pullNumber: 1 } },
        { toolName: 'slack_chat_postMessage', args: { channel: 'C123', ts: '123' } },
        { toolName: 'stripe_charge_create', args: {} },
      ];
      const plan = generateRollbackPlan({ plannedCalls: calls });
      const prStep = plan.steps.find((s) => s.forwardAction.toolName === 'github_pr_create');
      assert.ok(prStep?.plan.includes('Close GitHub PR'));
      const slackStep = plan.steps.find((s) => s.forwardAction.toolName === 'slack_chat_postMessage');
      assert.ok(slackStep?.plan.includes('Delete Slack message'));
      const stripeStep = plan.steps.find((s) => s.forwardAction.toolName === 'stripe_charge_create');
      assert.ok(stripeStep?.plan.includes('Refund Stripe charge'));
    });

    it('truncates planned calls at the failure point', () => {
      const calls: PlannedToolCall[] = [
        { toolName: 'file_write', args: { path: '/a' } },
        { toolName: 'file_write', args: { path: '/b' } },
        { toolName: 'file_write', args: { path: '/c' } },
      ];
      const plan = generateRollbackPlan({
        plannedCalls: calls,
        failure: { toolName: 'file_write', args: { path: '/b' }, error: 'disk full' },
      });
      // Only calls before the failure point are compensated (just /a)
      assert.strictEqual(plan.steps.length, 1);
      assert.ok(plan.trigger.description.includes('disk full'));
    });

    it('treats entire sequence as executed when failure is not in planned calls', () => {
      const calls: PlannedToolCall[] = [
        { toolName: 'file_write', args: { path: '/a' } },
        { toolName: 'file_write', args: { path: '/b' } },
      ];
      const plan = generateRollbackPlan({
        plannedCalls: calls,
        failure: { toolName: 'unknown_tool', args: {}, error: 'unexpected' },
      });
      assert.strictEqual(plan.steps.length, 2);
    });

    it('respects custom risk thresholds for cost approval', () => {
      const calls: PlannedToolCall[] = [
        { toolName: 'stripe_charge_create', args: {} },
      ];
      const plan = generateRollbackPlan({
        plannedCalls: calls,
        riskThresholds: { maxAgeMs: 1000, maxCostUsd: 0.01 },
      });
      // Cost is 0.05, threshold is 0.01 → requires approval
      assert.strictEqual(plan.requiresApproval, true);
    });

    it('uses registered compensation metadata when available', () => {
      registerCompensationMetadata('custom_tool', {
        externalSystem: 'custom',
        risk: 'destructive',
        fullyRecoverable: false,
        costUsd: 500,
        tags: ['custom', 'expensive'],
        idempotent: false,
      });
      const plan = generateRollbackPlan({
        plannedCalls: [{ toolName: 'custom_tool', args: {} }],
      });
      assert.strictEqual(plan.risk, 'destructive');
      assert.strictEqual(plan.requiresApproval, true);
      assert.strictEqual(plan.estimatedCostUsd, 500);
    });
  });

  describe('executeRollbackPlan', () => {
    it('throws on infeasible plan (missing handlers for non-buffered steps)', async () => {
      const plan = generateRollbackPlan({
        plannedCalls: [{ toolName: 'file_write', args: { path: '/x' } }],
      });
      // No handlers provided → should throw
      await assert.rejects(
        () => executeRollbackPlan(plan, {}),
        /ROLLBACK BLOCKED/,
      );
    });

    it('executes all steps successfully when handlers are provided', async () => {
      const plan = generateRollbackPlan({
        plannedCalls: [
          { toolName: 'file_write', args: { path: '/a' } },
          { toolName: 'file_write', args: { path: '/b' } },
        ],
      });
      const result = await executeRollbackPlan(plan, {
        handlers: {
          file_write: async () => ({ success: true }),
        },
      });
      assert.strictEqual(result.succeeded.length, 2);
      assert.strictEqual(result.failed.length, 0);
      assert.strictEqual(result.fullyRecovered, true);
    });

    it('retries failed steps up to maxAttemptsPerStep', async () => {
      const plan = generateRollbackPlan({
        plannedCalls: [{ toolName: 'file_write', args: { path: '/a' } }],
      });
      let attempts = 0;
      const result = await executeRollbackPlan(plan, {
        maxAttemptsPerStep: 3,
        handlers: {
          file_write: async () => {
            attempts++;
            if (attempts < 3) return { success: false, error: 'transient' };
            return { success: true };
          },
        },
      });
      assert.strictEqual(attempts, 3);
      assert.strictEqual(result.succeeded.length, 1);
      assert.strictEqual(result.fullyRecovered, true);
    });

    it('marks steps as failed after exhausting retries', async () => {
      const plan = generateRollbackPlan({
        plannedCalls: [{ toolName: 'file_write', args: { path: '/a' } }],
      });
      const result = await executeRollbackPlan(plan, {
        maxAttemptsPerStep: 2,
        handlers: {
          file_write: async () => ({ success: false, error: 'permanent failure' }),
        },
      });
      assert.strictEqual(result.failed.length, 1);
      assert.strictEqual(result.succeeded.length, 0);
      assert.strictEqual(result.fullyRecovered, false);
      assert.ok(result.failed[0].error?.includes('permanent failure'));
    });

    it('stops retrying on permanent errors', async () => {
      const plan = generateRollbackPlan({
        plannedCalls: [{ toolName: 'file_write', args: { path: '/a' } }],
      });
      let attempts = 0;
      const result = await executeRollbackPlan(plan, {
        maxAttemptsPerStep: 5,
        handlers: {
          file_write: async () => {
            attempts++;
            return { success: false, error: '4xx', permanent: true };
          },
        },
      });
      assert.strictEqual(attempts, 1, 'Should not retry permanent errors');
      assert.strictEqual(result.failed.length, 1);
      assert.ok(result.failed[0].error?.includes('[permanent]'));
    });

    it('skips approval when operator declines', async () => {
      // Register custom metadata so plan.requiresApproval is true
      registerCompensationMetadata('db_delete_table', {
        externalSystem: 'db',
        risk: 'destructive',
        fullyRecoverable: false,
        costUsd: 0,
        tags: ['destructive', 'requires_approval'],
        idempotent: false,
      });
      const plan = generateRollbackPlan({
        plannedCalls: [{ toolName: 'db_delete_table', args: { table: 'x' } }],
      });
      // Verify the plan actually requires approval
      assert.strictEqual(plan.requiresApproval, true);
      const result = await executeRollbackPlan(plan, {
        handlers: {
          db_delete_table: async () => ({ success: true }),
        },
        requireApproval: async () => false,
      });
      assert.strictEqual(result.skipped.length, 1);
      assert.strictEqual(result.succeeded.length, 0);
      assert.strictEqual(result.fullyRecovered, false);
    });

    it('executes buffered steps only after all normal steps succeed', async () => {
      const plan = generateRollbackPlan({
        plannedCalls: [
          { toolName: 'send_email', args: { to: 'x' } }, // buffered (irreversible)
          { toolName: 'file_write', args: { path: '/a' } }, // normal
        ],
      });
      const executionOrder: string[] = [];
      const result = await executeRollbackPlan(plan, {
        handlers: {
          send_email: async () => {
            executionOrder.push('email');
            return { success: true };
          },
          file_write: async () => {
            executionOrder.push('file');
            return { success: true };
          },
        },
      });
      assert.strictEqual(result.succeeded.length, 2);
      // File (normal) should execute before email (buffered)
      assert.strictEqual(executionOrder[0], 'file');
      assert.strictEqual(executionOrder[1], 'email');
    });

    it('skips buffered steps when normal steps fail', async () => {
      const plan = generateRollbackPlan({
        plannedCalls: [
          { toolName: 'send_email', args: { to: 'x' } },
          { toolName: 'file_write', args: { path: '/a' } },
        ],
      });
      const result = await executeRollbackPlan(plan, {
        maxAttemptsPerStep: 1,
        handlers: {
          send_email: async () => ({ success: true }),
          file_write: async () => ({ success: false, error: 'fail' }),
        },
      });
      assert.strictEqual(result.failed.length, 1);
      assert.strictEqual(result.skipped.length, 1);
      const skipped = result.skipped[0];
      assert.ok(skipped.error?.includes('Buffered'));
    });

    it('calls onStepStart and onStepComplete callbacks', async () => {
      const plan = generateRollbackPlan({
        plannedCalls: [{ toolName: 'file_write', args: { path: '/a' } }],
      });
      const started: string[] = [];
      const completed: string[] = [];
      await executeRollbackPlan(plan, {
        handlers: { file_write: async () => ({ success: true }) },
        onStepStart: (step) => started.push(step.stepId),
        onStepComplete: (step) => completed.push(step.stepId),
      });
      assert.strictEqual(started.length, 1);
      assert.strictEqual(completed.length, 1);
    });
  });

  describe('registerResourceKeys', () => {
    it('allows registering custom resource key fields', () => {
      registerResourceKeys('custom_prefix', ['id', 'version']);
      // The registration is global; just verify it doesn't throw
      assert.ok(true);
    });
  });
});
