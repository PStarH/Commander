import { beforeEach, describe, expect, it } from 'vitest';
import { ControlPlane, resetControlPlane } from '../../src/controlPlane/index.js';

describe('ControlPlane step workload identity (L3-07)', () => {
  beforeEach(() => {
    resetControlPlane();
  });

  it('issueStepIdentity binds run/step and verifies by token', () => {
    const cp = new ControlPlane({ stepTokenTtlSeconds: 60 });
    const identity = cp.issueStepIdentity({
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
    });
    expect(identity.tenantId).toBe('tenant-a');
    expect(identity.runId).toBe('run-1');
    expect(identity.stepId).toBe('step-1');
    expect(identity.token).toBeTruthy();
    expect(cp.verifyIdentityByToken(identity.token)?.workloadId).toBe(identity.workloadId);
    expect(cp.getIdentity(identity.workloadId)?.tenantId).toBe('tenant-a');
  });

  it('drops expired identities on verify', () => {
    const cp = new ControlPlane({ stepTokenTtlSeconds: -1 });
    const identity = cp.issueStepIdentity({
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
    });
    expect(cp.verifyIdentityByToken(identity.token)).toBeUndefined();
    expect(cp.getIdentity(identity.workloadId)).toBeUndefined();
  });
});
