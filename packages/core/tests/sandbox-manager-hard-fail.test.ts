import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SandboxManager, SandboxInitializationError } from '../src/sandbox/manager';
import { NoopSB } from '../src/sandbox/platforms';

describe('SandboxManager hard-fail behavior', () => {
  it('constructor throws when no safe backend is available and fallback is disabled', () => {
    assert.throws(
      () => new SandboxManager({ sandboxes: [], allowNoSandbox: false }),
      SandboxInitializationError,
    );
  });

  it('constructor allows noop fallback when explicitly allowed', () => {
    const manager = new SandboxManager({ sandboxes: [], allowNoSandbox: true });
    assert.strictEqual(manager.hasSandbox(), false);
    const sandbox = manager.getSandbox();
    assert.strictEqual(sandbox.name, 'none');
  });

  it('getSandbox throws when requested mechanism is unavailable', () => {
    const manager = new SandboxManager({ sandboxes: [new NoopSB()], allowNoSandbox: true });
    assert.throws(() => manager.getSandbox('gvisor' as never), SandboxInitializationError);
  });

  it('execute uses noop fallback only when explicitly allowed', async () => {
    const allowed = new SandboxManager({ sandboxes: [], allowNoSandbox: true });
    // G7: NoopSB now refuses non-full network profiles.
    // Use 'full-access' to explicitly accept unsandboxed execution.
    const result = await allowed.execute('echo hello-fail-closed-test', 'full-access');
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('hello-fail-closed-test'));
  });

  it('NoopSB refuses to execute with non-full network policy (G7)', async () => {
    const allowed = new SandboxManager({ sandboxes: [], allowNoSandbox: true });
    // Default profile is 'workspace-write' with network: 'blocked' — NoopSB must refuse
    const result = await allowed.execute('echo should-be-blocked');
    assert.strictEqual(result.exitCode, 126);
    assert.ok(result.violated?.includes('network_policy_not_enforceable'));
  });
});
