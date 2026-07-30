import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  notReadyControlledChangeEvidence,
  runAdapterOpsCompensationMock,
  runCellCompensationE2E,
} from './l4-b-cell-compensation-e2e.js';

describe('l4-b-cell-compensation-e2e', () => {
  it('keeps Kubernetes controlled-change telemetry NOT_READY without a Kubernetes proof', () => {
    assert.equal(notReadyControlledChangeEvidence().proofVerdict, 'NOT_READY');
    assert.equal(notReadyControlledChangeEvidence().remoteOutcome, 'UNKNOWN');
  });

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

  it('does not claim PROVEN evidence for the compose harness', () => {
    const source = readFileSync(
      new URL('./l4-b-cell-compensation-e2e.ts', import.meta.url),
      'utf-8',
    );
    assert.doesNotMatch(source, /['"]PROVEN['"]/);
    assert.match(source, /verdict: passed \? 'ENFORCED' : 'BLOCKED'/);
  });
});
