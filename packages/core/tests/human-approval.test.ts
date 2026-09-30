import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getHumanApprovalManager,
  HumanApprovalManager,
} from '../src/ultimate/humanApprovalManager';

function makeAuthenticatedManager(): HumanApprovalManager {
  return new HumanApprovalManager({
    authenticateApprover: ({ approverId }) =>
      approverId.startsWith('user-') || approverId === 'human-approver',
  });
}
import {
  assessGovernanceRiskLevel,
  assessNodeRisk,
  classifyRisk,
  shouldRequestApproval,
} from '../src/ultimate/riskAssessor';
import type { HumanApprovalGate, TaskTreeNode } from '../src/ultimate/types';

function makeNode(overrides: Partial<TaskTreeNode> = {}): TaskTreeNode {
  return {
    id: overrides.id ?? 'node-1',
    goal: overrides.goal ?? 'investigate the issue',
    context: overrides.context ?? { availableTools: [] },
    subtasks: overrides.subtasks ?? [],
    dependencies: overrides.dependencies ?? [],
    isAtomic: overrides.isAtomic ?? true,
    status: overrides.status ?? 'PENDING',
    estimatedDurationMs: overrides.estimatedDurationMs ?? 1000,
  } as TaskTreeNode;
}

test('HumanApprovalManager: request returns a well-formed ApprovalRequest', (t) => {
  const manager = getHumanApprovalManager();
  t.after(() => manager.cancelAllForRun('run-1'));
  const gate: HumanApprovalGate = { enabled: true, timeoutMs: 1000 };
  const req = manager.request({
    runId: 'run-1',
    nodeId: 'node-A',
    nodeGoal: 'deploy to production',
    gate,
    riskLevel: 'high',
    requesterId: 'test',
  });

  assert.ok(req.approvalId.startsWith('appr_'));
  assert.equal(req.runId, 'run-1');
  assert.equal(req.nodeId, 'node-A');
  assert.equal(req.gate, gate);
  assert.equal(req.riskLevel, 'high');
  assert.ok(typeof req.requestedAt === 'string' && req.requestedAt.length > 0);
});

test('HumanApprovalManager: respond approve resolves the awaiter with approve', async (t) => {
  const manager = makeAuthenticatedManager();
  t.after(() => manager.cancelAllForRun('run-2'));
  const gate: HumanApprovalGate = { enabled: true, timeoutMs: 60000 };

  const req = manager.request({
    runId: 'run-2',
    nodeId: 'node-B',
    nodeGoal: 'send email',
    gate,
    riskLevel: 'medium',
    requesterId: 'test',
  });

  const resolutionPromise = manager.awaitResolution(req.approvalId);
  const resolved = manager.respond(req.approvalId, 'user-1', 'approve', 'LGTM');
  const awaited = await resolutionPromise;

  assert.notEqual(resolved, null);
  assert.equal(awaited.decision, 'approve');
  assert.equal(awaited.approverId, 'user-1');
  assert.equal(awaited.note, 'LGTM');
  assert.equal(awaited.timedOut, false);
});

test('HumanApprovalManager: first response wins, second is ignored', async (t) => {
  const manager = makeAuthenticatedManager();
  t.after(() => manager.cancelAllForRun('run-3'));
  const gate: HumanApprovalGate = { enabled: true, timeoutMs: 60000 };

  const req = manager.request({
    runId: 'run-3',
    nodeId: 'node-C',
    nodeGoal: 'modify file',
    gate,
    riskLevel: 'medium',
    requesterId: 'test',
  });

  const promise = manager.awaitResolution(req.approvalId);
  const first = manager.respond(req.approvalId, 'user-A', 'approve');
  const second = manager.respond(req.approvalId, 'user-B', 'reject');
  const result = await promise;

  assert.notEqual(first, null);
  assert.equal(second, null);
  assert.equal(result.decision, 'approve');
  assert.equal(result.approverId, 'user-A');
});

test('HumanApprovalManager: timeout falls back to gate.onTimeout (default reject)', async (t) => {
  const manager = getHumanApprovalManager();
  t.after(() => manager.cancelAllForRun('run-4'));
  const gate: HumanApprovalGate = { enabled: true, timeoutMs: 50 };

  const req = manager.request({
    runId: 'run-4',
    nodeId: 'node-D',
    nodeGoal: 'delete db',
    gate,
    riskLevel: 'critical',
    requesterId: 'test',
  });

  const result = await manager.awaitResolution(req.approvalId);
  assert.equal(result.timedOut, true);
  assert.equal(result.decision, 'reject');
  assert.equal(result.approverId, 'system:timeout');
});

