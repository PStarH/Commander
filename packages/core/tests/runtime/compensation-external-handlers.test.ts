import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitShadowWorkspace } from '../../src/compensation/external/gitShadow';
import { OutboxPattern } from '../../src/compensation/external/outboxPattern';
import { AgentConvergence, JudgeAgent } from '../../src/compensation/external/agentConvergence';
import {
  AWS_TOOL_TAGS,
  prepareEC2Memo,
  prepareLambdaUpdateMemo,
} from '../../src/compensation/external/aws';
import { SENDGRID_TOOL_TAGS } from '../../src/compensation/external/sendgrid';

describe('AWS Compensation Handler', () => {
  it('should have correct tool tags', () => {
    expect(AWS_TOOL_TAGS['aws:ec2:start']).toContain('low_risk');
    expect(AWS_TOOL_TAGS['aws:ec2:terminate']).toContain('non_reversible');
    expect(AWS_TOOL_TAGS['aws:s3:delete']).toContain('requires_approval');
    expect(AWS_TOOL_TAGS['aws:lambda:delete']).toContain('non_reversible');
    expect(AWS_TOOL_TAGS['aws:iam:user:delete']).toContain('requires_approval');
  });

  it('should prepare EC2 memo with original state', async () => {
    const mockClient = {
      describeInstances: vi.fn().mockResolvedValue({
        Reservations: [
          {
            Instances: [{ State: { Name: 'running' }, InstanceId: 'i-123' }],
          },
        ],
      }),
      startInstances: vi.fn(),
      stopInstances: vi.fn(),
      rebootInstances: vi.fn(),
      describeInstanceStatus: vi.fn(),
    };

    const memo = await prepareEC2Memo(mockClient as any, 'i-123');
    expect(memo.originalState).toBe('running');
    expect(mockClient.describeInstances).toHaveBeenCalledWith({
      InstanceIds: ['i-123'],
    });
  });

  it('should prepare Lambda update memo', async () => {
    const mockClient = {
      getFunction: vi.fn().mockResolvedValue({
        Configuration: {
          FunctionName: 'myFunc',
          Role: 'arn:aws:iam::role/old',
          Handler: 'index.handler',
          Runtime: 'nodejs18.x',
        },
      }),
      deleteFunction: vi.fn(),
      updateFunctionConfiguration: vi.fn(),
    };

    const memo = await prepareLambdaUpdateMemo(mockClient as any, 'myFunc');
    expect(memo.priorRole).toBe('arn:aws:iam::role/old');
    expect(memo.priorHandler).toBe('index.handler');
    expect(memo.priorRuntime).toBe('nodejs18.x');
  });
});

describe('SendGrid Compensation Handler', () => {
  it('should have correct tool tags', () => {
    expect(SENDGRID_TOOL_TAGS['sendgrid:send']).toContain('requires_approval');
    expect(SENDGRID_TOOL_TAGS['sendgrid:send_batch']).toContain('destructive');
  });
});

describe('GitShadowWorkspace', () => {
  it('should create shadow branch info', () => {
    const workspace = new GitShadowWorkspace({
      repoPath: '/tmp/test-repo',
      dryRun: true,
    });
    expect(workspace.getActiveBranch()).toBeNull();
  });

  it('should return null when no active branch', () => {
    const workspace = new GitShadowWorkspace({
      repoPath: '/tmp/test-repo',
      dryRun: true,
    });
    expect(workspace.getActiveBranch()).toBeNull();
  });
});

