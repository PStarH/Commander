import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SandboxPolicyError,
  assertProductionSandboxPolicy,
  assertProductionSandboxReady,
  resolveSandboxPolicy,
} from '../../src/sandbox/productionPolicy';

describe('production sandbox policy', () => {
  it('defaults production to Docker', () => {
    const policy = resolveSandboxPolicy({ NODE_ENV: 'production' });
    assert.equal(policy.environment, 'production');
    assert.equal(policy.isolation, 'docker');
    assert.equal(policy.failClosed, true);
  });

  it('defaults development to the process isolation tier', () => {
    assert.equal(resolveSandboxPolicy({ NODE_ENV: 'development' }).isolation, 'process');
  });

  it('requires gVisor when explicitly selected', () => {
    const policy = resolveSandboxPolicy({
      NODE_ENV: 'production',
      COMMANDER_SANDBOX_ISOLATION: 'gvisor',
    });

    assert.throws(
      () => assertProductionSandboxReady({ policy, availableMechanisms: ['docker'] }),
      /gvisor/,
    );
  });

  it('rejects process isolation in production', () => {
    assert.throws(
      () =>
        resolveSandboxPolicy({ NODE_ENV: 'production', COMMANDER_SANDBOX_ISOLATION: 'process' }),
      SandboxPolicyError,
    );
  });

  for (const value of ['1', 'true', 'yes']) {
    it(`rejects COMMANDER_ALLOW_NO_SANDBOX=${value} in production`, () => {
      assert.throws(
        () => resolveSandboxPolicy({ NODE_ENV: 'production', COMMANDER_ALLOW_NO_SANDBOX: value }),
        /ALLOW_NO_SANDBOX/,
      );
    });
  }

  it('rejects unchecked execution bypass in production', () => {
    assert.throws(
      () =>
        resolveSandboxPolicy({ NODE_ENV: 'production', COMMANDER_ALLOW_UNCHECKED_EXEC: 'true' }),
      /ALLOW_UNCHECKED_EXEC/,
    );
  });

  it('requires the required plugin sandbox mode in production', () => {
    assert.throws(
      () =>
        resolveSandboxPolicy({ NODE_ENV: 'production', COMMANDER_PLUGIN_SANDBOX: 'in_process' }),
      /PLUGIN_SANDBOX/,
    );
  });

  it('rejects the plugin soft fallback in production', () => {
    assert.throws(
      () => resolveSandboxPolicy({ NODE_ENV: 'production', COMMANDER_PLUGIN_SANDBOX_SOFT: '1' }),
      /PLUGIN_SANDBOX_SOFT/,
    );
  });

  it('rejects a production policy with no selected backend', () => {
    const policy = resolveSandboxPolicy({ NODE_ENV: 'production' });
    assert.throws(
      () => assertProductionSandboxReady({ policy, availableMechanisms: [] }),
      /docker/,
    );
  });

  it('accepts a production Docker policy when Docker is available', () => {
    const policy = resolveSandboxPolicy({ NODE_ENV: 'production' });
    assert.doesNotThrow(() => assertProductionSandboxPolicy(policy));
    assert.doesNotThrow(() =>
      assertProductionSandboxReady({ policy, availableMechanisms: ['docker'] }),
    );
  });
});
