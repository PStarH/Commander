// packages/core/tests/chaos/l3System.test.ts
import { describe, it, expect } from 'vitest';
import { L3SystemLayer } from '../../src/chaos/l3SystemLayer';

describe('L3SystemLayer', () => {
  it('cpu throttle applies for given duration', async () => {
    const layer = new L3SystemLayer();
    const start = Date.now();
    await layer.injectCpuThrottle({ durationMs: 100, percent: 50 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });

  it('disk full simulation writes to a constrained tmpfs path', async () => {
    const layer = new L3SystemLayer();
    const path = await layer.injectDiskFull({ constraintMb: 1 });
    expect(path).toMatch(/chaos-disk-/);
  });
});
