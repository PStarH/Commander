import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDrillVerificationRepositoryOptions } from './disasterRecovery.js';

describe('disaster recovery verification repository', () => {
  it('keeps read verification on the owner scheduler path', () => {
    assert.deepEqual(buildDrillVerificationRepositoryOptions(), { schedulerMode: true });
  });
});
