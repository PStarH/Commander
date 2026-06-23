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
    const result = await allowed.execute('echo hello-fail-closed-test');
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('hello-fail-closed-test'));
  });
});
