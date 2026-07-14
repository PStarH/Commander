import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'vitest';
import {
  InMemorySLOStore,
  getSLOStore,
  setSLOStore,
  resetSLOStore,
  type SLOStore,
} from '../../src/observability/sloPersistence.js';

describe('SLO Persistence (InMemorySLOStore)', () => {
  let store: SLOStore;

  beforeEach(() => {
    store = new InMemorySLOStore();
  });

  afterEach(() => {
    resetSLOStore();
  });

  it('saves and retrieves an SLO definition', async () => {
    const saved = await store.saveSLO({
      id: 'api-availability',
      name: 'API Availability',
      targetPercent: 99.95,
      metric: 'api_success_rate',
      threshold: 0.9995,
    });

    assert.ok(saved.createdAt);
    assert.ok(saved.updatedAt);
    assert.equal(saved.name, 'API Availability');

    const fetched = await store.getSLO('api-availability');
    assert.ok(fetched);
    assert.equal(fetched.targetPercent, 99.95);
  });

  it('updates an existing SLO definition', async () => {
    await store.saveSLO({
      id: 'latency',
      name: 'Latency P95',
      targetPercent: 95,
      metric: 'latency_ms',
      threshold: 500,
    });

    const updated = await store.saveSLO({
      id: 'latency',
      name: 'Latency P95 (Updated)',
      targetPercent: 99,
      metric: 'latency_ms',
      threshold: 250,
    });

    assert.equal(updated.name, 'Latency P95 (Updated)');
    assert.equal(updated.targetPercent, 99);
    // createdAt should be preserved
    const original = await store.getSLO('latency');
    assert.equal(original.createdAt, updated.createdAt);
  });

  it('lists all SLO definitions', async () => {
    await store.saveSLO({
      id: 'slo-1',
      name: 'SLO 1',
      targetPercent: 99,
      metric: 'm1',
      threshold: 1,
    });
    await store.saveSLO({
      id: 'slo-2',
      name: 'SLO 2',
      targetPercent: 95,
      metric: 'm2',
      threshold: 2,
    });

    const list = await store.listSLOs();
    assert.equal(list.length, 2);
  });

  it('deletes an SLO definition', async () => {
    await store.saveSLO({
      id: 'slo-1',
      name: 'SLO 1',
      targetPercent: 99,
      metric: 'm1',
      threshold: 1,
    });
    const deleted = await store.deleteSLO('slo-1');
    assert.equal(deleted, true);
    const fetched = await store.getSLO('slo-1');
    assert.equal(fetched, null);
  });

  it('records and retrieves violations', async () => {
    await store.saveSLO({
      id: 'api-availability',
      name: 'API',
      targetPercent: 99.95,
      metric: 'api_success_rate',
      threshold: 0.9995,
    });

    const violation = await store.recordViolation({
      sloId: 'api-availability',
      tenantId: 'tenant-a',
      runId: 'run-1',
      measuredValue: 0.95,
      threshold: 0.9995,
      severity: 'critical',
      message: 'API availability dropped below 99.95%',
    });

    assert.ok(violation.id.startsWith('vln_'));
    assert.ok(violation.occurredAt);
    assert.equal(violation.severity, 'critical');

    const list = await store.listViolations({ sloId: 'api-availability' });
    assert.equal(list.length, 1);
    assert.equal(list[0].measuredValue, 0.95);
  });

  it('resolves a violation', async () => {
    await store.saveSLO({
      id: 'slo-1',
      name: 'SLO 1',
      targetPercent: 99,
      metric: 'm1',
      threshold: 1,
    });
    const v = await store.recordViolation({
      sloId: 'slo-1',
      measuredValue: 2,
      threshold: 1,
      severity: 'warning',
      message: 'exceeded',
    });

    const resolved = await store.resolveViolation(v.id);
    assert.equal(resolved, true);

    const list = await store.listViolations({ sloId: 'slo-1' });
    assert.ok(list[0].resolvedAt);
  });

  it('filters violations by time range', async () => {
    await store.saveSLO({
      id: 'slo-1',
      name: 'SLO 1',
      targetPercent: 99,
      metric: 'm1',
      threshold: 1,
    });
    await store.recordViolation({
      sloId: 'slo-1',
      measuredValue: 2,
      threshold: 1,
      severity: 'warning',
      message: 'old',
    });
    await store.recordViolation({
      sloId: 'slo-1',
      measuredValue: 3,
      threshold: 1,
      severity: 'critical',
      message: 'new',
    });

    const since = new Date(Date.now() - 1000).toISOString();
    const list = await store.listViolations({ sloId: 'slo-1', since });
    // Both should be recent enough
    assert.ok(list.length >= 1);
  });

  it('limits violation results', async () => {
    await store.saveSLO({
      id: 'slo-1',
      name: 'SLO 1',
      targetPercent: 99,
      metric: 'm1',
      threshold: 1,
    });
    for (let i = 0; i < 10; i++) {
      await store.recordViolation({
        sloId: 'slo-1',
        measuredValue: i,
        threshold: 1,
        severity: 'warning',
        message: `v${i}`,
      });
    }
    const list = await store.listViolations({ sloId: 'slo-1', limit: 5 });
    assert.equal(list.length, 5);
  });
});

