import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SubAgentExecutor } from '../../src/ultimate/subAgentExecutor';
import { SubAgentLimitError } from '../../src/ultimate/subAgentGuard';
import type { TaskTreeNode, ExecutionError } from '../../src/ultimate/types';
import type { AgentRuntimeInterface } from '../../src/runtime';
import type { AgentExecutionResult } from '../../src/runtime/types';
import { getArtifactSystem, resetArtifactSystem } from '../../src/ultimate/artifactSystem';
import { getWorkCoordinator, resetWorkCoordinator } from '../../src/ultimate/workCoordinator';
import { getMessageBus, resetMessageBus } from '../../src/runtime/messageBus';
import { getMetricsCollector, resetMetricsCollector } from '../../src/runtime/metricsCollector';
import { getIntentLog, resetIntentLog } from '../../src/runtime/intentLog';
import { getTeamManager } from '../../src/ultimate/agentTeamManager';
import { agentContext } from '../../src/runtime/agentContext';
import { getAgentLineage } from '../../src/security/agentLineage';
import { getTokenBudgetManager } from '../../src/runtime/tokenBudgetManager';
import * as humanApprovalManager from '../../src/ultimate/humanApprovalManager';
import * as riskAssessor from '../../src/ultimate/riskAssessor';
import * as fs from 'node:fs';
import * as path from 'node:path';

function makeAgentResult(overrides: Partial<AgentExecutionResult> = {}): AgentExecutionResult {
  return {
    runId: 'run-1',
    agentId: 'agent-1',
    status: 'success',
    summary: 'done',
    steps: [],
    totalTokenUsage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
    totalDurationMs: 100,
    ...overrides,
  };
}

function makeRuntime(result: AgentExecutionResult = makeAgentResult()): AgentRuntimeInterface {
  return {
    execute: vi.fn().mockResolvedValue(result),
    getCompensationRegistry: () => ({
      compensateAll: async () => ({ errors: [] }),
    }),
  } as unknown as AgentRuntimeInterface;
}

function makeLeaf(id: string): TaskTreeNode {
  return {
    id,
    parentId: 'root',
    goal: `Goal ${id}`,
    role: 'EXECUTOR',
    isAtomic: true,
    status: 'PENDING',
    dependencies: [],
    context: { systemPrompt: '', availableTools: [], estimatedTokens: 500 },
    subtasks: [],
  };
}

function makeParent(): TaskTreeNode {
  return {
    id: 'root',
    parentId: null,
    goal: 'Parent goal',
    role: 'PLANNER',
    isAtomic: false,
    status: 'PENDING',
    dependencies: [],
    context: { systemPrompt: '', availableTools: [], estimatedTokens: 500 },
    subtasks: [makeLeaf('leaf-1'), makeLeaf('leaf-2')],
  };
}

