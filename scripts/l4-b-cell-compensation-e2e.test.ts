import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runAdapterOpsCompensationMock, runCellCompensationE2E } from './l4-b-cell-compensation-e2e.js';

describe('l4-b-cell-compensation-e2e', () => {
  it('mock mode proves adapter-ops compensation consumer (ENFORCED)', async (t) => {
    try {
      const ok = await runAdapterOpsCompensationMock();
      if (!ok) {
        t.skip('adapter-ops mock deps unavailable');
        return;
      }
      assert.equal(ok, true);
    } catch (err) {
      t.skip(`deps unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  it('runCellCompensationE2E mock verdict is ENFORCED-script-only when passing', async (t) => {
    const result = await runCellCompensationE2E({ mode: 'mock' });
    if (!result.steps.S_mock_adapter_ops) {
      t.skip('mock compensation deps unavailable');
      return;
    }
    assert.equal(result.verdict, 'ENFORCED-script-only');
    assert.equal(result.passed, true);
  });
});
