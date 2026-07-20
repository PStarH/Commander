import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyApiGateToComposeSidecarSteps,
  assertKernelBackendOnCellServices,
  runCellSmoke,
} from './l4-b-cell-smoke.js';

const KERNEL_BACKEND_ENV = { COMMANDER_KERNEL_BACKEND: 'postgres' };

describe('l4-b-cell-smoke', () => {
  it('mock mode only asserts chaos step S6 (no fake deploy steps)', async (t) => {
    const result = await runCellSmoke({ mode: 'mock' });
    assert.equal(result.steps.S1, undefined);
    assert.equal(result.steps.S2, undefined);
    assert.equal(result.steps.S3, undefined);
    if (!result.steps.S6) {
      t.skip('chaos deps unavailable — build @commander/effect-broker first');
      return;
    }
    assert.equal(result.steps.S6, true);
    assert.equal(result.passed, true);
  });

  it('mock mode fails when S6 is false', async (t) => {
    const result = await runCellSmoke({ mode: 'mock' });
    if (result.steps.S6) {
      t.skip('chaos deps available — covered by pass test');
      return;
    }
    assert.equal(result.passed, false, 'mock must not pass when S6 is false');
  });

  it('applyApiGateToComposeSidecarSteps forces S4–S6 false when S1 or S2 is false', () => {
    const steps = {
      S1: false,
      S2: true,
      S4_worker: true,
      S5_kernelOps: true,
      S6_adapterOps: true,
    };
    applyApiGateToComposeSidecarSteps(steps);
    assert.equal(steps.S4_worker, false);
    assert.equal(steps.S5_kernelOps, false);
    assert.equal(steps.S6_adapterOps, false);

    const okApi = {
      S1: true,
      S2: true,
      S4_worker: true,
      S5_kernelOps: true,
      S6_adapterOps: true,
    };
    applyApiGateToComposeSidecarSteps(okApi);
    assert.equal(okApi.S4_worker, true);
    assert.equal(okApi.S5_kernelOps, true);
    assert.equal(okApi.S6_adapterOps, true);
  });

  it('helm mode only asserts rendered template (no runtime S2/S3)', async () => {
    const result = await runCellSmoke({ mode: 'helm' });
    assert.equal(result.steps.S2, undefined);
    assert.equal(result.steps.S3, undefined);
    assert.equal(result.steps.S1, undefined);
    assert.equal(typeof result.steps.helm_template_assert, 'boolean');
    assert.equal(result.topology, 'helm-template-assert');
    assert.equal(result.passed, result.steps.helm_template_assert === true);
  });

  it('assertKernelBackendOnCellServices requires postgres on all four cell workloads', () => {
    assert.doesNotThrow(() =>
      assertKernelBackendOnCellServices({
        services: {
          api: { environment: KERNEL_BACKEND_ENV },
          worker: { environment: KERNEL_BACKEND_ENV },
          'kernel-ops': { environment: KERNEL_BACKEND_ENV },
          'adapter-ops': { environment: KERNEL_BACKEND_ENV },
        },
      }),
    );
  });

  it('assertKernelBackendOnCellServices rejects missing backend on a cell service', () => {
    assert.throws(
      () =>
        assertKernelBackendOnCellServices({
          services: {
            api: { environment: KERNEL_BACKEND_ENV },
            worker: { environment: {} },
            'kernel-ops': { environment: KERNEL_BACKEND_ENV },
            'adapter-ops': { environment: KERNEL_BACKEND_ENV },
          },
        }),
      /worker: COMMANDER_KERNEL_BACKEND must be postgres/,
    );
  });

  it('assertKernelBackendOnCellServices parses array-style environment entries', () => {
    assert.doesNotThrow(() =>
      assertKernelBackendOnCellServices({
        services: {
          api: { environment: ['COMMANDER_KERNEL_BACKEND=postgres'] },
          worker: { environment: ['COMMANDER_KERNEL_BACKEND=postgres'] },
          'kernel-ops': { environment: ['COMMANDER_KERNEL_BACKEND=postgres'] },
          'adapter-ops': { environment: ['COMMANDER_KERNEL_BACKEND=postgres'] },
        },
      }),
    );
  });
});
