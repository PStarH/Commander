import assert from 'node:assert/strict';
import test from 'node:test';
import { IdempotencyStore } from '../packages/core/src/atr/idempotencyStore.ts';
import { RunLedger } from '../packages/core/src/atr/runLedger.ts';
import { WalCheckpointStore } from '../packages/core/src/atr/checkpointStore.ts';
import { CheckpointStore } from '../packages/core/src/runtime/checkpointStore.ts';

test('chaos runtime SQLite stores load installed driver in ESM', () => {
  assert.equal(typeof require, 'undefined');
  const idempotency = new IdempotencyStore({ filePath: ':memory:' });
  try {
    assert.equal(idempotency.begin('chaos').acquired, true);
    assert.equal(idempotency.begin('chaos').acquired, false);
  } finally {
    idempotency.close();
  }
  const ledger = new RunLedger({ filePath: ':memory:' });
  ledger.closeOwnedResources();
  const wal = new WalCheckpointStore({ filePath: ':memory:' });
  wal.close();
  const checkpoint = new CheckpointStore({ filePath: ':memory:' });
  checkpoint.close();
});
