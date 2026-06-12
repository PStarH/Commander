import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getHumanApprovalManager } from '../src/ultimate/humanApprovalManager';
import { assessNodeRisk, shouldRequestApproval } from '../src/ultimate/riskAssessor';
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
  const manager = getHumanApprovalManager();
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
  const manager = getHumanApprovalManager();
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

  const req1 = manager.request({ runId: 'run-5', nodeId: 'n1', nodeGoal: 'x', gate, riskLevel: 'low', requesterId: 'test' });
  const req2 = manager.request({ runId: 'run-5', nodeId: 'n2', nodeGoal: 'y', gate, riskLevel: 'low', requesterId: 'test' });

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
    runId: 'run-6', nodeId: 'node-X', nodeGoal: 'commit and push',
    gate, riskLevel: 'medium', requesterId: 'test',
  });

  const pending = manager.getPending(req.approvalId);
  assert.ok(pending);
  assert.equal(pending?.nodeId, 'node-X');
});

test('assessNodeRisk: low for read-only tasks with no risky tools', () => {
  const node = makeNode({ goal: 'summarize the README', context: { availableTools: [] } });
  const result = assessNodeRisk(node);
  assert.equal(result.level, 'low');
});

test('assessNodeRisk: critical for production deploys', () => {
  const node = makeNode({ goal: 'deploy to production', context: { availableTools: ['bash'] } });
  const result = assessNodeRisk(node);
  assert.ok(['high', 'critical'].includes(result.level), `expected high/critical, got ${result.level}`);
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