test('HumanApprovalManager: cancelAllForRun rejects pending approvals for a run', async (t) => {
  const manager = getHumanApprovalManager();
  t.after(() => manager.cancelAllForRun('run-5'));
  const gate: HumanApprovalGate = { enabled: true, timeoutMs: 60000 };

  const req1 = manager.request({
    runId: 'run-5',
    nodeId: 'n1',
    nodeGoal: 'x',
    gate,
    riskLevel: 'low',
    requesterId: 'test',
  });
  const req2 = manager.request({
    runId: 'run-5',
    nodeId: 'n2',
    nodeGoal: 'y',
    gate,
    riskLevel: 'low',
    requesterId: 'test',
  });

  const p1 = manager.awaitResolution(req1.approvalId);
  const p2 = manager.awaitResolution(req2.approvalId);
  manager.cancelAllForRun('run-5');

  const r1 = await p1;
  const r2 = await p2;
  assert.equal(r1.decision, 'reject');
  assert.equal(r2.decision, 'reject');
  assert.equal(manager.listPending('run-5').length, 0);
});

test('HumanApprovalManager: getPending returns the request while pending', (t) => {
  const manager = getHumanApprovalManager();
  t.after(() => manager.cancelAllForRun('run-6'));
  const gate: HumanApprovalGate = { enabled: true, timeoutMs: 60000 };

  const req = manager.request({
    runId: 'run-6',
    nodeId: 'node-X',
    nodeGoal: 'commit and push',
    gate,
    riskLevel: 'medium',
    requesterId: 'test',
  });

  const pending = manager.getPending(req.approvalId);
  assert.ok(pending);
  assert.equal(pending?.nodeId, 'node-X');
});

// ---------------------------------------------------------------------------
// UA-01: the approval gate's timeout parameters are supplied by the plan being
// gated, so they must not be able to grant approval.
// ---------------------------------------------------------------------------

test('UA-01: gate.onTimeout "approve" is ignored — a timeout cannot grant approval', async (t) => {
  const manager = getHumanApprovalManager();
  t.after(() => manager.cancelAllForRun('run-ua01a'));
  const gate: HumanApprovalGate = { enabled: true, timeoutMs: 30, onTimeout: 'approve' };

  const req = manager.request({
    runId: 'run-ua01a',
    nodeId: 'node-self-approve',
    nodeGoal: 'delete production database',
    gate,
    riskLevel: 'critical',
    requesterId: 'plan-author',
  });

  const result = await manager.awaitResolution(req.approvalId);
  assert.equal(result.timedOut, true);
  assert.equal(
    result.decision,
    'reject',
    'a caller-supplied onTimeout:"approve" must not resolve as an approval',
  );
});

test('UA-01: timeout cannot approve even when an override environment variable is set', async (t) => {
  const previous = process.env.COMMANDER_ALLOW_APPROVE_ON_TIMEOUT;
  process.env.COMMANDER_ALLOW_APPROVE_ON_TIMEOUT = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.COMMANDER_ALLOW_APPROVE_ON_TIMEOUT;
    else process.env.COMMANDER_ALLOW_APPROVE_ON_TIMEOUT = previous;
  });
  const manager = getHumanApprovalManager();
  t.after(() => manager.cancelAllForRun('run-ua01-env'));
  const req = manager.request({
    runId: 'run-ua01-env',
    nodeId: 'node-env-override',
    nodeGoal: 'delete production database',
    gate: { enabled: true, timeoutMs: 30, onTimeout: 'approve' },
    riskLevel: 'critical',
    requesterId: 'plan-author',
  });
  const result = await manager.awaitResolution(req.approvalId);
  assert.equal(result.decision, 'reject');
});

test('UA-01: oversized gate.timeoutMs is clamped instead of firing immediately', async (t) => {
  const manager = getHumanApprovalManager();
  t.after(() => manager.cancelAllForRun('run-ua01b'));
  // 2^31 — setTimeout overflows past 2^31-1 and fires on the next tick.
  const gate: HumanApprovalGate = { enabled: true, timeoutMs: 2_147_483_648 };

  const req = manager.request({
    runId: 'run-ua01b',
    nodeId: 'node-overflow',
    nodeGoal: 'do something risky',
    gate,
    riskLevel: 'high',
    requesterId: 'plan-author',
  });

  await new Promise((r) => setTimeout(r, 40));
  assert.notEqual(
    manager.getPending(req.approvalId),
    null,
    'an overflowing timeout must not resolve the approval on the next tick',
  );
});

