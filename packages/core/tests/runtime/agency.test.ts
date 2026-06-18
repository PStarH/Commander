import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { test, describe, before, after } from 'node:test';

// ── DeadLetterQueue ──

describe('DeadLetterQueue', async () => {
  const testDir = path.join(process.cwd(), '.test_dlq');

  test('records and reads entries', async () => {
    const { DeadLetterQueue } = await import('../../src/runtime/deadLetterQueue');
    const dlq = new DeadLetterQueue(testDir);
    dlq.record({
      id: 'dlq_1',
      category: 'tool',
      runId: 'run_1',
      agentId: 'agent_a',
      timestamp: new Date().toISOString(),
      errorClass: 'transient',
      errorMessage: 'timeout',
      retryable: true,
      attemptNumber: 0,
      operationName: 'web_search',
      compensated: false,
      recovered: false,
      tags: [],
    });
    dlq.flush('tool');
    const entries = dlq.readEntries('tool', 10);
    assert.ok(entries.length >= 1);
    assert.equal(entries[0].errorMessage, 'timeout');
    assert.equal(entries[0].operationName, 'web_search');
  });

  test('returns stats per category', async () => {
    const { DeadLetterQueue } = await import('../../src/runtime/deadLetterQueue');
    const dlq = new DeadLetterQueue(testDir);
    dlq.record({
      id: 'dlq_2',
      category: 'llm',
      runId: 'run_2',
      agentId: 'agent_b',
      timestamp: new Date().toISOString(),
      errorClass: 'permanent',
      errorMessage: 'auth failed',
      retryable: false,
      attemptNumber: 0,
      operationName: 'llm_call',
      compensated: false,
      recovered: false,
      tags: [],
    });
    dlq.flush('llm');
    const stats = dlq.getStats();
    assert.ok(stats.some((s) => s.category === 'tool'));
    assert.ok(stats.some((s) => s.category === 'llm'));
  });

  after(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });
});

// ── CompensationRegistry ──

describe('CompensationRegistry', async () => {
  test('registers handler and compensates action', async () => {
    const { CompensationRegistry } = await import('../../src/runtime/compensationRegistry');
    const registry = new CompensationRegistry();
    const compensated: string[] = [];
    registry.register('file_write', async (action) => {
      compensated.push(action.actionId);
      return { success: true };
    });
    registry.recordAction({
      actionId: 'act_1',
      toolName: 'file_write',
      args: { filePath: '/tmp/test.txt' },
      description: 'write test file',
      tags: ['test'],
    });
    const result = await registry.compensate('act_1');
    assert.ok(result.success);
    assert.equal(compensated.length, 1);
    assert.equal(compensated[0], 'act_1');
  });

  test('compensateAll runs in reverse order', async () => {
    const { CompensationRegistry } = await import('../../src/runtime/compensationRegistry');
    const registry = new CompensationRegistry();
    const order: string[] = [];
    registry.register('tool_a', async (a) => {
      order.push(a.actionId);
      return { success: true };
    });
    registry.register('tool_b', async (a) => {
      order.push(a.actionId);
      return { success: true };
    });
    registry.recordAction({
      actionId: 'first',
      toolName: 'tool_a',
      args: {},
      description: '',
      tags: [],
    });
    registry.recordAction({
      actionId: 'second',
      toolName: 'tool_b',
      args: {},
      description: '',
      tags: [],
    });
    await registry.compensateAll();
    assert.deepEqual(order, ['second', 'first']);
  });

  test('pending count decreases after compensation', async () => {
    const { CompensationRegistry } = await import('../../src/runtime/compensationRegistry');
    const registry = new CompensationRegistry();
    registry.register('tool', async () => ({ success: true }));
    registry.recordAction({
      actionId: 'a1',
      toolName: 'tool',
      args: {},
      description: '',
      tags: [],
    });
    registry.recordAction({
      actionId: 'a2',
      toolName: 'tool',
      args: {},
      description: '',
      tags: [],
    });
    assert.equal(registry.getPendingCount(), 2);
    await registry.compensate('a1');
    assert.equal(registry.getPendingCount(), 1);
    assert.equal(registry.getCompensatedCount(), 1);
  });
});

// ── AgentInbox ──

