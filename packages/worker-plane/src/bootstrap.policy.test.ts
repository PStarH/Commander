import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorkerPolicyEvaluator } from './bootstrap.js';

describe('createWorkerPolicyEvaluator', () => {
  it('defaults to deny-all (admission force)', async () => {
    const policy = createWorkerPolicyEvaluator({});
    const decision = await policy.evaluate({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      type: 'crm.write',
      request: {},
      token: {} as never,
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.decisionId, 'deny-default');
  });

  it('allows only with explicit COMMANDER_WORKER_EFFECT_POLICY=permit', async () => {
    const policy = createWorkerPolicyEvaluator({
      COMMANDER_WORKER_EFFECT_POLICY: 'permit',
    } as NodeJS.ProcessEnv);
    const decision = await policy.evaluate({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      type: 'crm.write',
      request: {},
      token: {} as never,
    });
    assert.equal(decision.effect, 'allow');
    assert.equal(decision.decisionId, 'permit-default');
  });

  it('denies in production even if NODE_ENV=production without explicit permit', async () => {
    const policy = createWorkerPolicyEvaluator({
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);
    const decision = await policy.evaluate({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      type: 'http.post',
      request: { url: 'https://example.com' },
      token: {} as never,
    });
    assert.equal(decision.effect, 'deny');
  });
});