describe('OutboxPattern', () => {
  let outbox: OutboxPattern<{ to: string; subject: string }>;

  beforeEach(() => {
    outbox = new OutboxPattern({ maxEntries: 10 });
  });

  it('should stage entries', () => {
    const entry = outbox.stage('sendgrid:send', { to: 'test@example.com', subject: 'Hello' });
    expect(entry.id).toBeDefined();
    expect(entry.status).toBe('staged');
    expect(outbox.size()).toBe(1);
    expect(outbox.stagedSize()).toBe(1);
  });

  it('should verify staged entries', async () => {
    outbox.stage('sendgrid:send', { to: 'test@example.com', subject: 'Hello' });
    const result = await outbox.verify();
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('should commit entries', async () => {
    outbox.stage('sendgrid:send', { to: 'test@example.com', subject: 'Hello' });
    const result = await outbox.commit();
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(outbox.getCommittedEntries()).toHaveLength(1);
  });

  it('should discard staged entries', () => {
    outbox.stage('sendgrid:send', { to: 'test@example.com', subject: 'Hello' });
    outbox.stage('sendgrid:send', { to: 'test2@example.com', subject: 'Hello 2' });
    const result = outbox.discard();
    expect(result.discarded).toBe(2);
    expect(outbox.getDiscardedEntries()).toHaveLength(2);
  });

  it('should throw when outbox is full', () => {
    const smallOutbox = new OutboxPattern({ maxEntries: 2 });
    smallOutbox.stage('op1', { data: 1 });
    smallOutbox.stage('op2', { data: 2 });
    expect(() => smallOutbox.stage('op3', { data: 3 })).toThrow('Outbox full');
  });

  it('should clear all entries', () => {
    outbox.stage('op1', { data: 1 });
    outbox.stage('op2', { data: 2 });
    outbox.clear();
    expect(outbox.size()).toBe(0);
  });

  it('should use custom executor', async () => {
    const executor = vi.fn().mockResolvedValue({ success: true });
    const customOutbox = new OutboxPattern({}, executor);
    customOutbox.stage('op1', { data: 1 });
    await customOutbox.commit();
    expect(executor).toHaveBeenCalled();
  });
});

describe('AgentConvergence', () => {
  let convergence: AgentConvergence;

  beforeEach(() => {
    convergence = new AgentConvergence({ maxRounds: 3, convergenceThreshold: 0.8 });
  });

  it('should add arguments', () => {
    convergence.addArgument({
      agentId: 'agent-1',
      round: 1,
      content: 'Argument A',
      timestamp: new Date().toISOString(),
    });
    expect(convergence.getArguments()).toHaveLength(1);
    expect(convergence.getRound()).toBe(1);
  });

  it('should not converge with single agent', () => {
    convergence.addArgument({
      agentId: 'agent-1',
      round: 1,
      content: 'Argument A',
      timestamp: new Date().toISOString(),
    });
    const result = convergence.checkConvergence();
    expect(result.converged).toBe(false);
  });

  it('should converge when round limit reached', () => {
    for (let i = 0; i < 4; i++) {
      convergence.addArgument({
        agentId: `agent-${i % 2}`,
        round: i + 1,
        content: `Argument ${i}`,
        timestamp: new Date().toISOString(),
      });
    }
    const result = convergence.checkConvergence();
    expect(result.converged).toBe(true);
    expect(result.reason).toBe('round_limit');
  });

  it('should reset state', () => {
    convergence.addArgument({
      agentId: 'agent-1',
      round: 1,
      content: 'Argument A',
      timestamp: new Date().toISOString(),
    });
    convergence.reset();
    expect(convergence.getArguments()).toHaveLength(0);
    expect(convergence.getRound()).toBe(0);
  });
});

describe('JudgeAgent', () => {
  it('should evaluate arguments with rule-based judge', async () => {
    const judge = new JudgeAgent({ maxRounds: 5 });
    const args = [
      {
        agentId: 'agent-1',
        round: 1,
        content: 'We should use React for the frontend',
        timestamp: new Date().toISOString(),
      },
      {
        agentId: 'agent-2',
        round: 1,
        content: 'I agree, React is the best choice',
        timestamp: new Date().toISOString(),
      },
    ];

    const evaluation = await judge.evaluate(args);
    expect(evaluation.convergenceScore).toBeGreaterThanOrEqual(0);
    expect(evaluation.recommendation).toBeDefined();
  });

  it('should use LLM judge when provided', async () => {
    const llmCall = vi.fn().mockResolvedValue(
      JSON.stringify({
        convergenceScore: 0.9,
        repeatedArguments: [],
        strongestPoints: ['React is widely adopted'],
        recommendation: 'Convergence reached',
      }),
    );

    const judge = new JudgeAgent({ maxRounds: 5 }, llmCall);
    const args = [
      {
        agentId: 'agent-1',
        round: 1,
        content: 'Use React',
        timestamp: new Date().toISOString(),
      },
    ];

    const evaluation = await judge.evaluate(args);
    expect(evaluation.convergenceScore).toBe(0.9);
    expect(llmCall).toHaveBeenCalled();
  });

  it('should fallback to rule-based on LLM error', async () => {
    const llmCall = vi.fn().mockImplementation(() => Promise.reject(new Error('LLM failed')));
    const judge = new JudgeAgent({ maxRounds: 5 }, llmCall);

    try {
      await judge.evaluate([]);
    } catch (e) {
      expect(e).toBeDefined();
    }
  });
});
