/**
 * `walCheckpoint` must read the pragma result shape better-sqlite3 actually
 * returns (an array of row objects) so a busy/failed checkpoint is reported as
 * -1 instead of a successful zero-frame checkpoint.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { walCheckpoint, type WalDbHandle } from '../../src/storage/walCheckpoint';

function handleReturning(result: unknown): WalDbHandle {
  return { pragma: () => result } as unknown as WalDbHandle;
}

describe('walCheckpoint result parsing', () => {
  it('returns the checkpointed frame count from a better-sqlite3 row object', () => {
    const result = walCheckpoint(handleReturning([{ busy: 0, log: 7, checkpointed: 2 }]));
    assert.equal(result, 2);
  });

  it('reports a busy checkpoint as failure (-1) instead of success', () => {
    const result = walCheckpoint(handleReturning([{ busy: 1, log: 7, checkpointed: 2 }]));
    assert.equal(result, -1);
  });

  it('still accepts the legacy three-number pragma shape', () => {
    assert.equal(walCheckpoint(handleReturning([10, 4, 0])), 4);
    assert.equal(walCheckpoint(handleReturning([10, 4, 1])), -1);
  });

  it('reports failure when the pragma result is unrecognised', () => {
    assert.equal(walCheckpoint(handleReturning([{ unexpected: true }])), -1);
    assert.equal(walCheckpoint(handleReturning(undefined)), -1);
  });

  it('returns -1 for a missing handle', () => {
    assert.equal(walCheckpoint(null), -1);
    assert.equal(walCheckpoint(undefined), -1);
  });
});