describe('AgentInbox', async () => {
  const testDir = path.join(process.cwd(), '.test_inboxes');

  test('send and pollInbox returns unread messages', async () => {
    const { AgentInbox } = await import('../../src/runtime/agentInbox');
    const inbox = new AgentInbox(testDir);
    inbox.send({
      id: 'msg_1',
      from: 'agent_a',
      to: 'agent_b',
      subject: 'hello',
      body: 'test message',
      priority: 'normal',
      tags: [],
    });
    const unread = inbox.pollInbox('agent_b');
    assert.equal(unread.length, 1);
    assert.equal(unread[0].subject, 'hello');
    assert.equal(unread[0].status, 'read');
    // Second poll returns nothing
    assert.equal(inbox.pollInbox('agent_b').length, 0);
  });

  test('acknowledge marks message as processed', async () => {
    const { AgentInbox } = await import('../../src/runtime/agentInbox');
    const inbox = new AgentInbox(testDir);
    inbox.send({
      id: 'msg_2',
      from: 'a',
      to: 'b',
      subject: 'test',
      body: '',
      priority: 'normal',
      tags: [],
    });
    const msgs = inbox.pollInbox('b');
    assert.ok(inbox.acknowledge('b', msgs[0].id));
    const all = inbox.getMessages('b');
    assert.equal(all[0].status, 'acknowledged');
  });

  test('prune removes acknowledged and expired messages', async () => {
    const { AgentInbox } = await import('../../src/runtime/agentInbox');
    const inbox = new AgentInbox(testDir);
    inbox.send({
      id: 'keep',
      from: 'a',
      to: 'c',
      subject: 'keep',
      body: '',
      priority: 'normal',
      tags: [],
    });
    inbox.send({
      id: 'expire',
      from: 'a',
      to: 'c',
      subject: 'expire',
      body: '',
      priority: 'normal',
      tags: [],
      ttlMs: -1,
    });
    const msgs = inbox.pollInbox('c');
    inbox.acknowledge('c', 'keep');
    const pruned = inbox.prune('c');
    assert.ok(pruned >= 2);
  });

  test('persistence across instances', async () => {
    const { AgentInbox } = await import('../../src/runtime/agentInbox');
    const inbox1 = new AgentInbox(testDir);
    inbox1.send({
      id: 'persist_1',
      from: 'x',
      to: 'y',
      subject: 'persist',
      body: 'data',
      priority: 'normal',
      tags: [],
    });
    inbox1.pollInbox('y');
    inbox1.dispose();
    const inbox2 = new AgentInbox(testDir);
    const msgs = inbox2.getMessages('y');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].subject, 'persist');
  });

  after(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });
});

// ── TeamRegistry ──

describe('TeamRegistry', async () => {
  const manifestPath = path.join(process.cwd(), '.test_teams', 'manifest.json');

  test('create, get, delete team', async () => {
    const { TeamRegistry } = await import('../../src/runtime/teamRegistry');
    const registry = new TeamRegistry(manifestPath);
    registry.createTeam({
      teamId: 'team_1',
      name: 'Alpha',
      description: 'test team',
      members: [{ agentId: 'agent_a', role: 'lead', joinedAt: new Date().toISOString() }],
      createdBy: 'admin',
      tags: [],
    });
    const team = registry.getTeam('team_1');
    assert.ok(team);
    assert.equal(team.name, 'Alpha');
    assert.equal(team.members.length, 1);
    assert.ok(registry.deleteTeam('team_1'));
    assert.ok(!registry.getTeam('team_1'));
  });

  test('add and remove members', async () => {
    const { TeamRegistry } = await import('../../src/runtime/teamRegistry');
    const registry = new TeamRegistry(manifestPath);
    registry.createTeam({
      teamId: 'team_2',
      name: 'Beta',
      description: '',
      members: [],
      createdBy: 'admin',
      tags: [],
    });
    assert.ok(registry.addMember('team_2', { agentId: 'worker_1', role: 'worker', joinedAt: '' }));
    // Duplicate returns false
    assert.ok(!registry.addMember('team_2', { agentId: 'worker_1', role: 'worker', joinedAt: '' }));
    assert.equal(registry.getMembers('team_2').length, 1);
    assert.ok(registry.removeMember('team_2', 'worker_1'));
    assert.equal(registry.getMembers('team_2').length, 0);
  });

  test('role assignment and lead query', async () => {
    const { TeamRegistry } = await import('../../src/runtime/teamRegistry');
    const registry = new TeamRegistry(manifestPath);
    registry.createTeam({
      teamId: 'team_3',
      name: 'Gamma',
      description: '',
      members: [
        { agentId: 'lead_1', role: 'lead', joinedAt: '' },
        { agentId: 'worker_2', role: 'worker', joinedAt: '' },
      ],
      createdBy: 'admin',
      tags: [],
    });
    assert.equal(registry.getLead('team_3')?.agentId, 'lead_1');
    assert.ok(registry.setRole('team_3', 'worker_2', 'reviewer'));
    assert.equal(registry.getMembers('team_3', 'reviewer').length, 1);
  });

  test('find teams for agent', async () => {
    const { TeamRegistry } = await import('../../src/runtime/teamRegistry');
    const registry = new TeamRegistry(manifestPath);
    assert.ok(registry.findTeamsForAgent('lead_1').some((t) => t.teamId === 'team_3'));
  });

  test('prune empty teams', async () => {
    const { TeamRegistry } = await import('../../src/runtime/teamRegistry');
    const registry = new TeamRegistry(manifestPath);
    registry.createTeam({
      teamId: 'empty_team',
      name: 'Empty',
      description: '',
      members: [],
      createdBy: 'admin',
      tags: [],
    });
    assert.ok(registry.pruneEmpty() >= 1);
  });

  after(() => {
    fs.rmSync(path.dirname(manifestPath), { recursive: true, force: true });
  });
});

