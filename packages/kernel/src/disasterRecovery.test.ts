import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDrillVerificationRepositoryOptions,
  verifyRunExists,
  verifyRunMissing,
} from './disasterRecovery.js';

describe('disaster recovery verification repository', () => {
  it('keeps read verification on the owner scheduler path', () => {
    assert.deepEqual(buildDrillVerificationRepositoryOptions(), { schedulerMode: true });
  });

  // F-K1-2: this file previously asserted nothing but that constant. A DR drill
  // that reports "run is absent" (a PASS for `verifyRunMissing`) when the
  // database is unreachable would silently certify a failed restore, so both
  // helpers must reject rather than answer.
  it('rejects instead of reporting a verdict when the restore target is unreachable', async () => {
    const run = { id: 'run-drill', tenantId: 'tenant-drill' };
    // 127.0.0.1:1 has no listener: the pool cannot connect.
    const unreachable = 'postgres://commander_owner:secret@127.0.0.1:1/commander';
    await assert.rejects(() => verifyRunExists(unreachable, run));
    await assert.rejects(
      () => verifyRunMissing(unreachable, run),
      'an unreachable restore target must never be reported as "run is absent"',
    );
  });
});
