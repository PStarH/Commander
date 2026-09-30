import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isClassAEffectType } from './effectClassification.js';

describe('effect classification', () => {
  it('fails closed for unknown and mutation families regardless of prefix', () => {
    for (const type of [
      'connector.github.create_issue',
      'compensate.rollback',
      'crm.write',
      'http.post',
      'local.crm.write',
      'llm.egress.post',
      'unknown.family',
    ]) {
      assert.equal(isClassAEffectType(type), true, type);
    }
  });

  it('permits only known disclosure/read and local-compute families as non-Class-A', () => {
    for (const type of [
      'llm.chat',
      'retrieve.search',
      'read.record',
      'budget.check',
      'local.hash',
      'compute.fold',
    ]) {
      assert.equal(isClassAEffectType(type), false, type);
    }
  });
});
