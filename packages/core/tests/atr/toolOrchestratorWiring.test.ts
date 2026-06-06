import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { ToolOrchestrator } from '../../src/runtime/toolOrchestrator';
import { resetIdempotencyStore, getIdempotencyStore } from '../../src/atr/idempotencyStore';
import { getApprovalSystem } from '../../src/sandbox/approval';
import type { Tool } from '../../src/runtime/types';

function makeTool(name: string, opts: { isIdempotent?: boolean; execute: (args: Record<string, unknown>) => Promise<string> }): Tool {
  return {
    definition: {
      name,
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
    },
    execute: opts.execute,
    isIdempotent: opts.isIdempotent,
  };
}

function makeCall(id: string, name: string, args: Record<string, unknown> = {}): { id: string; name: string; arguments: Record<string, unknown> } {
  return { id, name, arguments: args };
}

describe('ToolOrchestrator + IdempotencyStore', () => {
  let orchestrator: ToolOrchestrator;
  let prevMode: ReturnType<ReturnType<typeof getApprovalSystem>['getMode']>;

  beforeEach(() => {
    process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
    resetIdempotencyStore();
    const approval = getApprovalSystem();
    prevMode = approval.getMode();
    approval.setMode('full-auto');
    orchestrator = new ToolOrchestrator({
      maxRetries: 0,
      defaultToolTimeoutMs: 5000,
    });
  });

  afterEach(() => {
    resetIdempotencyStore();
    delete process.env.COMMANDER_ATR_IDEMPOTENCY_PATH;
    getApprovalSystem().setMode(prevMode);
  });

  it('replays cached result for idempotent tool on second call (same step)', async () => {
    let callCount = 0;
    const tool = makeTool('fetch_pr', {
      isIdempotent: true,
      execute: async () => {
        callCount++;
        return 'pr-12345';
      },
    });
    const tools = new Map([['fetch_pr', tool]]);

    const plan1 = await orchestrator.planExecution([makeCall('1', 'fetch_pr', { id: 1 })], tools);
    const r1 = await orchestrator.execute(plan1, tools, { runId: 'r-1', agentId: 'a', stepNumber: 5 });
    assert.strictEqual(callCount, 1);
    assert.strictEqual(r1.results[0].output, 'pr-12345');

    const plan2 = await orchestrator.planExecution([makeCall('2', 'fetch_pr', { id: 1 })], tools);
    const r2 = await orchestrator.execute(plan2, tools, { runId: 'r-1', agentId: 'a', stepNumber: 5 });
    assert.strictEqual(callCount, 1, 'second call with same step must replay from cache');
    assert.strictEqual(r2.results[0].output, 'pr-12345');
  });

  it('non-idempotent tool is NOT routed through store (executed every time)', async () => {
    let callCount = 0;
    const tool = makeTool('shell_execute', {
      execute: async () => {
        callCount++;
        return `run-${callCount}`;
      },
    });
    const tools = new Map([['shell_execute', tool]]);

    const plan1 = await orchestrator.planExecution([makeCall('1', 'shell_execute')], tools);
    const r1 = await orchestrator.execute(plan1, tools, { runId: 'r-2', agentId: 'a', stepNumber: 1 });

    const plan2 = await orchestrator.planExecution([makeCall('2', 'shell_execute')], tools);
    const r2 = await orchestrator.execute(plan2, tools, { runId: 'r-2', agentId: 'a', stepNumber: 2 });

    assert.strictEqual(callCount, 2);
    assert.notStrictEqual(r1.results[0].output, r2.results[0].output);
  });

  it('different args produce different cache keys', async () => {
    let callCount = 0;
    const tool = makeTool('lookup', {
      isIdempotent: true,
      execute: async (args) => {
        callCount++;
        return `result-for-${args.id}`;
      },
    });
    const tools = new Map([['lookup', tool]]);

    const plan1 = await orchestrator.planExecution([makeCall('1', 'lookup', { id: 'a' })], tools);
    await orchestrator.execute(plan1, tools, { runId: 'r-3', agentId: 'a', stepNumber: 1 });

    const plan2 = await orchestrator.planExecution([makeCall('2', 'lookup', { id: 'b' })], tools);
    await orchestrator.execute(plan2, tools, { runId: 'r-3', agentId: 'a', stepNumber: 1 });

    assert.strictEqual(callCount, 2, 'distinct args → distinct keys → both executed');
  });

  it('cached failure surfaces cached error on retry', async () => {
    let callCount = 0;
    const tool = makeTool('flaky', {
      isIdempotent: true,
      execute: async () => {
        callCount++;
        throw new Error('503 Service Unavailable');
      },
    });
    const tools = new Map([['flaky', tool]]);

    const plan1 = await orchestrator.planExecution([makeCall('1', 'flaky')], tools);
    const r1 = await orchestrator.execute(plan1, tools, { runId: 'r-4', agentId: 'a', stepNumber: 7 });
    assert.ok(r1.results[0].error);

    const plan2 = await orchestrator.planExecution([makeCall('2', 'flaky')], tools);
    const r2 = await orchestrator.execute(plan2, tools, { runId: 'r-4', agentId: 'a', stepNumber: 7 });
    assert.ok(r2.results[0].error);
    assert.strictEqual(callCount, 1, 'failed call must not be re-executed on replay');
  });

  it('idempotencyKey function overrides default key generation', async () => {
    let callCount = 0;
    let lastSeenKey: string | undefined;
    const tool: Tool = {
      definition: { name: 'custom', description: '', inputSchema: { type: 'object' } },
      execute: async () => {
        callCount++;
        return 'ok';
      },
      idempotencyKey: (args) => {
        lastSeenKey = `custom-key-${(args as { id: string }).id}`;
        return lastSeenKey;
      },
    };
    const tools = new Map([['custom', tool]]);

    const plan1 = await orchestrator.planExecution([makeCall('1', 'custom', { id: 'X' })], tools);
    await orchestrator.execute(plan1, tools, { runId: 'r-5', agentId: 'a', stepNumber: 9 });
    assert.strictEqual(lastSeenKey, 'custom-key-X');

    const plan2 = await orchestrator.planExecution([makeCall('2', 'custom', { id: 'X' })], tools);
    await orchestrator.execute(plan2, tools, { runId: 'r-5', agentId: 'a', stepNumber: 9 });
    assert.strictEqual(callCount, 1);
  });
});

describe('IdempotencyStore singleton isolation', () => {
  it('store has the expected singleton lifecycle', () => {
    process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
    resetIdempotencyStore();
    const s1 = getIdempotencyStore();
    const s2 = getIdempotencyStore();
    assert.strictEqual(s1, s2);
    resetIdempotencyStore();
    const s3 = getIdempotencyStore();
    assert.notStrictEqual(s1, s3);
    resetIdempotencyStore();
    delete process.env.COMMANDER_ATR_IDEMPOTENCY_PATH;
  });
});
