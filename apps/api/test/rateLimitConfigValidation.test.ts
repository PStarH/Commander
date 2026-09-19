/**
 * AUTH-05: a mistyped quota / window / lockout must refuse startup. Previously
 * `parseInt` turned "", "abc", "1.5", "-1", "5x" and overflow into NaN or a
 * truncated value, and `count > NaN` is always false — the limit silently
 * stopped blocking instead of failing closed.
 */
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import {
  ApiStartupConfigurationError,
  RATE_LIMIT_CONFIG_NAMES,
  assertRateLimitConfiguration,
  resolvePositiveSafeInteger,
} from '../src/startupConfig';

const API_DIR = path.resolve(import.meta.dirname, '..');

/** Import securityMiddleware in a child process and report its exit code. */
function importSecurityMiddleware(env: Record<string, string>): number | null {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "await import('./src/securityMiddleware.ts');",
    ],
    {
      cwd: API_DIR,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    },
  );
  return result.status;
}

const INVALID_VALUES: Array<[string, string]> = [
  ['empty string', ''],
  ['whitespace only', '   '],
  ['non-numeric', 'abc'],
  ['decimal', '1.5'],
  ['negative', '-1'],
  ['leading plus', '+5'],
  ['trailing characters', '5x'],
  ['exponent', '1e3'],
  ['zero', '0'],
  ['overflow', '99999999999999999999'],
  ['NaN literal', 'NaN'],
  ['Infinity literal', 'Infinity'],
];

describe('AUTH-05: quota / window / lockout validation', () => {
  for (const [label, value] of INVALID_VALUES) {
    test(`rejects ${label} (${JSON.stringify(value)})`, () => {
      assert.throws(
        () => resolvePositiveSafeInteger({ API_RATE_LIMIT: value }, 'API_RATE_LIMIT', 120),
        ApiStartupConfigurationError,
        `${label} must refuse startup`,
      );
    });
  }

  test('accepts a finite positive safe integer', () => {
    assert.equal(resolvePositiveSafeInteger({ API_RATE_LIMIT: '7' }, 'API_RATE_LIMIT', 120), 7);
  });

  test('applies the default only when the variable is unset', () => {
    assert.equal(resolvePositiveSafeInteger({}, 'API_RATE_LIMIT', 120), 120);
  });

  test('refuses startup when any configured quota is invalid', () => {
    for (const name of RATE_LIMIT_CONFIG_NAMES) {
      assert.throws(
        () => assertRateLimitConfiguration({ [name]: 'not-a-number' }),
        ApiStartupConfigurationError,
        `${name} must refuse startup`,
      );
    }
  });

  test('accepts an unset configuration (defaults only)', () => {
    assert.doesNotThrow(() => assertRateLimitConfiguration({}));
  });

  test('accepts a fully valid configuration', () => {
    assert.doesNotThrow(() =>
      assertRateLimitConfiguration({
        API_RATE_LIMIT: '120',
        API_RATE_LIMIT_USER: '60',
        API_RATE_LIMIT_TENANT: '240',
        AUTH_MAX_FAILURES: '5',
        AUTH_LOCKOUT_MS: '300000',
      }),
    );
  });

  test('the rate limiter refuses to load with an invalid quota (startup refusal)', () => {
    // Pre-fix this import succeeded with RATE_LIMIT_MAX = NaN, so the limiter
    // loaded and `count > NaN` never blocked. Post-fix the module throws.
    const invalid = importSecurityMiddleware({ API_RATE_LIMIT: 'abc' });
    assert.notEqual(invalid, 0, 'an invalid API_RATE_LIMIT must abort startup');
    const valid = importSecurityMiddleware({ API_RATE_LIMIT: '5' });
    assert.equal(valid, 0, 'a valid API_RATE_LIMIT must load');
  });
});
