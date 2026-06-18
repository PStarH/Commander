/**
 * Integration tests for P2 (StateCheckpointer) and P3 (HumanApproval) wiring
 * into the SubAgentExecutor.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SubAgentExecutor } from '../src/ultimate/subAgentExecutor';
import { StateCheckpointer } from '../src/runtime/stateCheckpointer';
import { AgentRuntime } from '../src/runtime/agentRuntime';
import { MockLLMProvider } from '../src/runtime/mockLLMProvider';
import { ModelRouter, resetModelRouter } from '../src/runtime/modelRouter';
import {
  getHumanApprovalManager,
  resetHumanApprovalManager,
} from '../src/ultimate/humanApprovalManager';
import type { ExecutionError, HumanApprovalGate, TaskTreeNode } from '../src/ultimate/types';

function makeAtomicNode(overrides: Partial<TaskTreeNode> = {}): TaskTreeNode {
  return {
    id: overrides.id ?? 'n1',
    goal: overrides.goal ?? 'summarize the README',
    context: overrides.context ?? { availableTools: [] },
    subtasks: overrides.subtasks ?? [],
    dependencies: overrides.dependencies ?? [],
    isAtomic: overrides.isAtomic ?? true,
    status: overrides.status ?? 'PENDING',
    estimatedDurationMs: overrides.estimatedDurationMs ?? 100,
  } as TaskTreeNode;
}

function buildRuntimeWithMockProvider(): { runtime: AgentRuntime; provider: MockLLMProvider } {
  resetModelRouter();
  const provider = new MockLLMProvider('test', { defaultResponse: 'completed task' });
  const router = new ModelRouter();
  const runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 2 }, router);
  runtime.registerProvider('test', provider);
  return { runtime, provider };
}

describe('SubAgentExecutor — P3 approval gate integration', () => {
  let tmpDir: string;
  let runtime: AgentRuntime;
  let provider: MockLLMProvider;
  let executor: SubAgentExecutor;
  let checkpointer: StateCheckpointer;
  let errors: ExecutionError[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appr-int-'));
    resetHumanApprovalManager();
    const built = buildRuntimeWithMockProvider();
    runtime = built.runtime;
    provider = built.provider;
    executor = new SubAgentExecutor(runtime);
    checkpointer = new StateCheckpointer(tmpDir);
    executor.setCheckpointer(checkpointer);
    executor.setRunId('run-' + Math.random().toString(36).slice(2, 8));
    errors = [];
  });

  afterEach(() => {
    resetHumanApprovalManager();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips a node when approval is required and times out (default reject)', async () => {
    const gate: HumanApprovalGate = { enabled: true, riskThreshold: 'low', timeoutMs: 50 };
    executor.setApprovalGate(gate);

    const node = makeAtomicNode({ id: 'skipped-1', goal: 'delete the production database' });
    await executor.executeNode(node, 'proj-1', {}, errors);

    assert.equal(node.status, 'SKIPPED');
    assert.ok(typeof node.result === 'string' && node.result.startsWith('[skipped]'));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].nodeId, 'skipped-1');

    const skipped = executor.getSkippedApprovals();
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].nodeId, 'skipped-1');
    assert.match(skipped[0].reason, /Timed out|approval not granted/);
  });

  it('proceeds when approval is required and approved (mid-flight approve resolves the wait)', async () => {
    const gate: HumanApprovalGate = { enabled: true, riskThreshold: 'low', timeoutMs: 60000 };
    executor.setApprovalGate(gate);

    const manager = getHumanApprovalManager();
    const runId = executor.getCurrentRunId() ?? '';
    const node = makeAtomicNode({ id: 'approved-1', goal: 'list the repo files' });

    const promise = executor.executeNode(node, 'proj-1', {}, errors);
    await new Promise((r) => setImmediate(r));
    const pending = manager.listPending(runId);
    assert.equal(pending.length, 1, 'expected exactly one in-flight approval');
    manager.respond(pending[0], 'user-1', 'approve', 'go');
    await promise;

    assert.equal(node.status, 'COMPLETED');
    assert.equal(executor.getSkippedApprovals().length, 0);
  });

  it('runs the node without an approval gate and checkpoints once on completion', async () => {
    executor.setApprovalGate(null);
    const node = makeAtomicNode({ id: 'free-1', goal: 'list the files in the repo' });

    await executor.executeNode(node, 'proj-1', {}, errors);

    assert.equal(node.status, 'COMPLETED');
    assert.equal(errors.length, 0);

    const restored = checkpointer.resume(executor.getCurrentRunId() ?? '');
    assert.notEqual(restored, null, 'expected a checkpoint to be written');
    assert.equal(restored?.runId, executor.getCurrentRunId());
    assert.equal(restored?.agentId, 'free-1');
  });

  it('writes a checkpoint even when a node is skipped due to approval', async () => {
    const gate: HumanApprovalGate = { enabled: true, riskThreshold: 'low', timeoutMs: 50 };
    executor.setApprovalGate(gate);
    const node = makeAtomicNode({ id: 'skipped-2', goal: 'deploy to production' });

    await executor.executeNode(node, 'proj-1', {}, errors);

    const restored = checkpointer.resume(executor.getCurrentRunId() ?? '');
    assert.notEqual(restored, null, 'expected a checkpoint to be written on skip');
    assert.equal(restored?.agentId, 'skipped-2');
  });

  it('cancelAllForRun rejects in-flight approvals when abort fires', async () => {
    const gate: HumanApprovalGate = { enabled: true, riskThreshold: 'low', timeoutMs: 60000 };
    executor.setApprovalGate(gate);

    const manager = getHumanApprovalManager();
    const node = makeAtomicNode({ id: 'cancelled-1', goal: 'send the email' });

    const promise = executor.executeNode(node, 'proj-1', {}, errors);
    await new Promise((r) => setImmediate(r));
    const runId = executor.getCurrentRunId() ?? '';
    manager.cancelAllForRun(runId);
    await promise;

    assert.equal(node.status, 'SKIPPED');
    assert.equal(errors.length, 1);
  });
});
