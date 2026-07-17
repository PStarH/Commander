import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildWorkloadDockerOptions,
  createSandboxWorkloadContext,
  toRuntimeWorkloadMetadata,
  validateSandboxWorkloadContext,
} from '../../src/sandbox/workload';
import { ExecutionRouter, resolveRuntimeWorkloadContext } from '../../src/sandbox/executionRouter';

describe('sandbox workload context', () => {
  it('creates a server-owned workload identity from tenant/run/step', () => {
    const context = createSandboxWorkloadContext({
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
    });

    assert.equal(context.tenantId, 'tenant-a');
    assert.equal(context.runId, 'run-1');
    assert.equal(context.stepId, 'step-1');
    assert.match(context.workloadId, /^run-1-step-1-/);
  });

  it('rejects missing or unsafe workload identity fields', () => {
    assert.throws(
      () =>
        validateSandboxWorkloadContext({
          tenantId: '',
          runId: 'run',
          stepId: 'step',
          workloadId: 'work',
        }),
      /tenantId/,
    );
    assert.throws(
      () =>
        validateSandboxWorkloadContext({
          tenantId: 'tenant',
          runId: 'run/escape',
          stepId: 'step',
          workloadId: 'work',
        }),
      /runId/,
    );
  });

  it('produces unique opaque container names and tenant/run/step labels', () => {
    const first = createSandboxWorkloadContext({
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
    });
    const second = createSandboxWorkloadContext({
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-2',
    });
    const firstOptions = buildWorkloadDockerOptions(first);
    const secondOptions = buildWorkloadDockerOptions(second);

    assert.notEqual(
      firstOptions[firstOptions.indexOf('--name') + 1],
      secondOptions[secondOptions.indexOf('--name') + 1],
    );
    assert.ok(firstOptions.includes('commander.tenant_id=tenant-a'));
    assert.ok(firstOptions.includes('commander.run_id=run-1'));
    assert.ok(firstOptions.includes('commander.step_id=step-1'));
    assert.ok(firstOptions.includes(`commander.workload_id=${first.workloadId}`));
  });

  it('maps context object fields to runtime-metadata args keys', () => {
    const context = createSandboxWorkloadContext({
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
      workloadId: 'work-1',
    });

    assert.deepEqual(toRuntimeWorkloadMetadata(context), {
      _tenantId: 'tenant-a',
      _runId: 'run-1',
      _stepId: 'step-1',
      _workloadId: 'work-1',
    });
  });

  it('rejects production execution without a complete workload context', async () => {
    const router = new ExecutionRouter({
      NODE_ENV: 'production',
      COMMANDER_PLUGIN_SANDBOX: 'required',
    });

    await assert.rejects(
      router.execute('true', { _tenantId: 'tenant-a', _runId: 'run-1', _stepId: 'step-1' }),
      /workload context/,
    );
  });

  it('accepts production execution when all runtime-metadata workload keys are present', async () => {
    const context = createSandboxWorkloadContext({
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
    });
    const router = new ExecutionRouter({
      NODE_ENV: 'production',
      COMMANDER_PLUGIN_SANDBOX: 'required',
    });

    try {
      await router.execute('true', toRuntimeWorkloadMetadata(context));
    } catch (error) {
      assert.notMatch(
        String((error as Error).message),
        /workload context/i,
        'complete _-prefixed keys must not be rejected for workload identity',
      );
    }
  });

  it('does not treat bare context-shaped keys as runtime workload args', () => {
    const context = createSandboxWorkloadContext({
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
    });
    const productionEnv = {
      NODE_ENV: 'production',
      COMMANDER_PLUGIN_SANDBOX: 'required',
    };

    assert.equal(resolveRuntimeWorkloadContext({ ...context }, productionEnv), undefined);
    assert.deepEqual(
      resolveRuntimeWorkloadContext(toRuntimeWorkloadMetadata(context), productionEnv),
      context,
    );
  });
});
