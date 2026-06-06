import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { IdempotencyStore } from '../../src/atr/idempotencyStore';
import { generateIdempotencyKey } from '../../src/atr/canonicalJson';
import { resetIdempotencyStore } from '../../src/atr/idempotencyStore';

function newStore(): IdempotencyStore {
  return new IdempotencyStore({
    filePath: ':memory:',
    maxRecords: 1000,
    defaultTtlSeconds: 60,
    evictEveryOps: 1000,
  });
}

function runtimeKey(runId: string, actionId: string, toolName: string, args: Record<string, unknown>, externalSystem = 'agent'): string {
  return generateIdempotencyKey({
    externalSystem,
    toolName,
    args,
    intentHash: runId,
    runId,
    stepId: actionId,
  });
}

describe('C2 — agentRuntime ↔ IdempotencyStore wiring', () => {
  let store: IdempotencyStore;

  beforeEach(() => {
    store = newStore();
    resetIdempotencyStore();
  });

  afterEach(() => {
    store.close();
  });

  it('first mutation call acquires the key, second call (same args) replays the cached result', () => {
    const runId = 'run-1';
    const actionId = 'action-1';
    const args = { path: '/tmp/x.txt', content: 'hello' };
    const key = runtimeKey(runId, actionId, 'file_write', args);

    const first = store.begin(key, { runId, toolName: 'file_write' });
    assert.strictEqual(first.acquired, true, 'first begin acquires the slot');
    assert.strictEqual(first.record.state, 'in_progress');

    store.complete(key, 'wrote 5 bytes', { runId });

    const second = store.begin(key, { runId, toolName: 'file_write' });
    assert.strictEqual(second.acquired, false, 'second begin sees the existing record');
    assert.strictEqual(second.record.state, 'completed');
    assert.strictEqual(second.record.result, 'wrote 5 bytes');
  });

  it('failed mutation tool call caches the error and replays it', () => {
    const runId = 'run-2';
    const actionId = 'action-2';
    const key = runtimeKey(runId, actionId, 'file_edit', { path: '/tmp/y.txt' });

    const first = store.begin(key, { runId, toolName: 'file_edit' });
    assert.strictEqual(first.acquired, true);
    store.fail(key, 'permission denied', { runId });

    const second = store.begin(key, { runId, toolName: 'file_edit' });
    assert.strictEqual(second.acquired, false);
    assert.strictEqual(second.record.state, 'failed');
    assert.strictEqual(second.record.error, 'permission denied');
  });

  it('different runs produce different keys for the same tool+args (no cross-run replay)', () => {
    const args = { path: '/tmp/z.txt' };
    const keyA = runtimeKey('run-A', 'action-1', 'file_write', args);
    const keyB = runtimeKey('run-B', 'action-1', 'file_write', args);
    assert.notStrictEqual(keyA, keyB, 'runId is part of the key derivation');
  });

  it('same run + different stepId produce different keys (multiple calls of the same tool in one run)', () => {
    const runId = 'run-3';
    const args = { path: '/tmp/w.txt' };
    const keyA = runtimeKey(runId, 'action-1', 'file_write', args);
    const keyB = runtimeKey(runId, 'action-2', 'file_write', args);
    assert.notStrictEqual(keyA, keyB, 'stepId disambiguates multiple calls of the same tool');
  });

  it('tenant isolation: same run/action but different tenants do not collide', () => {
    const runId = 'run-4';
    const actionId = 'action-1';
    const args = { path: '/tmp/v.txt' };
    const key = runtimeKey(runId, actionId, 'file_write', args);

    store.begin(key, { tenantId: 'tenant-a', runId, toolName: 'file_write' });
    store.complete(key, 'tenant-a wrote file', { tenantId: 'tenant-a' });

    const b = store.begin(key, { tenantId: 'tenant-b', runId, toolName: 'file_write' });
    assert.strictEqual(b.acquired, true, 'tenant B does not see tenant A cached result');
    assert.strictEqual(b.record.state, 'in_progress');
  });

  it('externalSystem is part of the key: different externalSystems produce different keys', () => {
    const runId = 'run-5';
    const actionId = 'action-1';
    const args = { path: '/tmp/u.txt' };
    const keyAgent = runtimeKey(runId, actionId, 'file_write', args, 'agent');
    const keyShell = runtimeKey(runId, actionId, 'file_write', args, 'shell');
    assert.notStrictEqual(keyAgent, keyShell, 'externalSystem disambiguates tools touching different systems');
  });
});
