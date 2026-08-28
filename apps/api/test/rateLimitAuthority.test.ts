import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/securityMiddleware.ts', import.meta.url), 'utf8');

test('rate-limit admission has no process-local authority', () => {
  assert.doesNotMatch(source, /\bGLOBAL_BUCKET\b/);
  assert.doesNotMatch(source, /\bglobalBucket\b/);
  assert.doesNotMatch(source, /\bconsumeGlobalToken\b/);
  assert.equal(
    existsSync(new URL('../src/persistentRateLimitStore.ts', import.meta.url)),
    false,
    'SQLite rate-limit fallback must be removed',
  );
});
