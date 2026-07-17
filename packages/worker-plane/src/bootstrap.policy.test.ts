import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from '../../kernel/src/testing/inMemoryRepository.ts';
import { createWorkerPolicyEvaluator, withDefaultLlmAllowlist } from './bootstrap.js';

describe('createWorkerPolicyEvaluator', () => {
  it('allows llm.* model calls by default (agent can invoke providers)', async () => {
    const policy = createWorkerPolicyEvaluator({});
    const decision = await policy.evaluate({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      type: 'llm.openai',
      request: { effectId: 'e1', contentHash: 'h' },
      token: {} as never,
    });
    assert.equal(decision.effect, 'allow');
    assert.equal(decision.decisionId, 'llm-model-default');
    assert.equal(decision.policySnapshotId, 'worker-llm-v1');
  });

  it('denies non-llm external effects by default (fail-closed)', async () => {
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

  it('never enables permit-all via COMMANDER_WORKER_EFFECT_POLICY=permit', async () => {
    // WS2 §4: the permit-all bypass is DELETED. Even with the legacy env var
    // set, non-llm tools stay denied.
    const policy = createWorkerPolicyEvaluator({
      COMMANDER_WORKER_EFFECT_POLICY: 'permit',
    } as NodeJS.ProcessEnv);
    const tool = await policy.evaluate({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      type: 'crm.write',
      request: {},
      token: {} as never,
    });
    assert.equal(tool.effect, 'deny');
    assert.notEqual(tool.decisionId, 'permit-default');

    const llm = await policy.evaluate({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      type: 'llm.anthropic',
      request: {},
      token: {} as never,
    });
    assert.equal(llm.effect, 'allow');
  });

  it('denies http.* in production without an explicit allowlist path', async () => {
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

describe('withDefaultLlmAllowlist', () => {
  it('seeds llm.* so model actions pass isActionAllowed', async () => {
    const kernel = new InMemoryKernelRepository();
    const port = withDefaultLlmAllowlist(kernel);
    assert.equal(await port.isActionAllowed!('tenant-a', 'llm.openai'), true);
    assert.equal(await port.isActionAllowed!('tenant-a', 'crm.write'), false);
  });

  it('does not overwrite an explicit llm.* deny', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.setAllowlistEntry('tenant-a', 'llm.*', false);
    const port = withDefaultLlmAllowlist(kernel);
    assert.equal(await port.isActionAllowed!('tenant-a', 'llm.openai'), false);
  });
});