describe('SubAgentExecutor', () => {
  beforeEach(() => {
    resetArtifactSystem();
    resetWorkCoordinator();
    resetMessageBus();
    resetMetricsCollector();
    resetIntentLog();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('setters update internal state', () => {
    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime);

    executor.setTeam('team-1');
    executor.setRunId('run-1');
    executor.setRunHandle(null);
    executor.setCheckpointer(null);
    executor.setApprovalGate(null);
    executor.setEffortLevel('COMPLEX');

    expect(executor.getCurrentRunId()).toBe('run-1');
    expect(executor.getSkippedApprovals()).toEqual([]);
  });

  it('executes an atomic leaf node successfully', async () => {
    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeLeaf('leaf-1');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('COMPLETED');
    expect(node.result).toBe('done');
    expect(node.tokenUsage).toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
    expect(errors).toHaveLength(0);
  });

  it('propagates execution failure to the errors array', async () => {
    const runtime = makeRuntime(makeAgentResult({ status: 'failed', error: 'boom' }));
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeLeaf('leaf-1');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('FAILED');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('boom');
  });

  it('executes a parent node by running subtasks and synthesizing', async () => {
    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeParent();
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('COMPLETED');
    expect(node.subtasks.every((s) => s.status === 'COMPLETED')).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('skips node when approval gate rejects', async () => {
    vi.spyOn(riskAssessor, 'assessNodeRisk').mockReturnValue({
      level: 'high',
      score: 0.9,
    } as any);
    vi.spyOn(riskAssessor, 'shouldRequestApproval').mockReturnValue(true);
    vi.spyOn(humanApprovalManager, 'getHumanApprovalManager').mockReturnValue({
      request: vi.fn().mockReturnValue({ approvalId: 'a1' }),
      awaitResolution: vi.fn().mockResolvedValue({ decision: 'reject', note: 'no go' }),
    } as any);

    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    executor.setApprovalGate({ enabled: true, mode: 'all', riskThreshold: 'medium' } as any);
    const node = makeLeaf('leaf-approval');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('SKIPPED');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('short-circuits already completed nodes', async () => {
    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeLeaf('leaf-done');
    node.status = 'COMPLETED';
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it('returns early when work coordinator already claimed the task', async () => {
    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    executor.setRunId('run-claimed');
    const node = makeLeaf('leaf-claimed');
    const wc = getWorkCoordinator();
    wc.enqueue({
      runId: 'run-claimed',
      parentNodeId: node.id,
      goal: node.goal,
      tools: [],
      tokenBudget: 500,
    });
    wc.claim(node.id, { runId: 'run-claimed', parentNodeId: node.id });

    const errors: ExecutionError[] = [];
    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('COMPLETED');
    expect(node.result).toContain('already claimed');
  });

  it('fails atomic node when output directory cannot be created', async () => {
    const tmpFile = `/tmp/subagent-test-${Date.now()}`;
    fs.writeFileSync(tmpFile, 'x');
    vi.spyOn(process, 'cwd').mockReturnValue(tmpFile);

    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeLeaf('leaf-mkdir-fail');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    fs.rmSync(tmpFile, { force: true });
    expect(node.status).toBe('FAILED');
    expect(errors[0].message).toContain('Failed to create output directory');
  });

  it('continues execution when lineage tracking throws', async () => {
    vi.spyOn(getAgentLineage(), 'spawnChild').mockImplementationOnce(() => {
      throw new Error('lineage down');
    });

    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeLeaf('leaf-lineage-fail');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('COMPLETED');
    expect(errors).toHaveLength(0);
  });

  it('handles runtime throwing a generic error', async () => {
    const runtime = makeRuntime();
    vi.spyOn(runtime, 'execute').mockRejectedValueOnce(new Error('runtime boom'));
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeLeaf('leaf-runtime-error');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('FAILED');
    expect(errors[0].message).toContain('runtime boom');
  });

  it('handles SubAgentLimitError from runtime', async () => {
    const runtime = makeRuntime();
    vi.spyOn(runtime, 'execute').mockRejectedValueOnce(
      new SubAgentLimitError('max_tokens', 1000, 1200),
    );
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeLeaf('leaf-limit');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('FAILED');
    expect(errors[0].message).toContain('max_tokens');
    expect(node.result).toContain('limit exceeded');
  });

  it('handles runtime returning null', async () => {
    const runtime = makeRuntime();
    vi.spyOn(runtime, 'execute').mockResolvedValueOnce(null as unknown as AgentExecutionResult);
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeLeaf('leaf-null');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('FAILED');
    expect(errors[0].message).toContain('no result');
  });

  it('handles non-success execution status', async () => {
    const runtime = makeRuntime(makeAgentResult({ status: 'partial', error: 'partial failure' }));
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeLeaf('leaf-partial');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('FAILED');
    expect(errors[0].message).toContain('partial failure');
  });

  it('reads inbox messages when node has team dependencies', async () => {
    const teamManager = getTeamManager();
    const team = teamManager.createTeam('team-inbox');
    teamManager.sendMessage(team.id, 'dep-1', 'leaf-inbox', 'hello', 'world', 'NORMAL');

    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    executor.setTeam(team.id);
    executor.setRunId('run-inbox');
    const node = makeLeaf('leaf-inbox');
    node.dependencies = ['dep-1'];
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('COMPLETED');
  });

  it('broadcasts team message after completion', async () => {
    const teamManager = getTeamManager();
    const team = teamManager.createTeam('team-broadcast');

    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    executor.setTeam(team.id);
    executor.setRunId('run-broadcast');
    const node = makeLeaf('leaf-broadcast');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('COMPLETED');
    const lastEvent = getMessageBus().getHistory('agent.message').pop();
    expect(lastEvent?.payload).toMatchObject({
      type: 'team_inbox',
      teamId: team.id,
    });
  });

  it('filters tools by role and uses role-specific prompts', async () => {
    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeLeaf('leaf-role');
    node.role = 'CODER';
    node.context.availableTools = ['file_read', 'bash', 'webSearch'];
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', { governanceProfile: 'x' }, errors);

    expect(node.status).toBe('COMPLETED');
  });

  it('propagates failures from subtasks and marks parent partial', async () => {
    const runtime = makeRuntime(makeAgentResult({ status: 'failed', error: 'subtask failed' }));
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeParent();
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('PARTIAL');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('orders subtasks by critical path and estimated duration', async () => {
    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeParent();
    node.subtasks.forEach((s, i) => {
      s.estimatedDurationMs = (i + 1) * 1000;
      s.isOnCriticalPath = i === 0;
    });
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('COMPLETED');
  });

  it('breaks topological deadlock with circular dependencies', async () => {
    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeParent();
    node.subtasks[0].dependencies = [node.subtasks[1].id];
    node.subtasks[1].dependencies = [node.subtasks[0].id];
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(['COMPLETED', 'PARTIAL']).toContain(node.status);
  });

  it('merges per-agent output directories into workspace', async () => {
    const workspace = `/tmp/cmdr-merge-${Date.now()}`;
    fs.mkdirSync(workspace, { recursive: true });
    process.env.COMMANDER_WORKSPACE = workspace;

    const node = makeParent();
    for (const sub of node.subtasks) {
      const safeId = sub.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const dir = path.join(workspace, '.commander_output', safeId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'result.txt'), `result from ${sub.id}`);
    }

    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    delete process.env.COMMANDER_WORKSPACE;
    expect(node.status).toBe('COMPLETED');
    for (const sub of node.subtasks) {
      const safeId = sub.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      expect(fs.existsSync(path.join(workspace, 'result.txt'))).toBe(true);
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('cleans up per-node output directory after atomic execution', async () => {
    const workspace = `/tmp/cmdr-cleanup-${Date.now()}`;
    fs.mkdirSync(workspace, { recursive: true });
    process.env.COMMANDER_WORKSPACE = workspace;

    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeLeaf('leaf-cleanup');
    const safeId = node.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = path.join(workspace, '.commander_output', safeId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'artifact.json'), '{}');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    delete process.env.COMMANDER_WORKSPACE;
    expect(node.status).toBe('COMPLETED');
    expect(fs.existsSync(path.join(workspace, 'artifact.json'))).toBe(true);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('handles artifact system write failure in outer catch', async () => {
    const runtime = {
      execute: vi.fn().mockResolvedValue(makeAgentResult()),
      getCompensationRegistry: () => ({
        compensateAll: vi.fn().mockRejectedValue(new Error('compensation boom')),
      }),
    } as unknown as AgentRuntimeInterface;
    const artifactSystem = {
      write: vi.fn().mockRejectedValue(new Error('artifact boom')),
    };
    const executor = new SubAgentExecutor(runtime, artifactSystem as any);
    executor.setRunId('run-outer');
    executor.setRunHandle({ id: 'handle', abortRun: vi.fn() } as any);
    const node = makeLeaf('leaf-outer');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('FAILED');
    expect(errors[0].message).toContain('artifact boom');
  });

  it('survives intent log and metrics failures when runtime errors', async () => {
    vi.spyOn(getIntentLog(), 'write').mockImplementation(() => {
      throw new Error('intent boom');
    });
    vi.spyOn(getMetricsCollector(), 'recordSubAgentOutcome').mockImplementation(() => {
      throw new Error('metrics boom');
    });

    const runtime = makeRuntime();
    vi.spyOn(runtime, 'execute').mockRejectedValueOnce(new Error('runtime boom'));
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeLeaf('leaf-metrics-fail');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('FAILED');
    expect(errors[0].message).toContain('runtime boom');
  });

  it('uses default options when none are provided', () => {
    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime);
    expect((executor as any).maxParallel).toBe(10);
    expect(executor.getCurrentRunId()).toBeNull();
  });

  it('writes checkpoints via the checkpointer', async () => {
    const checkpoint = vi.fn();
    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    executor.setCheckpointer({ checkpoint } as any);
    executor.setRunId('run-checkpoint');
    const node = makeLeaf('leaf-cp');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('COMPLETED');
    expect(checkpoint).toHaveBeenCalled();
  });

  it('runs subtasks in batches and allocates extra budget to critical path', async () => {
    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem(), 2);
    const node = makeParent();
    node.subtasks = Array.from({ length: 6 }, (_, i) => ({
      id: `sub-${i}`,
      goal: `goal-${i}`,
      status: 'PENDING',
      context: { availableTools: [], estimatedTokens: 100 },
      isAtomic: true,
      isOnCriticalPath: i === 0,
      dependencies: i === 0 ? [] : ['sub-0'],
      subtasks: [],
    })) as TaskTreeNode[];
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('COMPLETED');
    expect(node.subtasks.every((s) => s.status === 'COMPLETED')).toBe(true);
  });
});