test('UA-01: non-finite gate.timeoutMs falls back to the default, not to 0ms', async (t) => {
  const manager = getHumanApprovalManager();
  t.after(() => manager.cancelAllForRun('run-ua01c'));
  const gate: HumanApprovalGate = { enabled: true, timeoutMs: Number.NaN };

  const req = manager.request({
    runId: 'run-ua01c',
    nodeId: 'node-nan',
    nodeGoal: 'do something risky',
    gate,
    riskLevel: 'high',
    requesterId: 'plan-author',
  });

  await new Promise((r) => setTimeout(r, 40));
  assert.notEqual(manager.getPending(req.approvalId), null);
});

// ---------------------------------------------------------------------------
// UA-02: respond() must not let the gated party resolve its own approval.
// ---------------------------------------------------------------------------

test('UA-02: the requester cannot approve its own request (separation of duties)', async (t) => {
  const manager = makeAuthenticatedManager();
  t.after(() => manager.cancelAllForRun('run-ua02a'));
  const gate: HumanApprovalGate = { enabled: true, timeoutMs: 60000 };

  const req = manager.request({
    runId: 'run-ua02a',
    nodeId: 'node-sod',
    nodeGoal: 'wire funds',
    gate,
    riskLevel: 'critical',
    requesterId: 'sub-agent-executor',
  });

  assert.throws(
    () => manager.respond(req.approvalId, 'sub-agent-executor', 'approve', 'self'),
    /separation of duties/,
  );
  assert.notEqual(manager.getPending(req.approvalId), null, 'the approval must still be pending');

  // A different principal can still resolve it.
  const resolved = manager.respond(req.approvalId, 'human-approver', 'approve');
  assert.equal(resolved?.decision, 'approve');
});

test('UA-02: an unauthenticated arbitrary approver is rejected fail closed', (t) => {
  const manager = getHumanApprovalManager();
  t.after(() => manager.cancelAllForRun('run-ua02-auth'));
  const req = manager.request({
    runId: 'run-ua02-auth',
    nodeId: 'node-auth',
    nodeGoal: 'wire funds',
    gate: { enabled: true, timeoutMs: 60000 },
    riskLevel: 'critical',
    requesterId: 'plan-author',
  });

  assert.throws(
    () => manager.respond(req.approvalId, 'human-approver', 'approve'),
    /authenticated approver context is required/,
  );
  assert.notEqual(manager.getPending(req.approvalId), null);
});

test('UA-02: a caller cannot forge a reserved system approver identity', async (t) => {
  const manager = getHumanApprovalManager();
  t.after(() => manager.cancelAllForRun('run-ua02b'));
  const gate: HumanApprovalGate = { enabled: true, timeoutMs: 60000 };

  const req = manager.request({
    runId: 'run-ua02b',
    nodeId: 'node-forge',
    nodeGoal: 'wire funds',
    gate,
    riskLevel: 'critical',
    requesterId: 'plan-author',
  });

  assert.throws(
    () => manager.respond(req.approvalId, 'system:timeout', 'approve'),
    /reserved system identity/,
  );
  assert.notEqual(manager.getPending(req.approvalId), null);
});

test('UA-02: empty approverId and invalid decisions are rejected', async (t) => {
  const manager = getHumanApprovalManager();
  t.after(() => manager.cancelAllForRun('run-ua02c'));
  const gate: HumanApprovalGate = { enabled: true, timeoutMs: 60000 };

  const req = manager.request({
    runId: 'run-ua02c',
    nodeId: 'node-invalid',
    nodeGoal: 'wire funds',
    gate,
    riskLevel: 'critical',
    requesterId: 'plan-author',
  });

  assert.throws(() => manager.respond(req.approvalId, '   ', 'approve'), /non-empty string/);
  assert.throws(
    () => manager.respond(req.approvalId, 'human-1', 'granted' as never),
    /invalid decision/,
  );
  assert.notEqual(manager.getPending(req.approvalId), null);
});

