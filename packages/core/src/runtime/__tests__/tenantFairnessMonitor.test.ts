import { describe, it, expect, beforeEach } from 'vitest';
import {
  TenantFairnessMonitor,
  getTenantFairnessMonitor,
  resetTenantFairnessMonitor,
} from '../tenantFairnessMonitor';

describe('TenantFairnessMonitor', () => {
  let monitor: TenantFairnessMonitor;

  beforeEach(() => {
    monitor = new TenantFairnessMonitor();
  });

  it('returns Jain index 1 with no completions', () => {
    expect(monitor.getJainIndex()).toBe(1);
  });

  it('returns perfect Jain index when tenants are equal', () => {
    for (let i = 0; i < 5; i++) {
      monitor.recordCompletion('tenant-a');
      monitor.recordCompletion('tenant-b');
    }
    expect(monitor.getJainIndex()).toBe(1);
  });

  it('computes tenant shares', () => {
    monitor.recordCompletion('tenant-a');
    monitor.recordCompletion('tenant-a');
    monitor.recordCompletion('tenant-b');
    expect(monitor.getTenantShare('tenant-a')).toBeCloseTo(2 / 3, 6);
    expect(monitor.getTenantShare('tenant-b')).toBeCloseTo(1 / 3, 6);
    expect(monitor.getTenantShare('tenant-c')).toBe(0);
  });

  it('returns a low Jain index when one tenant dominates', () => {
    for (let i = 0; i < 100; i++) monitor.recordCompletion('t-rich');
    monitor.recordCompletion('t-poor');
    expect(monitor.getJainIndex()).toBeLessThan(0.85);
  });

  it('lists throttled tenants above the threshold', () => {
    monitor.recordCompletion('tenant-a');
    monitor.recordCompletion('tenant-a');
    monitor.recordCompletion('tenant-b');
    expect(monitor.getThrottledTenants(0.5)).toEqual(['tenant-a']);
    expect(monitor.getThrottledTenants(0.9)).toEqual([]);
  });

  it('returns empty throttled list for non-positive threshold', () => {
    monitor.recordCompletion('tenant-a');
    expect(monitor.getThrottledTenants(0)).toEqual([]);
    expect(monitor.getThrottledTenants(-1)).toEqual([]);
  });

  it('evicts completions outside the sliding window', async () => {
    const shortWindow = new TenantFairnessMonitor(50);
    shortWindow.recordCompletion('tenant-a');
    expect(shortWindow.getTenantShare('tenant-a')).toBe(1);
    await new Promise((r) => setTimeout(r, 70));
    shortWindow.recordCompletion('tenant-b');
    expect(shortWindow.getTenantShare('tenant-a')).toBe(0);
    expect(shortWindow.getTenantShare('tenant-b')).toBe(1);
  });

  it('resets all history', () => {
    monitor.recordCompletion('tenant-a');
    monitor.reset();
    expect(monitor.getJainIndex()).toBe(1);
    expect(monitor.getTenantShare('tenant-a')).toBe(0);
    expect(monitor.getActiveTenantIds()).toEqual([]);
  });

  describe('default singleton', () => {
    it('provides a default monitor that can be reset', () => {
      const m1 = getTenantFairnessMonitor();
      m1.recordCompletion('tenant-x');
      resetTenantFairnessMonitor();
      const m2 = getTenantFairnessMonitor();
      expect(m2).not.toBe(m1);
      expect(m2.getTenantShare('tenant-x')).toBe(0);
    });
  });
});