// ── AgentHandoff ──

describe('AgentHandoff', async () => {
  const testDir = path.join(process.cwd(), '.test_handoff');

  test('request creates inbox message and stores handoff', async () => {
    const { AgentInbox } = await import('../../src/runtime/agentInbox');
    const { AgentHandoff } = await import('../../src/runtime/agentHandoff');
    const inbox = new AgentInbox(testDir);
    const handoff = new AgentHandoff(inbox);
    const req = await handoff.request({
      handoffId: 'ho_1',
      fromAgent: 'agent_a',
      toAgent: 'agent_b',
      goal: 'finish the task',
      context: {
        messages: [{ role: 'user', content: 'hello' }],
        availableTools: ['web_search'],
        tokenBudget: 1000,
      },
    });
    assert.equal(req.status, 'requested');
    // Check inbox message was delivered
    const msgs = inbox.pollInbox('agent_b');
    assert.ok(msgs.some((m) => m.payload?.handoffId === 'ho_1'));
  });

  test('accept updates status and sends ack', async () => {
    const { AgentInbox } = await import('../../src/runtime/agentInbox');
    const { AgentHandoff } = await import('../../src/runtime/agentHandoff');
    const inbox = new AgentInbox(testDir);
    const handoff = new AgentHandoff(inbox);
    await handoff.request({
      handoffId: 'ho_2',
      fromAgent: 'a',
      toAgent: 'b',
      goal: 'test',
      context: { messages: [], availableTools: [], tokenBudget: 100 },
    });
    const accepted = await handoff.accept('ho_2', 'OK');
    assert.ok(accepted);
    assert.equal(accepted!.status, 'accepted');
  });

  test('reject updates status and sends rejection', async () => {
    const { AgentInbox } = await import('../../src/runtime/agentInbox');
    const { AgentHandoff } = await import('../../src/runtime/agentHandoff');
    const inbox = new AgentInbox(testDir);
    const handoff = new AgentHandoff(inbox);
    await handoff.request({
      handoffId: 'ho_3',
      fromAgent: 'a',
      toAgent: 'b',
      goal: 'test',
      context: { messages: [], availableTools: [], tokenBudget: 100 },
    });
    const rejected = await handoff.reject('ho_3', 'busy');
    assert.ok(rejected);
    assert.equal(rejected!.status, 'rejected');
    assert.equal(rejected!.response, 'busy');
  });

  after(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });
});

// ── HookManager (plugin system) ──