test('assessNodeRisk: low for read-only tasks with no risky tools', () => {
  const node = makeNode({ goal: 'summarize the README', context: { availableTools: [] } });
  const result = assessNodeRisk(node);
  assert.equal(result.level, 'low');
});

test('assessNodeRisk: critical for production deploys', () => {
  const node = makeNode({ goal: 'deploy to production', context: { availableTools: ['bash'] } });
  const result = assessNodeRisk(node);
  assert.ok(
    ['high', 'critical'].includes(result.level),
    `expected high/critical, got ${result.level}`,
  );
});

test('assessNodeRisk: high for shell_execute tool usage', () => {
  const node = makeNode({ goal: 'list files', context: { availableTools: ['shell_execute'] } });
  const result = assessNodeRisk(node);
  assert.ok(['high', 'critical'].includes(result.level));
});

test('assessNodeRisk: critical for credential keywords', () => {
  const node = makeNode({ goal: 'rotate the production secret', context: { availableTools: [] } });
  const result = assessNodeRisk(node);
  assert.ok(['high', 'critical'].includes(result.level));
});

test('assessNodeRisk: tenant risk profile CRITICAL escalates everything', () => {
  const node = makeNode({ goal: 'list files', context: { availableTools: [] } });
  const result = assessNodeRisk(node, 'CRITICAL');
  assert.equal(result.level, 'critical');
});

test('shouldRequestApproval: nodeIds allowlist triggers approval', () => {
  const node = makeNode({ id: 'pinned' });
  const gate: HumanApprovalGate = { enabled: true, nodeIds: ['pinned'] };
  const assessment = assessNodeRisk(node);
  assert.equal(shouldRequestApproval(gate, assessment, node), true);
});

test('shouldRequestApproval: riskThreshold triggers approval at threshold', () => {
  const node = makeNode({ goal: 'delete db in production', context: { availableTools: ['bash'] } });
  const gate: HumanApprovalGate = { enabled: true, riskThreshold: 'high' };
  const assessment = assessNodeRisk(node);
  assert.equal(shouldRequestApproval(gate, assessment, node), true);
});

test('shouldRequestApproval: returns false when gate is disabled', () => {
  const node = makeNode({ goal: 'deploy to production', context: { availableTools: ['bash'] } });
  const gate: HumanApprovalGate = { enabled: false, riskThreshold: 'low' };
  const assessment = assessNodeRisk(node);
  assert.equal(shouldRequestApproval(gate, assessment, node), false);
});

test('shouldRequestApproval: sampling is honored as a probability', () => {
  const node = makeNode({ goal: 'read a file' });
  const gate: HumanApprovalGate = { enabled: true, sampling: 1 };
  const assessment = assessNodeRisk(node);
  assert.equal(shouldRequestApproval(gate, assessment, node), true);
});

// ============================================================================
// Risk classification — keyword word boundaries + top-level governance risk
// ============================================================================

test('classifyRisk: short keywords do not match inside longer words', () => {
  // `key`, `auth` and `live` are CRITICAL keywords. Substring matching made
  // 'monkey', 'author' and 'lively' critical hits, which escalated innocuous
  // goals onto the human-approval path.
  const benign = ['fix the monkey patch', 'review the author list', 'lively discussion notes'];
  for (const goal of benign) {
    const result = classifyRisk(goal, []);
    assert.notEqual(result.level, 'critical', `"${goal}" must not be classified critical`);
  }
});

test('classifyRisk: whole-word keywords still match', () => {
  const result = classifyRisk('rotate the auth token', []);
  assert.equal(result.level, 'critical');
});

test('assessGovernanceRiskLevel: measures the goal instead of asserting LOW (ET-02)', () => {
  // Regression guard for the top-level entry points. CommanderCore.run,
  // Commander.run and AgentLoop used to hardcode
  // `governanceProfile.riskLevel = 'LOW'`, so telosOrchestrator computed
  // `requiresApproval: riskLevel === 'CRITICAL' || riskLevel === 'HIGH'` as
  // permanently false — the human-in-the-loop path could never engage.
  assert.equal(assessGovernanceRiskLevel('deploy to production', []), 'CRITICAL');
  assert.equal(assessGovernanceRiskLevel('summarize the README', []), 'LOW');
});

test('assessGovernanceRiskLevel: risky tools escalate even for a bland goal', () => {
  assert.equal(assessGovernanceRiskLevel('list files', ['shell_execute']), 'CRITICAL');
});
