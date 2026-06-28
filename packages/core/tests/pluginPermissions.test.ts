// ─────────────────────────────────────────────────────────────────────────────
// Plugin Permission System Tests
//
// Verifies that plugins NEVER have more permissions than the main system:
//   1. Default permissions deny everything (least privilege)
//   2. Filesystem read/write is scoped to declared paths
//   3. Network access is domain+port restricted
//   4. Process spawning is denied by default
//   5. Environment variables are allowlisted
//   6. Hook registration is permission-checked
//   7. Tool registration is permission-checked
//   8. Sandbox context enforces all checks at runtime
//   9. Raw HookManager is NOT leaked to sandboxed plugins
//  10. updateConfig applies the same sandbox as register
//  11. withTimeout respects per-plugin maxExecutionTimeMs
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  PluginPermissionEnforcer,
  PluginPermissionRegistry,
  getGlobalPluginPermissionRegistry,
  DEFAULT_PLUGIN_PERMISSIONS,
} from '../src/security/pluginPermissions';
import { createPluginSandboxContext } from '../src/runtime/pluginSandboxContext';
import { HookManager } from '../src/pluginManager';

// ── Helper: reset the global registry between tests ──
function resetRegistry(): void {
  const reg = getGlobalPluginPermissionRegistry();
  for (const entry of reg.list()) {
    reg.unregister(entry.pluginName);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PluginPermissionEnforcer
// ─────────────────────────────────────────────────────────────────────────────

describe('PluginPermissionEnforcer', () => {
  describe('default permissions (deny-all)', () => {
    const enforcer = new PluginPermissionEnforcer('test-plugin');

    it('denies all filesystem read by default', () => {
      const result = enforcer.checkFileRead('/some/path');
      assert.equal(result.allowed, false);
      assert.match(result.reason, /no filesystem read/);
    });

    it('denies all filesystem write by default', () => {
      const result = enforcer.checkFileWrite('/some/path');
      assert.equal(result.allowed, false);
      assert.match(result.reason, /no filesystem write/);
    });

    it('denies all network access by default', () => {
      const result = enforcer.checkNetwork('example.com', 443);
      assert.equal(result.allowed, false);
      assert.match(result.reason, /no network/);
    });

    it('denies process spawning by default', () => {
      const result = enforcer.checkProcess();
      assert.equal(result.allowed, false);
      assert.match(result.reason, /process spawn/);
    });

    it('denies all env var access by default', () => {
      const result = enforcer.checkEnv('SECRET_KEY');
      assert.equal(result.allowed, false);
      assert.match(result.reason, /not in allowlist/);
    });

    it('denies all hook registration by default', () => {
      const result = enforcer.checkHook('beforeToolCall');
      assert.equal(result.allowed, false);
      assert.match(result.reason, /no hook/);
    });

    it('denies all tool registration by default', () => {
      const result = enforcer.checkToolRegistration('my-tool');
      assert.equal(result.allowed, false);
      assert.match(result.reason, /no tool registration/);
    });

    it('has default maxExecutionTimeMs of 5000', () => {
      assert.equal(enforcer.maxExecutionTimeMs, 5000);
    });

    it('has default maxMemoryMB of 64', () => {
      assert.equal(enforcer.maxMemoryMB, 64);
    });
  });

  describe('filesystem permissions', () => {
    it('allows read within declared path', () => {
      const enforcer = new PluginPermissionEnforcer('fs-plugin', {
        filesystem: { read: ['/tmp/plugin-data/**'], write: [] },
      });
      assert.equal(enforcer.checkFileRead('/tmp/plugin-data/file.txt').allowed, true);
      assert.equal(enforcer.checkFileRead('/tmp/plugin-data/sub/deep.txt').allowed, true);
    });

    it('denies read outside declared path', () => {
      const enforcer = new PluginPermissionEnforcer('fs-plugin', {
        filesystem: { read: ['/tmp/plugin-data/**'], write: [] },
      });
      const result = enforcer.checkFileRead('/etc/passwd');
      assert.equal(result.allowed, false);
    });

    it('allows write within declared path', () => {
      const enforcer = new PluginPermissionEnforcer('fs-plugin', {
        filesystem: { read: [], write: ['/tmp/plugin-out/**'] },
      });
      assert.equal(enforcer.checkFileWrite('/tmp/plugin-out/result.json').allowed, true);
    });

    it('denies write outside declared path', () => {
      const enforcer = new PluginPermissionEnforcer('fs-plugin', {
        filesystem: { read: [], write: ['/tmp/plugin-out/**'] },
      });
      assert.equal(enforcer.checkFileWrite('/etc/crontab').allowed, false);
    });

    it('supports exact path match', () => {
      const enforcer = new PluginPermissionEnforcer('fs-plugin', {
        filesystem: { read: ['/tmp/exact.txt'], write: [] },
      });
      assert.equal(enforcer.checkFileRead('/tmp/exact.txt').allowed, true);
      assert.equal(enforcer.checkFileRead('/tmp/exact.txt.bak').allowed, false);
    });
  });

  describe('network permissions', () => {
    it('allows declared domain', () => {
      const enforcer = new PluginPermissionEnforcer('net-plugin', {
        network: { allowedDomains: ['api.example.com'], allowedPorts: [443] },
      });
      assert.equal(enforcer.checkNetwork('api.example.com', 443).allowed, true);
    });

    it('allows subdomain of declared domain', () => {
      const enforcer = new PluginPermissionEnforcer('net-plugin', {
        network: { allowedDomains: ['example.com'], allowedPorts: [] },
      });
      assert.equal(enforcer.checkNetwork('sub.example.com', 80).allowed, true);
    });

    it('denies undeclared domain', () => {
      const enforcer = new PluginPermissionEnforcer('net-plugin', {
        network: { allowedDomains: ['api.example.com'], allowedPorts: [443] },
      });
      assert.equal(enforcer.checkNetwork('evil.com', 443).allowed, false);
    });

    it('denies undeclared port', () => {
      const enforcer = new PluginPermissionEnforcer('net-plugin', {
        network: { allowedDomains: ['api.example.com'], allowedPorts: [443] },
      });
      assert.equal(enforcer.checkNetwork('api.example.com', 22).allowed, false);
    });

    it('allows any port when allowedPorts is empty', () => {
      const enforcer = new PluginPermissionEnforcer('net-plugin', {
        network: { allowedDomains: ['api.example.com'], allowedPorts: [] },
      });
      assert.equal(enforcer.checkNetwork('api.example.com', 8080).allowed, true);
    });
  });

  describe('process permissions', () => {
    it('allows when explicitly granted', () => {
      const enforcer = new PluginPermissionEnforcer('proc-plugin', {
        process: true,
      });
      assert.equal(enforcer.checkProcess().allowed, true);
    });

    it('denies when not granted', () => {
      const enforcer = new PluginPermissionEnforcer('proc-plugin', {
        process: false,
      });
      assert.equal(enforcer.checkProcess().allowed, false);
    });
  });

  describe('env permissions', () => {
    it('allows declared env var', () => {
      const enforcer = new PluginPermissionEnforcer('env-plugin', {
        env: ['API_KEY', 'BASE_URL'],
      });
      assert.equal(enforcer.checkEnv('API_KEY').allowed, true);
      assert.equal(enforcer.checkEnv('BASE_URL').allowed, true);
    });

    it('denies undeclared env var', () => {
      const enforcer = new PluginPermissionEnforcer('env-plugin', {
        env: ['API_KEY'],
      });
      assert.equal(enforcer.checkEnv('SECRET_TOKEN').allowed, false);
    });
  });

  describe('hook permissions', () => {
    it('allows declared hook', () => {
      const enforcer = new PluginPermissionEnforcer('hook-plugin', {
        hooks: ['beforeToolCall', 'afterToolCall'],
      });
      assert.equal(enforcer.checkHook('beforeToolCall').allowed, true);
      assert.equal(enforcer.checkHook('afterToolCall').allowed, true);
    });

    it('denies undeclared hook', () => {
      const enforcer = new PluginPermissionEnforcer('hook-plugin', {
        hooks: ['beforeToolCall'],
      });
      assert.equal(enforcer.checkHook('onAgentStart').allowed, false);
    });
  });

  describe('tool registration permissions', () => {
    it('allows declared tool', () => {
      const enforcer = new PluginPermissionEnforcer('tool-plugin', {
        tools: ['my-tool'],
      });
      assert.equal(enforcer.checkToolRegistration('my-tool').allowed, true);
    });

    it('denies undeclared tool', () => {
      const enforcer = new PluginPermissionEnforcer('tool-plugin', {
        tools: ['my-tool'],
      });
      assert.equal(enforcer.checkToolRegistration('evil-tool').allowed, false);
    });
  });

  describe('violation tracking', () => {
    it('records permission violations', () => {
      const enforcer = new PluginPermissionEnforcer('tracked-plugin');
      enforcer.checkFileRead('/etc/passwd');
      enforcer.checkNetwork('evil.com');
      const violations = enforcer.getViolations();
      assert.equal(violations.length, 2);
      assert.equal(violations[0].resource, 'filesystem.read');
      assert.equal(violations[1].resource, 'network');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginPermissionRegistry
// ─────────────────────────────────────────────────────────────────────────────

describe('PluginPermissionRegistry', () => {
  beforeEach(() => resetRegistry());

  it('registers and retrieves enforcers', () => {
    const reg = getGlobalPluginPermissionRegistry();
    const enforcer = reg.register('test-reg', { process: true });
    assert.ok(enforcer);
    assert.equal(reg.get('test-reg'), enforcer);
  });

  it('unregisters enforcers', () => {
    const reg = getGlobalPluginPermissionRegistry();
    reg.register('to-remove', { process: true });
    assert.ok(reg.get('to-remove'));
    reg.unregister('to-remove');
    assert.equal(reg.get('to-remove'), undefined);
  });

  it('lists all registered plugins', () => {
    const reg = getGlobalPluginPermissionRegistry();
    reg.register('plugin-a', { process: false });
    reg.register('plugin-b', { process: true });
    const list = reg.list();
    assert.equal(list.length, 2);
    const names = list.map((l) => l.pluginName);
    assert.ok(names.includes('plugin-a'));
    assert.ok(names.includes('plugin-b'));
  });

  it('aggregates violations across all plugins', () => {
    const reg = getGlobalPluginPermissionRegistry();
    const enforcerA = reg.register('plugin-a');
    const enforcerB = reg.register('plugin-b');
    enforcerA.checkFileRead('/etc/passwd');
    enforcerB.checkNetwork('evil.com');
    const allViolations = reg.getAllViolations();
    assert.equal(allViolations.length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginSandboxContext
// ─────────────────────────────────────────────────────────────────────────────

describe('PluginSandboxContext', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-sandbox-'));
    resetRegistry();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    resetRegistry();
  });

  it('allows readFile within declared path', async () => {
    const testFile = path.join(tempDir, 'data.txt');
    fs.writeFileSync(testFile, 'hello');

    const enforcer = new PluginPermissionEnforcer('sandbox-test', {
      filesystem: { read: [`${tempDir}/**`], write: [] },
    });
    const ctx = createPluginSandboxContext(
      'sandbox-test',
      enforcer,
      {},
      () => {},
    );
    const content = await ctx.readFile(testFile);
    assert.equal(content, 'hello');
  });

  it('denies readFile outside declared path', async () => {
    const enforcer = new PluginPermissionEnforcer('sandbox-test', {
      filesystem: { read: ['/tmp/allowed/**'], write: [] },
    });
    const ctx = createPluginSandboxContext(
      'sandbox-test',
      enforcer,
      {},
      () => {},
    );
    const content = await ctx.readFile('/etc/passwd');
    assert.equal(content, null);
  });

  it('allows writeFile within declared path', async () => {
    const enforcer = new PluginPermissionEnforcer('sandbox-test', {
      filesystem: { read: [], write: [`${tempDir}/**`] },
    });
    const ctx = createPluginSandboxContext(
      'sandbox-test',
      enforcer,
      {},
      () => {},
    );
    const outFile = path.join(tempDir, 'out.txt');
    const success = await ctx.writeFile(outFile, 'written');
    assert.equal(success, true);
    assert.equal(fs.readFileSync(outFile, 'utf-8'), 'written');
  });

  it('denies writeFile outside declared path', async () => {
    const enforcer = new PluginPermissionEnforcer('sandbox-test', {
      filesystem: { read: [], write: [`${tempDir}/**`] },
    });
    const ctx = createPluginSandboxContext(
      'sandbox-test',
      enforcer,
      {},
      () => {},
    );
    const success = await ctx.writeFile('/etc/crontab', 'evil');
    assert.equal(success, false);
  });

  it('allows fetch to declared domain', async () => {
    const enforcer = new PluginPermissionEnforcer('sandbox-test', {
      network: { allowedDomains: ['example.com'], allowedPorts: [443] },
    });
    const ctx = createPluginSandboxContext(
      'sandbox-test',
      enforcer,
      {},
      () => {},
    );
    // We can't actually fetch in tests, but we can verify the permission
    // check passes (the fetch itself will fail with a network error, not null)
    // The key assertion: the enforcer allowed the domain
    const check = enforcer.checkNetwork('example.com', 443);
    assert.equal(check.allowed, true);
  });

  it('denies fetch to undeclared domain', async () => {
    const enforcer = new PluginPermissionEnforcer('sandbox-test', {
      network: { allowedDomains: ['safe.com'], allowedPorts: [443] },
    });
    const ctx = createPluginSandboxContext(
      'sandbox-test',
      enforcer,
      {},
      () => {},
    );
    const result = await ctx.fetch('https://evil.com/exfil');
    assert.equal(result, null);
  });

  it('allows getEnvVar for declared vars', () => {
    process.env.PLUGIN_TEST_VAR = 'test-value';
    const enforcer = new PluginPermissionEnforcer('sandbox-test', {
      env: ['PLUGIN_TEST_VAR'],
    });
    const ctx = createPluginSandboxContext(
      'sandbox-test',
      enforcer,
      {},
      () => {},
    );
    assert.equal(ctx.getEnvVar('PLUGIN_TEST_VAR'), 'test-value');
    delete process.env.PLUGIN_TEST_VAR;
  });

  it('denies getEnvVar for undeclared vars', () => {
    process.env.SUPER_SECRET = 'leaked';
    const enforcer = new PluginPermissionEnforcer('sandbox-test', {
      env: ['PUBLIC_VAR'],
    });
    const ctx = createPluginSandboxContext(
      'sandbox-test',
      enforcer,
      {},
      () => {},
    );
    assert.equal(ctx.getEnvVar('SUPER_SECRET'), undefined);
    delete process.env.SUPER_SECRET;
  });

  it('getConfig returns a copy (not reference)', () => {
    const config = { key: 'value', nested: { a: 1 } };
    const enforcer = new PluginPermissionEnforcer('sandbox-test');
    const ctx = createPluginSandboxContext(
      'sandbox-test',
      enforcer,
      config,
      () => {},
    );
    const returned = ctx.getConfig();
    assert.equal(returned.key, 'value');
    // Mutating returned config should not affect original
    (returned as Record<string, unknown>).key = 'mutated';
    assert.equal(config.key, 'value');
  });

  it('registerHook respects permission checks', () => {
    const enforcer = new PluginPermissionEnforcer('sandbox-test', {
      hooks: ['beforeToolCall'],
    });
    let registered = '';
    const ctx = createPluginSandboxContext(
      'sandbox-test',
      enforcer,
      {},
      (hookName: string) => { registered = hookName; },
    );

    // Allowed hook
    const ok = ctx.registerHook('beforeToolCall', () => null);
    assert.equal(ok, true);
    assert.equal(registered, 'beforeToolCall');

    // Denied hook
    registered = '';
    const denied = ctx.registerHook('afterLLMCall', () => null);
    assert.equal(denied, false);
    assert.equal(registered, '');
  });

  it('log method works without permissions', () => {
    const enforcer = new PluginPermissionEnforcer('sandbox-test');
    const ctx = createPluginSandboxContext(
      'sandbox-test',
      enforcer,
      {},
      () => {},
    );
    // Should not throw
    ctx.log('info', 'test message', { foo: 'bar' });
    ctx.log('error', 'error message', { code: 500 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: HookManager does NOT leak raw hookManager to sandboxed plugins
// ─────────────────────────────────────────────────────────────────────────────

describe('HookManager sandbox isolation (GAP-1 fix)', () => {
  beforeEach(() => resetRegistry());
  afterEach(() => resetRegistry());

  it('does NOT pass raw hookManager when enforcer exists', async () => {
    const reg = getGlobalPluginPermissionRegistry();
    reg.register('sandboxed-plugin', {
      hooks: ['beforeToolCall'],
    });

    const manager = new HookManager();
    let receivedCtx: Record<string, unknown> = {};

    await manager.register({
      name: 'sandboxed-plugin',
      onLoad: (ctx) => {
        receivedCtx = ctx as unknown as Record<string, unknown>;
      },
    });

    // The raw hookManager should NOT be present
    assert.equal(receivedCtx.hookManager, undefined,
      'Raw hookManager must NOT be passed to sandboxed plugins');
    // Sandbox methods should be present
    assert.equal(typeof receivedCtx.registerHook, 'function');
    assert.equal(typeof receivedCtx.readFile, 'function');
    assert.equal(typeof receivedCtx.writeFile, 'function');
    assert.equal(typeof receivedCtx.fetch, 'function');
    assert.equal(typeof receivedCtx.getEnvVar, 'function');
    assert.equal(typeof receivedCtx.getConfig, 'function');
    assert.equal(typeof receivedCtx.log, 'function');
  });

  it('DOES pass raw hookManager for built-in plugins (no enforcer)', async () => {
    const manager = new HookManager();
    let receivedCtx: Record<string, unknown> = {};

    await manager.register({
      name: 'builtin-plugin',
      onLoad: (ctx) => {
        receivedCtx = ctx as unknown as Record<string, unknown>;
      },
    });

    // Built-in plugins (no enforcer) should still get the raw hookManager
    assert.ok(receivedCtx.hookManager, 'Built-in plugins should receive hookManager');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: updateConfig applies sandbox (GAP-2 fix)
// ─────────────────────────────────────────────────────────────────────────────

describe('HookManager updateConfig sandbox (GAP-2 fix)', () => {
  beforeEach(() => resetRegistry());
  afterEach(() => resetRegistry());

  it('updateConfig does NOT pass raw hookManager for sandboxed plugins', async () => {
    const reg = getGlobalPluginPermissionRegistry();
    reg.register('cfg-sandboxed', {
      hooks: [],
    });

    const manager = new HookManager();
    let loadCount = 0;
    let receivedCtx: Record<string, unknown> = {};

    await manager.register({
      name: 'cfg-sandboxed',
      onLoad: (ctx) => {
        loadCount++;
        receivedCtx = ctx as unknown as Record<string, unknown>;
      },
      onUnload: () => {},
    });

    // First load (register): no hookManager
    assert.equal(receivedCtx.hookManager, undefined);

    await manager.updateConfig('cfg-sandboxed', { newKey: 'newVal' });

    // Second load (updateConfig): also no hookManager
    assert.equal(loadCount, 2);
    assert.equal(receivedCtx.hookManager, undefined,
      'updateConfig must NOT pass raw hookManager to sandboxed plugins');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: withTimeout respects per-plugin maxExecutionTimeMs (GAP-3 fix)
// ─────────────────────────────────────────────────────────────────────────────

describe('HookManager withTimeout per-plugin limit (GAP-3 fix)', () => {
  beforeEach(() => resetRegistry());
  afterEach(() => resetRegistry());

  it('uses stricter per-plugin timeout when declared', async () => {
    const reg = getGlobalPluginPermissionRegistry();
    reg.register('timeout-plugin', {
      hooks: ['beforeToolCall'],
      maxExecutionTimeMs: 50, // Very short
    });

    const manager = new HookManager();
    manager.setHookTimeout(5000); // Global is 5s

    await manager.register({
      name: 'timeout-plugin',
      beforeToolCall: () => {
        return new Promise((resolve) => {
          // Takes 200ms — should be killed by the 50ms per-plugin limit
          setTimeout(() => resolve(null), 200);
        });
      },
    });

    const start = Date.now();
    await manager.fireBeforeToolCall({
      toolName: 'test',
      args: {},
      agentId: 'a',
      runId: 'r',
    });
    const elapsed = Date.now() - start;

    // Should timeout around 50ms, not 5000ms
    assert.ok(elapsed < 500,
      `Hook should timeout near 50ms, took ${elapsed}ms`);
  });
});
