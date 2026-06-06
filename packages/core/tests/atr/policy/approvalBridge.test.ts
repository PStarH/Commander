import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyHook } from '../../../src/atr/policy/integration/scheduler';
import { wrapApprovalWithPolicy, approvalRequestToPolicyInput, policyDecisionToApproval } from '../../../src/atr/policy/integration/approvalBridge';
import { getApprovalSystem, resetApprovalSystem } from '../../../src/sandbox/approval';
import type { ApprovalRequest } from '../../../src/sandbox/approval';
import type { RunHandle } from '../../../src/atr/scheduler';

function makeRun(): RunHandle {
  return {
    runId: 'r-bridge-1',
    state: 'EXECUTING',
    leaseToken: 'lease-bridge-1',
    fencingEpoch: 1,
    intentHash: 'ihash-bridge',
    tenantId: 'tenant-bridge',
    metadata: { goal: 'bridge test' },
    createdAt: new Date('2026-06-05T12:00:00Z').toISOString(),
    resumed: false,
    acquired: true,
  };
}

function baseReq(): ApprovalRequest {
  return {
    id: 'req-1',
    timestamp: Date.parse('2026-06-05T12:00:00Z'),
    gate: { category: 'shell_exec', action: 'shell', riskLevel: 'high' },
    toolName: 'shell_run',
    toolArgs: { command: 'rm -rf /' },
    agentId: 'agent-bridge',
    runId: 'r-bridge-1',
  };
}

test('approvalBridge: maps ApprovalRequest to PolicyInput', () => {
  const hook = new PolicyHook({ enableAudit: false, pack: 'readonly' });
  const input = approvalRequestToPolicyInput(baseReq(), {
    hook, run: makeRun(),
    tenant: { id: 'tenant-bridge', config: {
      tokenBudget: 100, maxConcurrency: 1, maxRunsPerMinute: 1,
      maxActionsPerRun: 10, allowShell: false, allowNetwork: false,
      requiresApprovalBypass: false,
    } },
    metrics: { tokensUsedThisRun: 0, tokensUsedThisHour: 0, actionsThisRun: 0, destructiveThisRun: 0, estimatedCostUsd: 0 },
  });
  assert.equal(input.phase, 'tool');
  assert.equal(input.tool.name, 'shell_run');
  assert.equal(input.tool.category, 'shell');
  assert.equal(input.run.tenantId, 'tenant-bridge');
  assert.equal(input.action.leaseToken, 'lease-bridge-1');
  assert.equal(input.action.fencingEpoch, 1);
});

test('approvalBridge: policy deny_class overrides legacy approve', async () => {
  const hook = new PolicyHook({ enableAudit: false, pack: 'readonly' });
  const legacy = getApprovalSystem();
  legacy.setMode('full-auto');
  resetApprovalSystem();
  const fresh = getApprovalSystem();
  fresh.setMode('full-auto');
  const eval_ = wrapApprovalWithPolicy(fresh, {
    hook, run: makeRun(),
    tenant: { id: 'tenant-bridge', config: {
      tokenBudget: 100, maxConcurrency: 1, maxRunsPerMinute: 1,
      maxActionsPerRun: 10, allowShell: false, allowNetwork: false,
      requiresApprovalBypass: false,
    } },
    metrics: { tokensUsedThisRun: 0, tokensUsedThisHour: 0, actionsThisRun: 0, destructiveThisRun: 0, estimatedCostUsd: 0 },
  });
  const result = await eval_(baseReq());
  assert.equal(result.decision, 'denied');
  assert.match(result.reason, /policy:deny_shell|policy:deny/);
});

test('approvalBridge: policy allow falls through to legacy', async () => {
  const hook = new PolicyHook({ enableAudit: false, pack: 'readonly' });
  resetApprovalSystem();
  const fresh = getApprovalSystem();
  fresh.setMode('full-auto');
  const eval_ = wrapApprovalWithPolicy(fresh, {
    hook, run: makeRun(),
    tenant: { id: 'tenant-bridge', config: {
      tokenBudget: 100, maxConcurrency: 1, maxRunsPerMinute: 1,
      maxActionsPerRun: 10, allowShell: true, allowNetwork: true,
      requiresApprovalBypass: false,
    } },
    metrics: { tokensUsedThisRun: 0, tokensUsedThisHour: 0, actionsThisRun: 0, destructiveThisRun: 0, estimatedCostUsd: 0 },
  });
  const req: ApprovalRequest = {
    ...baseReq(),
    gate: { category: 'file_read', action: 'read', riskLevel: 'low' },
    toolName: 'file_read',
    toolArgs: { path: '/tmp/x' },
  };
  const result = await eval_(req);
  assert.equal(result.decision, 'approved');
});

test('policyDecisionToApproval: maps all 4 effects', () => {
  const allow = policyDecisionToApproval({
    effect: 'allow', reason: 'r', decisionPath: [], matchedRule: 'a', riskScore: 0,
    budget: { tokensRemaining: 0, runtimeRemainingMs: 0, actionsRemaining: 0, costRemainingUsd: 0 },
    latencyMs: 0, cached: false, cacheable: true, decisionId: 'd', packVersion: 1, packName: 'p',
    tenantId: 't', runId: 'r',
  });
  assert.equal(allow.decision, 'approved');

  const deny = policyDecisionToApproval({
    effect: 'deny', reason: 'r', decisionPath: [], matchedRule: 'a', riskScore: 0,
    budget: { tokensRemaining: 0, runtimeRemainingMs: 0, actionsRemaining: 0, costRemainingUsd: 0 },
    latencyMs: 0, cached: false, cacheable: true, decisionId: 'd', packVersion: 1, packName: 'p',
    tenantId: 't', runId: 'r',
  });
  assert.equal(deny.decision, 'denied');

  const denyClass = policyDecisionToApproval({
    effect: 'deny_class', denyClass: 'deny_shell', reason: 'shell', decisionPath: [],
    matchedRule: 'a', riskScore: 0,
    budget: { tokensRemaining: 0, runtimeRemainingMs: 0, actionsRemaining: 0, costRemainingUsd: 0 },
    latencyMs: 0, cached: false, cacheable: true, decisionId: 'd', packVersion: 1, packName: 'p',
    tenantId: 't', runId: 'r',
  });
  assert.equal(denyClass.decision, 'denied');
  assert.match(denyClass.reason, /deny_shell/);

  const requireApproval = policyDecisionToApproval({
    effect: 'require_approval', reason: 'needs review', decisionPath: [], matchedRule: 'a',
    riskScore: 0,
    budget: { tokensRemaining: 0, runtimeRemainingMs: 0, actionsRemaining: 0, costRemainingUsd: 0 },
    latencyMs: 0, cached: false, cacheable: true, decisionId: 'd', packVersion: 1, packName: 'p',
    tenantId: 't', runId: 'r',
  });
  assert.equal(requireApproval.decision, 'denied');
  assert.match(requireApproval.reason, /require_approval/);
});
