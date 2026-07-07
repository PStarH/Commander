/**
 * CrossTenantFuzzTest Tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CrossTenantFuzzTest,
  createInMemoryCrossTenantTarget,
  getCrossTenantFuzzTest,
  resetCrossTenantFuzzTest,
} from '../../src/security/crossTenantFuzz';
import { tenantKey } from '../../src/runtime/tenantContext';

describe('CrossTenantFuzzTest', () => {
  let fuzz: CrossTenantFuzzTest;
  let store: Map<string, string>;

  beforeEach(() => {
    resetCrossTenantFuzzTest();
    store = new Map<string, string>();
    fuzz = new CrossTenantFuzzTest({
      maxMutations: 200,
      victimTenants: ['victim-a', 'victim-b'],
      attackerTenants: ['attacker-x'],
    });
  });

  afterEach(() => {
    resetCrossTenantFuzzTest();
  });

  function makeIsolatedTarget() {
    return createInMemoryCrossTenantTarget({
      name: 'isolated_memory',
      store,
      seedValue: (tenantId) => `${tenantId}-secret-${Math.random().toString(36).slice(2, 8)}`,
      valueToString: (value) => String(value),
    });
  }

  function makeVulnerableTarget() {
    return {
      name: 'vulnerable_memory',
      seedData: (tenantId: string) => [
        { key: 'secret', value: `${tenantId}-secret-${Math.random().toString(36).slice(2, 8)}` },
      ],
      keyExtractor: (item: { key: string; value: string }) => item.key,
      valueExtractor: (item: { key: string; value: string }) => item.value,
      write: (tenantId: string, item: { key: string; value: string }) => {
        // Vulnerable: stores with tenant-prefixed raw key but never enforces context
        store.set(`${tenantId}:${item.key}`, item.value);
      },
      read: (_tenantId: string, _keyHint: string) => {
        // Vulnerable: returns all stored values regardless of tenant scoping
        return Array.from(store.values());
      },
    };
  }

  it('registers and unregisters a target', async () => {
    fuzz.registerTarget(makeIsolatedTarget());
    fuzz.unregisterTarget();
    await expect(fuzz.seed()).rejects.toThrow('No target registered');
  });

  it('seeds tenant-isolated data', async () => {
    fuzz.registerTarget(makeIsolatedTarget());
    await fuzz.seed();
    expect(store.size).toBeGreaterThan(0);
    for (const [key] of store) {
      expect(key.startsWith('tenant:')).toBe(true);
    }
  });

  it('reports no leaks for a properly isolated target', async () => {
    fuzz.registerTarget(makeIsolatedTarget());
    const report = await fuzz.run();
    expect(report.targetName).toBe('isolated_memory');
    expect(report.leaks).toHaveLength(0);
    expect(report.totalCases).toBeGreaterThan(0);
  });

  it('detects leaks in a vulnerable target', async () => {
    fuzz.registerTarget(makeVulnerableTarget());
    const report = await fuzz.run();
    expect(report.leaks.length).toBeGreaterThan(0);
  });

  it('defends against invalid tenant ids', async () => {
    fuzz.registerTarget(makeIsolatedTarget());
    const report = await fuzz.run();
    const defended = report.defended;
    expect(defended).toBeGreaterThan(0);
  });

  it('singleton get/reset works', () => {
    const singleton = getCrossTenantFuzzTest();
    expect(singleton).toBe(getCrossTenantFuzzTest());
    resetCrossTenantFuzzTest();
    expect(getCrossTenantFuzzTest()).not.toBe(singleton);
  });

  it('includes all configured attack vectors', async () => {
    fuzz.registerTarget(makeIsolatedTarget());
    const report = await fuzz.run();
    expect(report.totalCases).toBeGreaterThanOrEqual(
      fuzz['config'].vectors.length *
        fuzz['config'].victimTenants.length *
        fuzz['config'].attackerTenants.length,
    );
  });
});
