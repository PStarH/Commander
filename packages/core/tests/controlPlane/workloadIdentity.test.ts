import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ControlPlane, resetControlPlane } from '../../src/controlPlane/index.js';

describe('ControlPlane step workload identity (L3-07)', () => {
  it('issueStepIdentity binds run/step and verifies by token', () => {
    resetControlPlane();
    const cp = new ControlPlane({ stepTokenTtlSeconds: 60 });
    const identity = cp.issueStepIdentity({
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
    });
    assert.equal(identity.tenantId, 'tenant-a');
    assert.equal(identity.runId, 'run-1');
    assert.equal(identity.stepId, 'step-1');
    assert.ok(identity.token);
    assert.equal(cp.verifyIdentityByToken(identity.token)?.workloadId, identity.workloadId);
    assert.equal(cp.getIdentity(identity.workloadId)?.tenantId, 'tenant-a');
  });

  it('drops expired identities on verify', () => {
    resetControlPlane();
    const cp = new ControlPlane({ stepTokenTtlSeconds: -1 });
    const identity = cp.issueStepIdentity({
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
    });
    assert.equal(cp.verifyIdentityByToken(identity.token), undefined);
    assert.equal(cp.getIdentity(identity.workloadId), undefined);
  });
});