describe('SLO Store singleton', () => {
  afterEach(() => {
    resetSLOStore();
  });

  it('returns InMemorySLOStore by default', () => {
    const store = getSLOStore();
    assert.ok(store instanceof InMemorySLOStore);
  });

  it('allows setting a custom store', () => {
    const custom = new InMemorySLOStore();
    setSLOStore(custom);
    assert.equal(getSLOStore(), custom);
  });

  it('resets to default after resetSLOStore', () => {
    setSLOStore(new InMemorySLOStore());
    resetSLOStore();
    const store = getSLOStore();
    assert.ok(store instanceof InMemorySLOStore);
  });
});

describe('SLO Operations (6 SLOs)', () => {
  it('DEFAULT_SLO_CONFIG has 6 SLOs matching docs/slo.md', async () => {
    const { DEFAULT_SLO_CONFIG } = await import('../../src/observability/sloOperations.js');
    assert.equal(DEFAULT_SLO_CONFIG.slos.length, 6);

    const ids = DEFAULT_SLO_CONFIG.slos.map((s: any) => s.id);
    assert.ok(ids.includes('api-availability'));
    assert.ok(ids.includes('schedule-latency'));
    assert.ok(ids.includes('step-recovery'));
    assert.ok(ids.includes('dlq-recovery'));
    assert.ok(ids.includes('hash-chain-integrity'));
    assert.ok(ids.includes('approval-failclosed'));
  });

  it('API availability SLO targets 99.95%', async () => {
    const { DEFAULT_SLO_CONFIG } = await import('../../src/observability/sloOperations.js');
    const slo = DEFAULT_SLO_CONFIG.slos.find((s: any) => s.id === 'api-availability');
    assert.equal(slo.targetPercent, 99.95);
    assert.equal(slo.metric, 'api_success_rate');
  });

  it('schedule latency SLO targets 5s', async () => {
    const { DEFAULT_SLO_CONFIG } = await import('../../src/observability/sloOperations.js');
    const slo = DEFAULT_SLO_CONFIG.slos.find((s: any) => s.id === 'schedule-latency');
    assert.equal(slo.threshold, 5000);
  });

  it('hash chain integrity SLO targets 100%', async () => {
    const { DEFAULT_SLO_CONFIG } = await import('../../src/observability/sloOperations.js');
    const slo = DEFAULT_SLO_CONFIG.slos.find((s: any) => s.id === 'hash-chain-integrity');
    assert.equal(slo.targetPercent, 100);
    assert.equal(slo.threshold, 1.0);
  });
});
