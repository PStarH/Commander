import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('auth middleware module can load before the process starts auth authorities', async () => {
  const { authMiddleware } = await import('../src/authMiddleware.js');
  assert.equal(typeof authMiddleware, 'function');
});

test('API-key authentication has no environment or process-local authority', () => {
  const source = readFileSync(new URL('../src/authMiddleware.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /\bAPI_KEYS\b/);
  assert.doesNotMatch(source, /\bTENANT_API_KEYS\b/);
  assert.doesNotMatch(source, /\bparseApiKeys\b/);
  assert.doesNotMatch(source, /\bparseTenantApiKeys\b/);
});
