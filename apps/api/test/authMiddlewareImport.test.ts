import assert from 'node:assert/strict';
import { test } from 'node:test';

test('auth middleware module can load before the process starts auth authorities', async () => {
  const { authMiddleware } = await import('../src/authMiddleware.js');
  assert.equal(typeof authMiddleware, 'function');
});
