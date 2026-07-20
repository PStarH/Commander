import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { SQLITE_KERNEL_SCHEMA_SQL } from '@commander/kernel';
import { SqliteWorkerRegistry } from './sqliteRegistry.js';

describe('SqliteWorkerRegistry', () => {
  it('register increments generation and heartbeat fences stale generation', async () => {
    const db = new Database(':memory:');
    db.exec(SQLITE_KERNEL_SCHEMA_SQL);
    const registry = new SqliteWorkerRegistry(db);
    const def = {
      id: 'worker-1',
      kind: 'agent' as const,
      version: '0.1.0',
      capabilities: ['agent'],
      maxConcurrency: 2,
      labels: {},
    };
    const first = await registry.register(def, 'subj-1', ['tenant-a']);
    assert.equal(first.generation, 1);
    const second = await registry.register(def, 'subj-1', ['tenant-a']);
    assert.equal(second.generation, 2);
    assert.equal(await registry.heartbeat('worker-1', 1, 1), null);
    const live = await registry.heartbeat('worker-1', 2, 1);
    assert.equal(live?.generation, 2);
    db.close();
  });
});
