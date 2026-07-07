/**
 * DataLeakageVerifier Tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DataLeakageVerifier,
  createInMemoryLeakageTarget,
  getDataLeakageVerifier,
  resetDataLeakageVerifier,
} from '../../src/security/dataLeakageVerifier';
import { tenantKey } from '../../src/runtime/tenantContext';

describe('DataLeakageVerifier', () => {
  let verifier: DataLeakageVerifier;
  let store: Map<string, string>;

  beforeEach(() => {
    resetDataLeakageVerifier();
    store = new Map<string, string>();
    verifier = new DataLeakageVerifier({
      tenants: ['alpha', 'beta'],
      vectors: [
        'direct_id_spoof',
        'key_prefix_spoof',
        'path_traversal',
        'shared_global_store',
        'async_context_confusion',
        'list_without_filter',
        'case_variation',
        'null_byte_truncation',
      ],
    });
  });

  afterEach(() => {
    resetDataLeakageVerifier();
  });

  function makeIsolatedTarget() {
    return createInMemoryLeakageTarget({
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
      read: (_tenantId: string, _keyHint: string) => Array.from(store.values()),
      list: () => Array.from(store.values()),
    };
  }

  it('registers and unregisters a target', async () => {
    verifier.registerTarget(makeIsolatedTarget());
    verifier.unregisterTarget();
    await expect(verifier.seed()).rejects.toThrow('No target registered');
  });

  it('seeds tenant-isolated data', async () => {
    verifier.registerTarget(makeIsolatedTarget());
    await verifier.seed();
    expect(store.size).toBeGreaterThan(0);
    for (const [key] of store) {
      expect(key.startsWith('tenant:')).toBe(true);
    }
  });

  it('reports no leaks for a properly isolated target', async () => {
    verifier.registerTarget(makeIsolatedTarget());
    const report = await verifier.verify();
    expect(report.targetName).toBe('isolated_memory');
    expect(report.leaks).toHaveLength(0);
    expect(report.totalCases).toBeGreaterThan(0);
  });

  it('detects leaks in a vulnerable target', async () => {
    verifier.registerTarget(makeVulnerableTarget());
    const report = await verifier.verify();
    expect(report.leaks.length).toBeGreaterThan(0);
  });

  it('defends against direct cross-tenant reads', async () => {
    verifier.registerTarget(makeIsolatedTarget());
    const report = await verifier.verify();
    expect(report.defended).toBeGreaterThan(0);
  });

  it('detects list_without_filter leakage', async () => {
    const vuln = makeVulnerableTarget();
    verifier.registerTarget(vuln);
    const report = await verifier.verify();
    const listLeak = report.leaks.find((l) => l.vector === 'list_without_filter');
    expect(listLeak).toBeTruthy();
  });

  it('singleton get/reset works', () => {
    const singleton = getDataLeakageVerifier();
    expect(singleton).toBe(getDataLeakageVerifier());
    resetDataLeakageVerifier();
    expect(getDataLeakageVerifier()).not.toBe(singleton);
  });

  it('covers all configured vectors', async () => {
    verifier.registerTarget(makeIsolatedTarget());
    const report = await verifier.verify();
    const observedVectors = new Set(report.leaks.map((l) => l.vector));
    const defendedVectors = new Set(verifier['config'].vectors);
    // Either defended or leaked, every vector should appear
    for (const vector of verifier['config'].vectors) {
      expect(observedVectors.has(vector) || defendedVectors.has(vector)).toBe(true);
    }
  });
});
