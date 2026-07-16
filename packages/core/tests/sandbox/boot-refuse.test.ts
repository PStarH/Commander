import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SandboxInitializationError, SandboxManager } from '../../src/sandbox/manager';
import type {
  PlatformSandbox,
  SandboxProfile,
  SandboxExecutionResult,
} from '../../src/sandbox/types';
import { ExecutionRouter } from '../../src/sandbox/executionRouter';
import { createSandboxWorkloadContext } from '../../src/sandbox/workload';

const productionEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  COMMANDER_PLUGIN_SANDBOX: 'required',
};

class FakeSandbox implements PlatformSandbox {
  readonly available = true;
  private readonly mechanism: PlatformSandbox['name'];
  private readonly exitCode: number;
  invoked = false;

  constructor(mechanism: PlatformSandbox['name'], exitCode = 0) {
    this.mechanism = mechanism;
    this.exitCode = exitCode;
  }

  get name(): PlatformSandbox['name'] {
    return this.mechanism;
  }

  async execute(_command: string, _profile: SandboxProfile): Promise<SandboxExecutionResult> {
    this.invoked = true;
    return {
      stdout: '',
      stderr: '',
      exitCode: this.exitCode,
      durationMs: 0,
      sandboxMechanism: this.mechanism,
    };
  }
}

describe('production sandbox boot refusal', () => {
  it('refuses production boot when the Docker default is unavailable', () => {
    const seatbelt = new FakeSandbox('seatbelt');

    assert.throws(
      () =>
        new SandboxManager({
          environment: productionEnv,
          sandboxes: [seatbelt],
        }),
      /docker/,
    );
    assert.equal(seatbelt.invoked, false);
  });

  it('refuses an explicit no-sandbox dependency override in production', () => {
    assert.throws(
      () =>
        new SandboxManager({
          environment: productionEnv,
          allowNoSandbox: true,
          sandboxes: [new FakeSandbox('docker')],
        }),
      SandboxInitializationError,
    );
  });

  it('refuses the environment no-sandbox bypass in production', () => {
    assert.throws(
      () =>
        new SandboxManager({
          environment: { ...productionEnv, COMMANDER_ALLOW_NO_SANDBOX: 'true' },
          sandboxes: [new FakeSandbox('docker')],
        }),
      /ALLOW_NO_SANDBOX/,
    );
  });

  it('refuses boot when the selected sandbox cannot start a probe workload', async () => {
    const docker = new FakeSandbox('docker', 125);
    const manager = new SandboxManager({
      environment: productionEnv,
      sandboxes: [docker],
    });

    await assert.rejects(manager.verifyReady(), /probe|start|125/);
    assert.equal(docker.invoked, true);
  });

  it('refuses a production full-access profile before invoking the sandbox', async () => {
    const docker = new FakeSandbox('docker');
    const manager = new SandboxManager({
      environment: productionEnv,
      sandboxes: [docker],
    });

    await assert.rejects(
      manager.execute(
        'true',
        'full-access',
        process.cwd(),
        'docker',
        createSandboxWorkloadContext({ tenantId: 'tenant-a', runId: 'run-1', stepId: 'step-1' }),
      ),
      /full-access|production/i,
    );
    assert.equal(docker.invoked, false);
  });

  it('refuses SSH, arbitrary Docker exec, and explicit local backend requests', async () => {
    const router = new ExecutionRouter(productionEnv);

    await assert.rejects(
      router.selectBackend({ backend: 'ssh', ssh_host: 'untrusted-host' }),
      /[Pp]roduction/,
    );
    await assert.rejects(
      router.selectBackend({ backend: 'docker', container: 'user-container' }),
      /[Pp]roduction/,
    );
    await assert.rejects(router.selectBackend({ backend: 'local' }), /[Pp]roduction/);
  });
});