describe('HookManager (plugin system)', async () => {
  test('register with config validation', async () => {
    const { HookManager } = await import('../../src/pluginManager');
    const hm = new HookManager();
    await hm.register(
      {
        name: 'test-plugin',
        configSchema: {
          type: 'object',
          properties: {
            apiKey: { type: 'string' },
            retries: { type: 'number', default: 3 },
          },
          required: ['apiKey'],
        },
        onLoad: async (ctx) => {
          assert.equal(ctx.config.apiKey, 'sk-xxx');
          assert.equal(ctx.config.retries, 3);
        },
      },
      { apiKey: 'sk-xxx' },
    );
    assert.ok(hm.hasPlugin('test-plugin'));
    const info = hm.getPluginInfo('test-plugin');
    assert.equal(info?.config.apiKey, 'sk-xxx');
    assert.equal(info?.enabled, true);
  });

  test('register rejects missing required config', async () => {
    const { HookManager } = await import('../../src/pluginManager');
    const hm = new HookManager();
    await assert.rejects(async () => {
      await hm.register(
        {
          name: 'bad-plugin',
          configSchema: {
            type: 'object',
            properties: { apiKey: { type: 'string' } },
            required: ['apiKey'],
          },
        },
        {},
      );
    });
  });

  test('onLoad failure rejects registration', async () => {
    const { HookManager } = await import('../../src/pluginManager');
    const hm = new HookManager();
    await assert.rejects(async () => {
      await hm.register({
        name: 'failing-plugin',
        onLoad: async () => {
          throw new Error('init failed');
        },
      });
    });
    assert.ok(!hm.hasPlugin('failing-plugin'));
  });

  test('enable/disable', async () => {
    const { HookManager } = await import('../../src/pluginManager');
    const hm = new HookManager();
    await hm.register({ name: 'toggle-plugin' });
    assert.ok(hm.isEnabled('toggle-plugin'));
    hm.disable('toggle-plugin');
    assert.ok(!hm.isEnabled('toggle-plugin'));
    hm.enable('toggle-plugin');
    assert.ok(hm.isEnabled('toggle-plugin'));
  });

  test('unregister calls onUnload', async () => {
    const { HookManager } = await import('../../src/pluginManager');
    const hm = new HookManager();
    let unloaded = false;
    await hm.register({
      name: 'unload-test',
      onUnload: async () => {
        unloaded = true;
      },
    });
    await hm.unregister('unload-test');
    assert.ok(unloaded);
    assert.ok(!hm.hasPlugin('unload-test'));
  });

  test('hook firing order respects dependencies', async () => {
    const { HookManager } = await import('../../src/pluginManager');
    const hm = new HookManager();
    const order: string[] = [];
    await hm.register({
      name: 'base-plugin',
      dependsOn: [],
      beforeToolCall: async () => {
        order.push('base');
        return null;
      },
    });
    await hm.register({
      name: 'derived-plugin',
      dependsOn: ['base-plugin'],
      beforeToolCall: async () => {
        order.push('derived');
        return null;
      },
    });
    await hm.fireBeforeToolCall({
      toolName: 'test',
      args: {},
      agentId: 'a',
      runId: 'r1',
    });
    assert.deepEqual(order, ['base', 'derived']);
  });

  test('disabled plugin hooks are not fired', async () => {
    const { HookManager } = await import('../../src/pluginManager');
    const hm = new HookManager();
    let fired = false;
    await hm.register({
      name: 'disabled-test',
      beforeToolCall: async () => {
        fired = true;
        return null;
      },
    });
    hm.disable('disabled-test');
    await hm.fireBeforeToolCall({
      toolName: 'test',
      args: {},
      agentId: 'a',
      runId: 'r1',
    });
    assert.ok(!fired);
  });

  test('register blocks circular deps', async () => {
    const { HookManager } = await import('../../src/pluginManager');
    const hm = new HookManager();
    await hm.register({ name: 'a' });
    await assert.rejects(
      () => hm.register({ name: 'b', dependsOn: ['c'] }),
      /depends on "c" which is not registered/,
    );
  });

  test('beforeToolCall override blocks subsequent hooks', async () => {
    const { HookManager } = await import('../../src/pluginManager');
    const hm = new HookManager();
    let afterBlockCalled = false;
    await hm.register({
      name: 'blocker',
      beforeToolCall: async () => ({
        toolCallId: '0',
        name: 'test',
        output: '',
        error: 'Blocked',
        durationMs: 0,
      }),
    });
    await hm.register({
      name: 'after-blocker',
      beforeToolCall: async () => {
        afterBlockCalled = true;
        return null;
      },
    });
    const result = await hm.fireBeforeToolCall({
      toolName: 'test',
      args: {},
      agentId: 'a',
      runId: 'r1',
    });
    assert.ok(result?.error === 'Blocked');
    assert.ok(!afterBlockCalled);
  });
});
