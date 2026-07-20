import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { L4B_CHAOS_MODE, runL4BAdapterChaos } from './l4-b-adapter-chaos.js';

describe('L4-B adapter chaos (ENFORCED fake HTTP)', () => {
  it('timeout-after-remote-commit keeps remote create count at 1', async () => {
    const result = await runL4BAdapterChaos();
    assert.equal(result.mode, L4B_CHAOS_MODE);
    assert.equal(result.passed, true);
    assert.equal(result.remoteCreateCount, 1);
    assert.equal(result.effectState, 'COMPLETED');
  });
});
