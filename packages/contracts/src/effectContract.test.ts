import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EFFECT_DURABLE_STATES, toEffectContractV2, fromEffectContractV2, wrapEffectV2 } from './effectContract.js';

describe('EffectContractV2', () => {
  it('durable states are exactly four', () => {
    assert.deepEqual([...EFFECT_DURABLE_STATES], [
      'ADMITTED', 'COMPLETION_UNKNOWN', 'COMPLETED', 'FAILED',
    ]);
  });

  it('toEffectContractV2 maps admitted envelope', () => {
    const contract = toEffectContractV2(
      {
        effect_id: 'e1',
        tenant_id: 't1',
        run_id: 'r1',
        step_id: 's1',
        action: 'connector.github.pullRequestCreate',
        payload: { title: 'x' },
        idempotency_key: 'idem-12345678',
        status: 'admitted',
      },
      {
        adapterId: 'github.pullRequestCreate',
        adapterVersion: '1.0.0',
        requestDigest: 'abc',
        policyDecisionId: 'dec-1',
        fencingEpoch: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    );
    assert.equal(contract.payload.status, 'ADMITTED');
    assert.equal(contract.schemaVersion, 'commander.effect/v2');
  });

  it('rejects observation-only envelope status', () => {
    assert.throws(() =>
      toEffectContractV2(
        {
          effect_id: 'e1',
          tenant_id: 't1',
          run_id: 'r1',
          step_id: 's1',
          action: 'http.get',
          payload: {},
          idempotency_key: 'idem-12345678',
          status: 'executing',
        },
        {
          adapterId: 'a',
          adapterVersion: '1',
          requestDigest: 'd',
          policyDecisionId: 'p',
          fencingEpoch: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ),
    );
  });

  it('fromEffectContractV2 round-trips identity fields', () => {
    const contract = wrapEffectV2({
      id: 'e1',
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      kind: 'http.get',
      action: 'http.get',
      status: 'ADMITTED',
      adapterId: 'a',
      adapterVersion: '1',
      requestDigest: 'd',
      policyDecisionId: 'p',
      idempotencyKey: 'idem-12345678',
      fencingEpoch: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const envelope = fromEffectContractV2(contract);
    assert.equal(envelope.effect_id, 'e1');
    assert.equal(envelope.status, 'admitted');
  });
});
