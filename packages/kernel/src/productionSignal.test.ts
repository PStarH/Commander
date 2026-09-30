/**
 * AUDIT-K1 regressions: kernel fail-closed gates must not hinge on NODE_ENV
 * alone. Losing that single env var (or NODE_ENV=prod) used to silently
 * re-enable the RLS bypass, sqlite kernel, and ephemeral signing keys.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { isProductionEnvironment, mustRefuseMissingAppRole } from './productionSignal.js';

describe('isProductionEnvironment (AUDIT-K1)', () => {
  test('no signals → not production (dev behaviour preserved)', () => {
    assert.equal(isProductionEnvironment({}), false);
  });

  for (const signal of [
    { NODE_ENV: 'production' },
    { COMMANDER_ENV: 'production' },
    { COMMANDER_PROFILE: 'enterprise' },
    { COMMANDER_CELL_TIER: 'enterprise' },
  ] as const) {
    test(`${Object.keys(signal)[0]} marks production`, () => {
      assert.equal(isProductionEnvironment(signal), true);
    });
  }

  test('NODE_ENV=prod is NOT production (typo does not fake a signal)', () => {
    assert.equal(isProductionEnvironment({ NODE_ENV: 'prod' }), false);
  });
});

describe('mustRefuseMissingAppRole (AUDIT-K1 RLS gate)', () => {
  test('NODE_ENV=production without commander_app refuses', () => {
    assert.equal(mustRefuseMissingAppRole({ NODE_ENV: 'production' }), true);
  });

  test('COMMANDER_ENV=production alone also refuses (baseline hole: NODE_ENV-only)', () => {
    // FAILING before the fix: this env lost NODE_ENV and the gate stayed open.
    assert.equal(mustRefuseMissingAppRole({ COMMANDER_ENV: 'production' }), true);
  });

  test('enterprise profile without NODE_ENV also refuses', () => {
    assert.equal(mustRefuseMissingAppRole({ COMMANDER_PROFILE: 'enterprise' }), true);
  });

  test('explicit documented bypass still honoured in production', () => {
    assert.equal(
      mustRefuseMissingAppRole({ NODE_ENV: 'production', COMMANDER_ALLOW_RLS_BYPASS: '1' }),
      false,
    );
  });

  test('bogus bypass value does not count as opt-in', () => {
    assert.equal(
      mustRefuseMissingAppRole({ NODE_ENV: 'production', COMMANDER_ALLOW_RLS_BYPASS: '0' }),
      true,
    );
  });

  test('non-production without the role stays permissive (dev/test ergonomics)', () => {
    assert.equal(mustRefuseMissingAppRole({ NODE_ENV: 'test' }), false);
  });
});
