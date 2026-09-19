import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  SandboxPolicyError,
  assertProductionSandboxPolicy,
  assertProductionSandboxReady,
  assertProductionSandboxSource,
  resolveSandboxPolicy,
} from '../../src/sandbox/productionPolicy';

/** Minimal fixture tree for assertProductionSandboxSource. */
function writeSandboxSourceFixture(root: string, options: { executionRouterBody: string }): void {
  const files: Record<string, string> = {
    'packages/core/src/sandbox/productionPolicy.ts':
      'export function assertProductionSandboxReady() {}\n',
    'packages/core/src/sandbox/manager.ts': 'export {}\n',
    'packages/core/src/sandbox/executionRouter.ts': options.executionRouterBody,
    'packages/core/src/sandbox/platforms.ts': 'export {}\n',
    'packages/core/src/sandbox/backends/localBackend.ts': 'export {}\n',
    'packages/core/src/sandbox/backends/sshBackend.ts': 'export class SSHBackend {}\n',
    'packages/core/src/plugins/pluginSandbox.ts': 'export {}\n',
    'packages/core/src/runtime/toolExecutionService.ts': 'export {}\n',
    'packages/core/src/tools/codeExecutionTool.ts': 'export {}\n',
  };
  for (const [relative, body] of Object.entries(files)) {
    const abs = join(root, relative);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
}

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

  // Regression: COMMANDER_ENV / enterprise-profile deployments declare
  // production without setting NODE_ENV. Before the fix the sandbox policy
  // stayed in the development tier (process isolation, soft plugin mode,
  // failClosed=false) for those deployments.
  for (const declared of [
    { COMMANDER_ENV: 'production' },
    { COMMANDER_ENV: 'prod' },
    { NODE_ENV: 'development', COMMANDER_ENV: 'production' },
    { COMMANDER_PROFILE: 'enterprise' },
    { COMMANDER_CELL_TIER: 'enterprise' },
  ]) {
    it(`treats ${JSON.stringify(declared)} as production`, () => {
      const policy = resolveSandboxPolicy(declared);
      assert.equal(policy.environment, 'production');
      assert.equal(policy.isolation, 'docker');
      assert.equal(policy.failClosed, true);
      assert.equal(policy.pluginSandboxMode, 'required');
    });
  }

  it('applies the production bans to a COMMANDER_ENV=production deployment', () => {
    assert.throws(
      () => resolveSandboxPolicy({ COMMANDER_ENV: 'production', COMMANDER_ALLOW_NO_SANDBOX: '1' }),
      /ALLOW_NO_SANDBOX/,
    );
    assert.throws(
      () =>
        resolveSandboxPolicy({
          COMMANDER_PROFILE: 'enterprise',
          COMMANDER_ALLOW_EXEC_SCRIPT: '1',
        }),
      /ALLOW_EXEC_SCRIPT/,
    );
  });

  it('keeps an explicit non-production NODE_ENV in the development tier', () => {
    const policy = resolveSandboxPolicy({ NODE_ENV: 'test' });
    assert.equal(policy.environment, 'test');
    assert.equal(policy.isolation, 'process');
    assert.equal(policy.failClosed, false);
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

  it('rejects SCRIPT_VM_SOFT in production (align with plugin soft)', () => {
    assert.throws(
      () => resolveSandboxPolicy({ NODE_ENV: 'production', COMMANDER_SCRIPT_VM_SOFT: '1' }),
      /SCRIPT_VM_SOFT/,
    );
  });

  it('rejects ALLOW_EXEC_SCRIPT in production (align with soft bans)', () => {
    assert.throws(
      () => resolveSandboxPolicy({ NODE_ENV: 'production', COMMANDER_ALLOW_EXEC_SCRIPT: '1' }),
      /ALLOW_EXEC_SCRIPT/,
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

  it('static source gate passes against the real repository tree', () => {
    // packages/core is <repo>/packages/core — walk up to repository root.
    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
    assert.doesNotThrow(() => assertProductionSandboxSource(repoRoot));
  });

  it('static source gate fails when host-exec production guard is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-sandbox-src-'));
    writeSandboxSourceFixture(root, {
      executionRouterBody: `
        export class ExecutionRouter {
          async selectBackend(args) {
            // Deliberately missing assertProductionBackendRequest — host SSH/docker
            // backends would be selectable in production.
            if (args.ssh_host) return { type: 'ssh' };
            return { type: 'local' };
          }
        }
      `,
    });
    assert.throws(
      () => assertProductionSandboxSource(root),
      /host-exec|assertProductionBackendRequest|SSH/i,
    );
  });

  it('static source gate requires host-exec production rejection copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-sandbox-src-'));
    writeSandboxSourceFixture(root, {
      executionRouterBody: `
        export class ExecutionRouter {
          async selectBackend(args) {
            this.assertProductionBackendRequest(args);
            return { type: 'local' };
          }
          assertProductionBackendRequest() {}
        }
      `,
    });
    assert.throws(() => assertProductionSandboxSource(root), /host-exec|SSH|Docker|forbidden/i);
  });
});
