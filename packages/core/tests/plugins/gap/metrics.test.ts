// packages/core/tests/plugins/gap/metrics.test.ts
import { describe, it, expect } from 'vitest';
import { computeMetrics } from '../../../src/plugins/builtin/gap/metrics';
import { GapEntry } from '../../../src/plugins/builtin/gap/types';

function makeEntry(overrides: Partial<GapEntry> = {}): GapEntry {
  return {
    id: 'g1',
    source: 'chaos',
    severity: 'high',
    title: 't',
    description: 'd',
    detectedAt: '2026-06-30T00:00:00Z',
    status: 'open',
    relatedIssues: [],
    slaDeadline: '2026-07-07T00:00:00Z',
    ...overrides,
  };
}

describe('metrics', () => {
  it('counts open and overdue correctly', () => {
    const entries = [
      makeEntry({ id: 'a', status: 'open', slaDeadline: '2020-01-01' }),
      makeEntry({ id: 'b', status: 'open', slaDeadline: '2030-01-01' }),
      makeEntry({
        id: 'c',
        status: 'fixed',
        closedAt: '2026-06-15T00:00:00Z',
        slaDeadline: '2020-01-01',
      }),
    ];
    const m = computeMetrics(entries, new Date('2026-06-30T12:00:00Z'));
    expect(m.open).toBe(2);
    expect(m.overdueRepair).toBe(1);
    expect(m.bySource['chaos']).toBe(3);
  });

  it('computes avg time to fix in days', () => {
    const entries = [
      makeEntry({
        status: 'fixed',
        detectedAt: '2026-06-01T00:00:00Z',
        closedAt: '2026-06-11T00:00:00Z',
      }),
      makeEntry({
        status: 'fixed',
        detectedAt: '2026-06-05T00:00:00Z',
        closedAt: '2026-06-12T00:00:00Z',
      }),
    ];
    const m = computeMetrics(entries);
    expect(m.avgTimeToFixDays).toBeCloseTo(8.5, 0);
  });
});
