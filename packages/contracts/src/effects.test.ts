/**
 * WS2 §2 acceptance: EffectEnvelope contract structure & field validation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EFFECT_ACTION_NAMESPACES,
  EFFECT_ID_PATTERN,
  actionNamespace,
  isValidEffectEnvelopeIdentity,
  type EffectEnvelope,
} from './index.js';

describe('WS2 §2 EffectEnvelope contract', () => {
  it('exposes the five action namespaces', () => {
    assert.deepEqual([...EFFECT_ACTION_NAMESPACES], ['http', 'llm', 'connector', 'compensate', 'tool']);
  });

  it('classifies action names into namespaces', () => {
    assert.equal(actionNamespace('http.post'), 'http');
    assert.equal(actionNamespace('llm.openai.chat'), 'llm');
    assert.equal(actionNamespace('connector.salesforce.upsert'), 'connector');
    assert.equal(actionNamespace('compensate.refund'), 'compensate');
    assert.equal(actionNamespace('tool.git.push'), 'tool');
  });

  it('rejects unknown action namespaces', () => {
    assert.equal(actionNamespace('unknown.action'), null);
    assert.equal(actionNamespace(''), null);
  });

  it('validates a well-formed envelope identity', () => {
    const envelope: EffectEnvelope = {
      effect_id: 'eff_001',
      tenant_id: 'tenant-a',
      run_id: 'run-1',
      step_id: 'step-1',
      action: 'http.post',
      payload: { url: 'https://example.com' },
      idempotency_key: 'idem-abc',
      status: 'admitted',
    };
    assert.equal(isValidEffectEnvelopeIdentity(envelope), true);
  });

  it('rejects envelopes with empty identity fields', () => {
    const base: EffectEnvelope = {
      effect_id: 'eff_001',
      tenant_id: 'tenant-a',
      run_id: 'run-1',
      step_id: 'step-1',
      action: 'http.post',
      payload: {},
      idempotency_key: 'idem-abc',
      status: 'admitted',
    };
    assert.equal(isValidEffectEnvelopeIdentity({ ...base, effect_id: '' }), false);
    assert.equal(isValidEffectEnvelopeIdentity({ ...base, tenant_id: '' }), false);
    assert.equal(isValidEffectEnvelopeIdentity({ ...base, run_id: '' }), false);
    assert.equal(isValidEffectEnvelopeIdentity({ ...base, step_id: '' }), false);
  });

  it('does not validate action or idempotency_key (broker-level checks)', () => {
    // isValidEffectEnvelopeIdentity intentionally only validates the 4 identity
    // fields (spec §2). Action namespace and idempotency_key are broker admit-time
    // checks. This test pins that contract boundary.
    const base: EffectEnvelope = {
      effect_id: 'eff_001',
      tenant_id: 'tenant-a',
      run_id: 'run-1',
      step_id: 'step-1',
      action: 'http.post',
      payload: {},
      idempotency_key: 'idem-abc',
      status: 'admitted',
    };
    assert.equal(isValidEffectEnvelopeIdentity({ ...base, action: 'unknown.action' }), true);
    assert.equal(isValidEffectEnvelopeIdentity({ ...base, idempotency_key: '' }), true);
  });

  it('EFFECT_ID_PATTERN accepts safe identifier characters', () => {
    assert.ok(EFFECT_ID_PATTERN.test('eff_001'));
    assert.ok(EFFECT_ID_PATTERN.test('a-b-c'));
    assert.ok(EFFECT_ID_PATTERN.test('ABC123'));
  });

  it('EFFECT_ID_PATTERN rejects overly long or unsafe identifiers', () => {
    assert.ok(!EFFECT_ID_PATTERN.test(''));
    assert.ok(!EFFECT_ID_PATTERN.test('has space'));
    assert.ok(!EFFECT_ID_PATTERN.test('has/slash'));
    assert.ok(!EFFECT_ID_PATTERN.test('x'.repeat(129)));
  });
});
