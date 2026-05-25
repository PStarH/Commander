/**
 * Plugin Hook Integration Tests
 *
 * Verifies all 12 Sprint 3 interceptor hook points fire correctly,
 * error isolation, beforeBackendSelect override, and disabled plugin behavior.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { resetHookManager, getHookManager, HookManager } from '../src/pluginManager';
import type {
  CommanderPlugin, BeforeToolResolveContext, AfterToolResolveContext,
  ToolTimeoutContext, ToolRetryContext, ContextCompactionContext,
  SessionForkContext, SessionArchiveContext, StepLifecycleContext,
  BeforeBackendSelectContext, AfterBackendSelectContext,
} from '../src/pluginManager';
import { ExecutionRouter } from '../src/sandbox/executionRouter';

function freshHookManager(): HookManager {
  resetHookManager();
  return getHookManager();
}

// ============================================================================
// Hook recording plugin factory
// ============================================================================
interface HookRecord {
  beforeToolResolve: BeforeToolResolveContext[];
  afterToolResolve: AfterToolResolveContext[];
  onToolTimeout: ToolTimeoutContext[];
  onToolRetry: ToolRetryContext[];
  beforeContextCompaction: ContextCompactionContext[];
  afterContextCompaction: ContextCompactionContext[];
  onSessionFork: SessionForkContext[];
  onSessionArchive: SessionArchiveContext[];
  onStepStart: StepLifecycleContext[];
  onStepComplete: StepLifecycleContext[];
  beforeBackendSelect: BeforeBackendSelectContext[];
  afterBackendSelect: AfterBackendSelectContext[];
}

function emptyRecord(): HookRecord {
  return {
    beforeToolResolve: [],
    afterToolResolve: [],
    onToolTimeout: [],
    onToolRetry: [],
    beforeContextCompaction: [],
    afterContextCompaction: [],
    onSessionFork: [],
    onSessionArchive: [],
    onStepStart: [],
    onStepComplete: [],
    beforeBackendSelect: [],
    afterBackendSelect: [],
  };
}

function createRecordingPlugin(name: string, record: HookRecord): CommanderPlugin {
  return {
    name,
    beforeToolResolve: async (ctx) => { record.beforeToolResolve.push(ctx); return null; },
    afterToolResolve: async (ctx) => { record.afterToolResolve.push(ctx); },
    onToolTimeout: async (ctx) => { record.onToolTimeout.push(ctx); },
    onToolRetry: async (ctx) => { record.onToolRetry.push(ctx); },
    beforeContextCompaction: async (ctx) => { record.beforeContextCompaction.push(ctx); },
    afterContextCompaction: async (ctx) => { record.afterContextCompaction.push(ctx); },
    onSessionFork: async (ctx) => { record.onSessionFork.push(ctx); },
    onSessionArchive: async (ctx) => { record.onSessionArchive.push(ctx); },
    onStepStart: async (ctx) => { record.onStepStart.push(ctx); },
    onStepComplete: async (ctx) => { record.onStepComplete.push(ctx); },
    beforeBackendSelect: async (ctx) => { record.beforeBackendSelect.push(ctx); return null; },
    afterBackendSelect: async (ctx) => { record.afterBackendSelect.push(ctx); },
  };
}

// ============================================================================
// All 12 new hook points fire correctly
// ============================================================================
describe('Sprint 3 Hook Points', () => {
  let hm: HookManager;
  let record: HookRecord;

  beforeEach(() => {
    hm = freshHookManager();
    record = emptyRecord();
  });

  afterEach(async () => {
    // Cleanup all plugins
    for (const name of hm.listPlugins()) {
      await hm.unregister(name);
    }
  });

  it('beforeToolResolve fires with correct context', async () => {
    await hm.register(createRecordingPlugin('p1', record));
    const result = await hm.fireBeforeToolResolve({
      toolName: 'web_search', args: { query: 'test' }, agentId: 'a1', runId: 'r1',
    });
    assert.strictEqual(result, null); // no plugin blocked
    assert.strictEqual(record.beforeToolResolve.length, 1);
    assert.strictEqual(record.beforeToolResolve[0].toolName, 'web_search');
    assert.strictEqual(record.beforeToolResolve[0].agentId, 'a1');
    assert.strictEqual(record.beforeToolResolve[0].runId, 'r1');
    assert.deepStrictEqual(record.beforeToolResolve[0].args, { query: 'test' });
  });

  it('afterToolResolve fires with correct context', async () => {
    await hm.register(createRecordingPlugin('p1', record));
    await hm.fireAfterToolResolve({
      toolName: 'file_read', args: { path: '/tmp/x' }, agentId: 'a1', runId: 'r1',
      tool: { name: 'file_read', category: 'filesystem' }, notFound: false,
    });
    assert.strictEqual(record.afterToolResolve.length, 1);
    assert.strictEqual(record.afterToolResolve[0].toolName, 'file_read');
    assert.strictEqual(record.afterToolResolve[0].notFound, false);
  });

  it('afterToolResolve reports notFound=true', async () => {
    await hm.register(createRecordingPlugin('p1', record));
    await hm.fireAfterToolResolve({
      toolName: 'nonexistent_tool', args: {}, agentId: 'a1', runId: 'r1',
      notFound: true,
    });
    assert.strictEqual(record.afterToolResolve[0].notFound, true);
  });

  it('onToolTimeout fires with correct context', async () => {
    await hm.register(createRecordingPlugin('p1', record));
    await hm.fireOnToolTimeout({
      toolName: 'python_execute', args: { code: 'x' }, timeoutMs: 5000,
      durationMs: 5234, agentId: 'a1', runId: 'r1',
    });
    assert.strictEqual(record.onToolTimeout.length, 1);
    assert.strictEqual(record.onToolTimeout[0].toolName, 'python_execute');
    assert.strictEqual(record.onToolTimeout[0].timeoutMs, 5000);
    assert.ok(record.onToolTimeout[0].durationMs >= 5000);
  });

  it('onToolRetry fires with correct context', async () => {
    await hm.register(createRecordingPlugin('p1', record));
    await hm.fireOnToolRetry({
      toolName: 'shell_execute', args: { command: 'foo' }, attempt: 2,
      maxRetries: 3, lastError: 'connection reset', agentId: 'a1', runId: 'r1',
    });
    assert.strictEqual(record.onToolRetry.length, 1);
    assert.strictEqual(record.onToolRetry[0].attempt, 2);
    assert.strictEqual(record.onToolRetry[0].maxRetries, 3);
    assert.strictEqual(record.onToolRetry[0].lastError, 'connection reset');
  });

  it('beforeContextCompaction fires with correct context', async () => {
    await hm.register(createRecordingPlugin('p1', record));
    await hm.fireBeforeContextCompaction({
      messageCount: 150, totalTokens: 12000, budgetTokens: 8000,
      agentId: 'a1', runId: 'r1',
    });
    assert.strictEqual(record.beforeContextCompaction.length, 1);
    assert.strictEqual(record.beforeContextCompaction[0].messageCount, 150);
    assert.strictEqual(record.beforeContextCompaction[0].totalTokens, 12000);
    assert.strictEqual(record.beforeContextCompaction[0].budgetTokens, 8000);
  });

  it('afterContextCompaction fires with correct context', async () => {
    await hm.register(createRecordingPlugin('p1', record));
    await hm.fireAfterContextCompaction({
      messageCount: 80, totalTokens: 6000, budgetTokens: 8000,
      agentId: 'a1', runId: 'r1',
    });
    assert.strictEqual(record.afterContextCompaction.length, 1);
    assert.strictEqual(record.afterContextCompaction[0].messageCount, 80);
  });

  it('onSessionFork fires with correct context', async () => {
    await hm.register(createRecordingPlugin('p1', record));
    await hm.fireOnSessionFork({
      parentRunId: 'parent-123', childRunId: 'child-456',
      agentId: 'a1', goal: 'analyze data',
    });
    assert.strictEqual(record.onSessionFork.length, 1);
    assert.strictEqual(record.onSessionFork[0].parentRunId, 'parent-123');
    assert.strictEqual(record.onSessionFork[0].childRunId, 'child-456');
    assert.strictEqual(record.onSessionFork[0].goal, 'analyze data');
  });

  it('onSessionArchive fires with correct context', async () => {
    await hm.register(createRecordingPlugin('p1', record));
    await hm.fireOnSessionArchive({
      runId: 'run-789', phase: 'execution', stepNumber: 5,
      tokenUsage: { totalTokens: 15000 },
    });
    assert.strictEqual(record.onSessionArchive.length, 1);
    assert.strictEqual(record.onSessionArchive[0].runId, 'run-789');
    assert.strictEqual(record.onSessionArchive[0].phase, 'execution');
    assert.strictEqual(record.onSessionArchive[0].stepNumber, 5);
    assert.strictEqual(record.onSessionArchive[0].tokenUsage.totalTokens, 15000);
  });

  it('onStepStart fires with correct context', async () => {
    await hm.register(createRecordingPlugin('p1', record));
    await hm.fireOnStepStart({
      runId: 'run-1', agentId: 'a1', stepNumber: 3,
      type: 'tool_call', content: 'file_read',
    });
    assert.strictEqual(record.onStepStart.length, 1);
    assert.strictEqual(record.onStepStart[0].stepNumber, 3);
    assert.strictEqual(record.onStepStart[0].type, 'tool_call');
  });

  it('onStepComplete fires with correct context', async () => {
    await hm.register(createRecordingPlugin('p1', record));
    await hm.fireOnStepComplete({
      runId: 'run-1', agentId: 'a1', stepNumber: 4,
      type: 'response', content: 'Done.',
    });
    assert.strictEqual(record.onStepComplete.length, 1);
    assert.strictEqual(record.onStepComplete[0].stepNumber, 4);
    assert.strictEqual(record.onStepComplete[0].type, 'response');
  });

  it('beforeBackendSelect fires with correct context', async () => {
    await hm.register(createRecordingPlugin('p1', record));
    const result = await hm.fireBeforeBackendSelect({
      toolName: 'shell_execute', args: { backend: 'ssh' },
      agentId: 'a1', runId: 'r1',
    });
    assert.strictEqual(result, null); // no override
    assert.strictEqual(record.beforeBackendSelect.length, 1);
    assert.strictEqual(record.beforeBackendSelect[0].toolName, 'shell_execute');
    assert.strictEqual(record.beforeBackendSelect[0].args.backend, 'ssh');
  });

  it('afterBackendSelect fires with correct context', async () => {
    await hm.register(createRecordingPlugin('p1', record));
    await hm.fireAfterBackendSelect({
      toolName: 'shell_execute', args: {}, selectedBackend: 'local',
      agentId: 'a1', runId: 'r1',
    });
    assert.strictEqual(record.afterBackendSelect.length, 1);
    assert.strictEqual(record.afterBackendSelect[0].selectedBackend, 'local');
  });
});

// ============================================================================
// Plugin ordering by dependency
// ============================================================================
describe('Hook plugin ordering', () => {
  let hm: HookManager;

  beforeEach(() => {
    hm = freshHookManager();
  });

  afterEach(async () => {
    for (const name of hm.listPlugins()) {
      await hm.unregister(name);
    }
  });

  it('fires hooks in dependency order', async () => {
    const order: string[] = [];

    await hm.register({
      name: 'base-plugin',
      beforeToolResolve: async () => { order.push('base'); return null; },
    });
    await hm.register({
      name: 'dependent-plugin',
      dependsOn: ['base-plugin'],
      beforeToolResolve: async () => { order.push('dependent'); return null; },
    });

    await hm.fireBeforeToolResolve({
      toolName: 'test', args: {}, agentId: 'a1', runId: 'r1',
    });

    assert.deepStrictEqual(order, ['base', 'dependent']);
  });
});

// ============================================================================
// beforeToolResolve can block a tool
// ============================================================================
describe('beforeToolResolve blocking', () => {
  let hm: HookManager;

  beforeEach(() => {
    hm = freshHookManager();
  });

  afterEach(async () => {
    for (const name of hm.listPlugins()) {
      await hm.unregister(name);
    }
  });

  it('plugin can block tool resolution by returning a ToolResult', async () => {
    await hm.register({
      name: 'blocker',
      beforeToolResolve: async () => ({
        success: false,
        output: 'Tool blocked by policy',
        error: 'BLOCKED',
        durationMs: 0,
        toolName: 'shell_execute',
      }),
    });

    const result = await hm.fireBeforeToolResolve({
      toolName: 'shell_execute', args: { command: 'rm -rf /' },
      agentId: 'a1', runId: 'r1',
    });

    assert.ok(result !== null);
    assert.strictEqual(result!.success, false);
    assert.strictEqual(result!.error, 'BLOCKED');
  });

  it('non-blocking plugin returns null and allows resolution', async () => {
    await hm.register({
      name: 'non-blocker',
      beforeToolResolve: async () => null,
    });

    const result = await hm.fireBeforeToolResolve({
      toolName: 'web_search', args: {}, agentId: 'a1', runId: 'r1',
    });

    assert.strictEqual(result, null);
  });
});

// ============================================================================
// Error isolation
// ============================================================================
describe('Hook error isolation', () => {
  let hm: HookManager;

  beforeEach(() => {
    hm = freshHookManager();
  });

  afterEach(async () => {
    for (const name of hm.listPlugins()) {
      await hm.unregister(name);
    }
  });

  it('failing plugin does not prevent subsequent plugins from firing', async () => {
    const fired: string[] = [];

    await hm.register({
      name: 'failing',
      beforeToolResolve: async () => { throw new Error('oops'); },
    });
    await hm.register({
      name: 'working',
      beforeToolResolve: async () => { fired.push('working'); return null; },
    });

    const result = await hm.fireBeforeToolResolve({
      toolName: 'test', args: {}, agentId: 'a1', runId: 'r1',
    });

    // 'working' should still fire and result should be null (no block)
    assert.strictEqual(result, null);
    assert.deepStrictEqual(fired, ['working']);
  });

  it('hook errors are caught and logged without propagating', async () => {
    await hm.register({
      name: 'throws',
      onStepStart: async () => { throw new Error('step error'); },
    });

    // Should not throw
    await hm.fireOnStepStart({
      runId: 'r1', agentId: 'a1', stepNumber: 1,
      type: 'thought',
    });

    // If we got here, error was isolated
    assert.ok(true);
  });

  it('plugin timeout does not crash the hook chain', async () => {
    hm.setHookTimeout(50); // 50ms timeout

    await hm.register({
      name: 'slow',
      beforeToolResolve: async () => {
        await new Promise(resolve => setTimeout(resolve, 5000));
        return 'should-not-reach' as any;
      },
    });
    await hm.register({
      name: 'fast',
      beforeToolResolve: async () => { return null; },
    });

    // Should not throw despite slow plugin timing out
    const result = await hm.fireBeforeToolResolve({
      toolName: 'test', args: {}, agentId: 'a1', runId: 'r1',
    });

    // fast plugin still fires and result is null
    assert.strictEqual(result, null);
  });
});

// ============================================================================
// Disabled plugin behavior
// ============================================================================
describe('Disabled plugin isolation', () => {
  let hm: HookManager;

  beforeEach(() => {
    hm = freshHookManager();
  });

  afterEach(async () => {
    for (const name of hm.listPlugins()) {
      await hm.unregister(name);
    }
  });

  it('disabled plugin hooks do not fire', async () => {
    const fired: string[] = [];

    await hm.register({
      name: 'disabled-p',
      beforeToolResolve: async () => { fired.push('disabled-p'); return null; },
    });

    hm.disable('disabled-p');
    await hm.fireBeforeToolResolve({
      toolName: 'test', args: {}, agentId: 'a1', runId: 'r1',
    });

    assert.deepStrictEqual(fired, []);
  });

  it('re-enabled plugin hooks fire again', async () => {
    const fired: string[] = [];

    await hm.register({
      name: 'toggle-p',
      beforeToolResolve: async () => { fired.push('toggle-p'); return null; },
    });

    hm.disable('toggle-p');
    await hm.fireBeforeToolResolve({
      toolName: 'test', args: {}, agentId: 'a1', runId: 'r1',
    });
    assert.deepStrictEqual(fired, []);

    hm.enable('toggle-p');
    await hm.fireBeforeToolResolve({
      toolName: 'test', args: {}, agentId: 'a1', runId: 'r1',
    });
    assert.deepStrictEqual(fired, ['toggle-p']);
  });
});

// ============================================================================
// Multiple plugin chains
// ============================================================================
describe('Multi-plugin hook chains', () => {
  let hm: HookManager;

  beforeEach(() => {
    hm = freshHookManager();
  });

  afterEach(async () => {
    for (const name of hm.listPlugins()) {
      await hm.unregister(name);
    }
  });

  it('all plugins receive onStepComplete in order', async () => {
    const fired: string[] = [];

    await hm.register({
      name: 'first',
      onStepComplete: async () => { fired.push('first'); },
    });
    await hm.register({
      name: 'second',
      onStepComplete: async () => { fired.push('second'); },
    });

    await hm.fireOnStepComplete({
      runId: 'r1', agentId: 'a1', stepNumber: 1,
      type: 'tool_result',
    });

    assert.deepStrictEqual(fired, ['first', 'second']);
  });

  it('all 12 hook types can be registered on a single plugin', async () => {
    const calls: string[] = [];

    const allHookPlugin: CommanderPlugin = {
      name: 'all-hooks',
      beforeToolResolve: async () => { calls.push('beforeToolResolve'); return null; },
      afterToolResolve: async () => { calls.push('afterToolResolve'); },
      onToolTimeout: async () => { calls.push('onToolTimeout'); },
      onToolRetry: async () => { calls.push('onToolRetry'); },
      beforeContextCompaction: async () => { calls.push('beforeContextCompaction'); },
      afterContextCompaction: async () => { calls.push('afterContextCompaction'); },
      onSessionFork: async () => { calls.push('onSessionFork'); },
      onSessionArchive: async () => { calls.push('onSessionArchive'); },
      onStepStart: async () => { calls.push('onStepStart'); },
      onStepComplete: async () => { calls.push('onStepComplete'); },
      beforeBackendSelect: async () => { calls.push('beforeBackendSelect'); return null; },
      afterBackendSelect: async () => { calls.push('afterBackendSelect'); },
    };

    await hm.register(allHookPlugin);

    await hm.fireBeforeToolResolve({ toolName: 't', args: {}, agentId: 'a', runId: 'r' });
    await hm.fireAfterToolResolve({ toolName: 't', args: {}, agentId: 'a', runId: 'r', notFound: false });
    await hm.fireOnToolTimeout({ toolName: 't', args: {}, timeoutMs: 1000, durationMs: 1100, agentId: 'a', runId: 'r' });
    await hm.fireOnToolRetry({ toolName: 't', args: {}, attempt: 1, maxRetries: 3, lastError: 'e', agentId: 'a', runId: 'r' });
    await hm.fireBeforeContextCompaction({ messageCount: 1, totalTokens: 100, budgetTokens: 200, agentId: 'a', runId: 'r' });
    await hm.fireAfterContextCompaction({ messageCount: 1, totalTokens: 100, budgetTokens: 200, agentId: 'a', runId: 'r' });
    await hm.fireOnSessionFork({ parentRunId: 'p', childRunId: 'c', agentId: 'a', goal: 'g' });
    await hm.fireOnSessionArchive({ runId: 'r', phase: 'p', stepNumber: 1, tokenUsage: { totalTokens: 100 } });
    await hm.fireOnStepStart({ runId: 'r', agentId: 'a', stepNumber: 1, type: 'thought' });
    await hm.fireOnStepComplete({ runId: 'r', agentId: 'a', stepNumber: 1, type: 'tool_result' });
    await hm.fireBeforeBackendSelect({ toolName: 't', args: {}, agentId: 'a', runId: 'r' });
    await hm.fireAfterBackendSelect({ toolName: 't', args: {}, selectedBackend: 'local', agentId: 'a', runId: 'r' });

    // 12 distinct hooks, each should fire exactly once
    assert.strictEqual(calls.length, 12);
    assert.ok(calls.includes('beforeToolResolve'));
    assert.ok(calls.includes('afterToolResolve'));
    assert.ok(calls.includes('onToolTimeout'));
    assert.ok(calls.includes('onToolRetry'));
    assert.ok(calls.includes('beforeContextCompaction'));
    assert.ok(calls.includes('afterContextCompaction'));
    assert.ok(calls.includes('onSessionFork'));
    assert.ok(calls.includes('onSessionArchive'));
    assert.ok(calls.includes('onStepStart'));
    assert.ok(calls.includes('onStepComplete'));
    assert.ok(calls.includes('beforeBackendSelect'));
    assert.ok(calls.includes('afterBackendSelect'));
  });
});

// ============================================================================
// beforeBackendSelect integration with ExecutionRouter
// ============================================================================
describe('beforeBackendSelect + ExecutionRouter', () => {
  let hm: HookManager;

  beforeEach(() => {
    hm = freshHookManager();
  });

  afterEach(async () => {
    for (const name of hm.listPlugins()) {
      await hm.unregister(name);
    }
  });

  it('hook can redirect to a named backend', async () => {
    const router = new ExecutionRouter();
    const recording = new (class implements import('../src/sandbox/types').ExecutionBackend {
      readonly type = 'local' as const;
      readonly available = true;
      async execute(cmd: string) {
        return { stdout: `custom: ${cmd}`, stderr: '', exitCode: 0, durationMs: 0, sandboxMechanism: 'none' as const };
      }
    })();
    router.registerBackend('custom-backend', recording);

    await hm.register({
      name: 'redirector',
      beforeBackendSelect: async (ctx) => {
        if (ctx.args.redirect_to_custom) return 'custom-backend';
        return null;
      },
    });

    // Without redirect flag → local
    const localBackend = await router.selectBackend({ _toolName: 'shell_execute' });
    assert.strictEqual(localBackend.type, 'local');

    // With redirect flag → custom-backend
    const customBackend = await router.selectBackend({ _toolName: 'shell_execute', redirect_to_custom: true });
    assert.strictEqual(customBackend, recording);
  });
});

// ============================================================================
// resetHookManager
// ============================================================================
describe('resetHookManager', () => {
  it('clears all registered plugins', async () => {
    const hm = freshHookManager();
    await hm.register({ name: 'temp', beforeToolResolve: async () => null });
    assert.strictEqual(hm.listPlugins().length, 1);

    resetHookManager();
    const newHm = getHookManager();
    assert.strictEqual(newHm.listPlugins().length, 0);
  });
});
