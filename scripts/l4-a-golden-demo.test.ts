import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GOLDEN_DEMO_CHECKS,
  runGoldenDemo,
} from './l4-a-golden-demo.js';

const MAX_RUNTIME_MS = 5 * 60 * 1000;

void describe('L4-A golden demo', () => {
  void it('runs all eight named checks within five minutes', async () => {
    const result = await runGoldenDemo({ silent: true });
    assert.equal(result.mode, 'simulated');
    assert.equal(result.checks.length, GOLDEN_DEMO_CHECKS.length);
    for (const name of GOLDEN_DEMO_CHECKS) {
      const check = result.checks.find((entry) => entry.name === name);
      assert.ok(check, `missing check ${name}`);
      assert.equal(
        check.passed,
        true,
        `${name} failed: ${check.detail ?? 'unknown error'}`,
      );
    }
    assert.equal(result.allPassed, true);
    assert.ok(result.elapsedMs < MAX_RUNTIME_MS, `demo exceeded ${MAX_RUNTIME_MS}ms`);
  });
});
