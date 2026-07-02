// packages/core/tests/chaos/orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ChaosOrchestrator } from '../../src/chaos/orchestrator';

describe('ChaosOrchestrator', () => {
  it('runs all selected layers', async () => {
    const orch = new ChaosOrchestrator({
      bootstrap: async () => {},
      delayMs: 1,
    });
    const results = await orch.run({
      layers: ['L1', 'L2'],
      tenantId: 'test',
      durationSec: 1,
    });
    expect(results.length).toBeGreaterThan(0);
  });

  it('gapDiscovery is called when a real fault is injected AND recovery fails', async () => {
    const gap = vi.fn();
    const orch = new ChaosOrchestrator(
      { bootstrap: async () => { throw new Error('recovery failed'); }, delayMs: 1 },
      { onGapDetected: gap },
    );
    await orch.run({ layers: ['L1'], tenantId: 'test', durationSec: 1, faultTypes: ['rate_limit_429'] });
    expect(gap).toHaveBeenCalled();
  });

  it('gapDiscovery is NOT called when recovery succeeds even with a fault type (ATK-011)', async () => {
    const gap = vi.fn();
    const orch = new ChaosOrchestrator(
      { bootstrap: async () => {}, delayMs: 1 },
      { onGapDetected: gap },
    );
    // faultTypes present but recovery succeeds → not a gap
    await orch.run({ layers: ['L1'], tenantId: 'test', durationSec: 1, faultTypes: ['rate_limit_429'] });
    expect(gap).not.toHaveBeenCalled();
  });

  it('gapDiscovery is NOT called for healthy runs (ATK-011)', async () => {
    const gap = vi.fn();
    const orch = new ChaosOrchestrator({ bootstrap: async () => {}, delayMs: 1 }, { onGapDetected: gap });
    // No faultTypes → orchestrator must NOT report a gap
    await orch.run({ layers: ['L1'], tenantId: 'test', durationSec: 1 });
    expect(gap).not.toHaveBeenCalled();
  });

  it('disarms all faults after run (ATK-013)', async () => {
    const orch = new ChaosOrchestrator({ bootstrap: async () => {}, delayMs: 1 });
    orch.layers.l2.arm({ tool: 'web_fetch', mode: 'http_5xx', statusCode: 503 });
    expect(orch.layers.l2.getActiveFaults('web_fetch').length).toBeGreaterThan(0);
    await orch.run({ layers: ['L2'], tenantId: 'test', durationSec: 1 });
    // After the run, the fault must be disarmed
    expect(orch.layers.l2.getActiveFaults('web_fetch').length).toBe(0);
  });

  it('rejects invalid scenario (no tenant for L4)', async () => {
    const orch = new ChaosOrchestrator({ bootstrap: async () => {}, delayMs: 1 });
    await expect(orch.run({ layers: ['L4'] })).rejects.toThrow(/tenantId/);
  });
});
