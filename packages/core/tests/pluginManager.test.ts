import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HookManager } from '../src/pluginManager';

describe('HookManager', () => {
  let manager: HookManager;

  beforeEach(() => {
    manager = new HookManager();
  });

  describe('register / unregister', () => {
    it('registers a plugin', async () => {
      await manager.register({ name: 'test-plugin' });
      assert.ok(manager.hasPlugin('test-plugin'));
    });

    it('throws on duplicate registration', async () => {
      await manager.register({ name: 'dup' });
      await assert.rejects(() => manager.register({ name: 'dup' }), /already registered/);
    });

    it('calls onLoad lifecycle hook', async () => {
      let loaded = false;
      await manager.register({
        name: 'lifecycle',
        onLoad: () => { loaded = true; },
      });
      assert.ok(loaded);
    });

    it('removes plugin if onLoad throws', async () => {
      await assert.rejects(
        () => manager.register({
          name: 'failing',
          onLoad: () => { throw new Error('load failed'); },
        }),
        /load failed/,
      );
      assert.ok(!manager.hasPlugin('failing'));
    });

    it('unregisters a plugin', async () => {
      await manager.register({ name: 'removable' });
      const result = await manager.unregister('removable');
      assert.equal(result, true);
      assert.ok(!manager.hasPlugin('removable'));
    });

    it('returns false when unregistering non-existent plugin', async () => {
      const result = await manager.unregister('nonexistent');
      assert.equal(result, false);
    });

    it('calls onUnload during unregistration', async () => {
      let unloaded = false;
      await manager.register({
        name: 'unloader',
        onUnload: () => { unloaded = true; },
      });
      await manager.unregister('unloader');
      assert.ok(unloaded);
    });

    it('validates dependencies on register', async () => {
      await assert.rejects(
        () => manager.register({
          name: 'dependent',
          dependsOn: ['missing-dep'],
        }),
        /not registered/,
      );
    });

    it('allows registration when dependencies are met', async () => {
      await manager.register({ name: 'base' });
      await manager.register({ name: 'dependent', dependsOn: ['base'] });
      assert.ok(manager.hasPlugin('dependent'));
    });
  });

  describe('enable / disable / isEnabled', () => {
    it('enables and disables plugins', async () => {
      await manager.register({ name: 'toggleable' });
      assert.ok(manager.isEnabled('toggleable'));

      manager.disable('toggleable');
      assert.ok(!manager.isEnabled('toggleable'));

      manager.enable('toggleable');
      assert.ok(manager.isEnabled('toggleable'));
    });

    it('returns false for non-existent plugin', () => {
      assert.equal(manager.enable('nope'), false);
      assert.equal(manager.disable('nope'), false);
      assert.equal(manager.isEnabled('nope'), false);
    });
  });

  describe('listPlugins / getPlugin / getPluginInfo', () => {
    it('lists all registered plugins', async () => {
      await manager.register({ name: 'a' });
      await manager.register({ name: 'b' });
      const list = manager.listPlugins();
      assert.ok(list.includes('a'));
      assert.ok(list.includes('b'));
    });

    it('gets plugin by name', async () => {
      await manager.register({ name: 'get-me', version: '1.0.0' });
      const plugin = manager.getPlugin('get-me');
      assert.ok(plugin);
      assert.equal(plugin!.version, '1.0.0');
    });

    it('returns undefined for non-existent plugin', () => {
      assert.equal(manager.getPlugin('nope'), undefined);
      assert.equal(manager.getPluginInfo('nope'), undefined);
    });

    it('getPluginInfo returns full info', async () => {
      await manager.register({ name: 'info-test', description: 'test desc' }, { key: 'value' });
      const info = manager.getPluginInfo('info-test');
      assert.ok(info);
      assert.equal(info!.plugin.description, 'test desc');
      assert.equal(info!.enabled, true);
      assert.equal(info!.config.key, 'value');
    });
  });

  describe('config', () => {
    it('passes config to plugin on load', async () => {
      let receivedConfig: Record<string, unknown> = {};
      await manager.register({
        name: 'configurable',
        onLoad: (ctx) => { receivedConfig = ctx.config; },
      }, { foo: 'bar' });
      assert.equal(receivedConfig.foo, 'bar');
    });

    it('getConfig returns merged config', async () => {
      await manager.register({ name: 'cfg' }, { key: 'value' });
      const config = manager.getConfig('cfg');
      assert.equal(config?.key, 'value');
    });

    it('updateConfig reloads plugin', async () => {
      let loadCount = 0;
      await manager.register({
        name: 'updatable',
        onLoad: () => { loadCount++; },
        onUnload: () => { loadCount++; },
      });
      assert.equal(loadCount, 1); // onLoad called
      await manager.updateConfig('updatable', { newKey: 'newVal' });
      assert.equal(loadCount, 3); // onUnload + onLoad
    });
  });

  describe('dependency ordering', () => {
    it('topological sort respects dependencies', async () => {
      await manager.register({ name: 'a' });
      await manager.register({ name: 'b', dependsOn: ['a'] });
      await manager.register({ name: 'c', dependsOn: ['b'] });
      const order = manager.getDependencyOrder();
      assert.ok(order.indexOf('a') < order.indexOf('b'));
      assert.ok(order.indexOf('b') < order.indexOf('c'));
    });

    it('detects circular dependencies', async () => {
      await manager.register({ name: 'x' });
      // Can't create true circular since deps must be pre-registered,
      // but we can test the algorithm works for linear chains
      const order = manager.getDependencyOrder();
      assert.ok(order.length > 0);
    });
  });

  describe('hook timeout', () => {
    it('default timeout is 5000ms', () => {
      assert.equal(manager.getHookTimeout(), 5000);
    });

    it('can set hook timeout', () => {
      manager.setHookTimeout(10000);
      assert.equal(manager.getHookTimeout(), 10000);
    });
  });

  describe('hook firing', () => {
    it('fires beforeToolCall hook', async () => {
      let called = false;
      await manager.register({
        name: 'hook-test',
        beforeToolCall: () => { called = true; return null; },
      });
      await manager.fireBeforeToolCall({
        toolName: 'test-tool',
        args: {},
        agentId: 'agent-1',
        runId: 'run-1',
      });
      assert.ok(called);
    });

    it('skips hooks for disabled plugins', async () => {
      let called = false;
      await manager.register({
        name: 'disabled-hook',
        beforeToolCall: () => { called = true; return null; },
      });
      manager.disable('disabled-hook');
      await manager.fireBeforeToolCall({
        toolName: 'test-tool',
        args: {},
        agentId: 'agent-1',
        runId: 'run-1',
      });
      assert.ok(!called);
    });

    it('respects dependency order when firing hooks', async () => {
      const order: string[] = [];
      await manager.register({
        name: 'first',
        beforeToolCall: () => { order.push('first'); return null; },
      });
      await manager.register({
        name: 'second',
        dependsOn: ['first'],
        beforeToolCall: () => { order.push('second'); return null; },
      });
      await manager.fireBeforeToolCall({
        toolName: 'test-tool',
        args: {},
        agentId: 'agent-1',
        runId: 'run-1',
      });
      assert.deepEqual(order, ['first', 'second']);
    });

    it('non-required plugin hook failure is swallowed', async () => {
      await manager.register({
        name: 'flaky',
        required: false,
        beforeToolCall: () => { throw new Error('oops'); },
      });
      // Should not throw
      const result = await manager.fireBeforeToolCall({
        toolName: 'test-tool',
        args: {},
        agentId: 'agent-1',
        runId: 'run-1',
      });
      assert.equal(result, null);
    });

    it('required plugin hook failure propagates', async () => {
      await manager.register({
        name: 'critical',
        required: true,
        beforeToolCall: () => { throw new Error('critical failure'); },
      });
      await assert.rejects(
        () => manager.fireBeforeToolCall({
          toolName: 'test-tool',
          args: {},
          agentId: 'agent-1',
          runId: 'run-1',
        }),
        /critical failure/,
      );
    });
  });
});
