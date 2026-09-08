import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('SLO recovery can acquire and validate a SQLite lease in ESM', async () => {
  assert.equal(typeof require, 'undefined');
  const moduleUrl = pathToFileURL(resolve('packages/core/src/atr/leaseManager.ts'));
  const { LeaseManager } = await import(moduleUrl.href);
  const manager = new LeaseManager({ filePath: ':memory:' });
  try {
    const { acquired, lease } = manager.acquire('slo-esm');
    assert.equal(acquired, true);
    assert.deepEqual(manager.validate('slo-esm', lease.token, lease.fencingEpoch), lease);
  } finally {
    manager.close();
  }
});
