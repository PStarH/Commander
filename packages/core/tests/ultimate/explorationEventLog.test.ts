import { describe, it, expect } from 'vitest';
import { ExplorationEventLog } from '../../src/ultimate/explorationEventLog';
import type { OrchestrationTopology } from '../../src/ultimate/types';

function makeEvent(
  overrides: Partial<{
    tenantId: string;
    taskType: string;
    chosenTopology: OrchestrationTopology;
    argmaxTopology: OrchestrationTopology;
    diverged: boolean;
    epsilon: number;
    topCandidates: Array<{ topology: OrchestrationTopology; score: number }>;
    runId: string;
    agentId: string;
    coordinationOverride: boolean;
    finalTopology: OrchestrationTopology;
  }> = {},
): Parameters<ExplorationEventLog['record']>[0] {
  return {
    tenantId: overrides.tenantId ?? 'tenant-A',
    taskType: overrides.taskType ?? 'CODING',
    chosenTopology: overrides.chosenTopology ?? 'PARALLEL',
    argmaxTopology: overrides.argmaxTopology ?? 'SEQUENTIAL',
    diverged: overrides.diverged ?? false,
    epsilon: overrides.epsilon ?? 0.05,
    topCandidates: overrides.topCandidates ?? [
      { topology: 'PARALLEL', score: 5 },
      { topology: 'SEQUENTIAL', score: 4 },
    ],
    ...(overrides.runId !== undefined ? { runId: overrides.runId } : {}),
    ...(overrides.agentId !== undefined ? { agentId: overrides.agentId } : {}),
    ...(overrides.coordinationOverride !== undefined
      ? { coordinationOverride: overrides.coordinationOverride }
      : {}),
    ...(overrides.finalTopology !== undefined ? { finalTopology: overrides.finalTopology } : {}),
  };
}

describe('ExplorationEventLog', () => {
  it('records events and reflects totals', () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent());
    log.record(makeEvent({ diverged: true, chosenTopology: 'HIERARCHICAL' }));
    log.record(makeEvent({ tenantId: 'tenant-B' }));

    const snap = log.getSnapshot();
    expect(snap.totals.routingCount).toBe(3);
    expect(snap.totals.explorationCount).toBe(1);
    expect(snap.totals.divergenceCount).toBe(1);
    expect(snap.globalStats.lifetimeRoutingCount).toBe(3);
    expect(snap.globalStats.ringBufferSize).toBe(3);
    expect(snap.globalStats.lifetimeOverflowCount).toBe(0);
  });

  it('evicts oldest events when ring is full (overflowCount increments)', () => {
    const log = new ExplorationEventLog(3);
    for (let i = 0; i < 5; i++) {
      log.record(makeEvent({ runId: `r${i}` }));
    }
    const snap = log.getSnapshot();
    expect(snap.globalStats.lifetimeRoutingCount).toBe(5);
    expect(snap.globalStats.ringBufferSize).toBe(3);
    expect(snap.globalStats.lifetimeOverflowCount).toBe(2);
    expect(snap.recentEvents.map((e) => e.runId)).toEqual(['r2', 'r3', 'r4']);
    expect(snap.globalStats.lifetimeOverflowCount > 0).toBe(true);
  });

  it('truncated is false when no filter and ring holds everything', () => {
    const log = new ExplorationEventLog(100);
    for (let i = 0; i < 3; i++) log.record(makeEvent());
    const snap = log.getSnapshot();
    expect(snap.truncated).toBe(false);
  });

  it('truncated is true when filter excludes events in the ring', () => {
    const log = new ExplorationEventLog(100);
    log.record(makeEvent({ tenantId: 'A' }));
    log.record(makeEvent({ tenantId: 'B' }));
    const snap = log.getSnapshot({ tenantId: 'A' });
    expect(snap.truncated).toBe(true);
    expect(snap.recentEvents).toHaveLength(1);
  });

  it('rejects non-positive capacity by falling back to default', () => {
    const log = new ExplorationEventLog(0);
    expect(log.capacity()).toBe(1000);
    log.record(makeEvent());
    expect(log.size()).toBe(1);
  });

  it('filters events by tenantId', () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ tenantId: 'tenant-A' }));
    log.record(makeEvent({ tenantId: 'tenant-B' }));
    log.record(makeEvent({ tenantId: 'tenant-A' }));

    const aSnap = log.getSnapshot({ tenantId: 'tenant-A' });
    expect(aSnap.recentEvents).toHaveLength(2);
    expect(aSnap.tenants).toHaveLength(1);
    expect(aSnap.tenants[0]?.tenantId).toBe('tenant-A');
    expect(aSnap.tenants[0]?.routingCount).toBe(2);
    // Privacy: totals scoped to the filter tenant
    expect(aSnap.totals.routingCount).toBe(2);
    expect(aSnap.globalStats.lifetimeRoutingCount).toBe(3);

    const bSnap = log.getSnapshot({ tenantId: 'tenant-B' });
    expect(bSnap.recentEvents).toHaveLength(1);
    expect(bSnap.tenants[0]?.routingCount).toBe(1);
  });

  it('rejects unknown tenant query that has no recorded events', () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ tenantId: 'tenant-A' }));
    const snap = log.getSnapshot({ tenantId: 'tenant-NONE' });
    expect(snap.recentEvents).toHaveLength(0);
    expect(snap.tenants).toHaveLength(0);
  });

  it('filters events by since timestamp', async () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ runId: 'old' }));
    await new Promise((r) => setTimeout(r, 20));
    const sinceIso = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    log.record(makeEvent({ runId: 'new' }));

    const snap = log.getSnapshot({ since: sinceIso });
    expect(snap.recentEvents).toHaveLength(1);
    expect(snap.recentEvents[0]?.runId).toBe('new');
  });

  it('caps recentEvents to limit (newest tail)', () => {
    const log = new ExplorationEventLog();
    for (let i = 0; i < 10; i++) {
      log.record(makeEvent({ runId: `e${i}` }));
    }
    const snap = log.getSnapshot({ limit: 3 });
    expect(snap.recentEvents).toHaveLength(3);
    expect(snap.recentEvents.map((e) => e.runId)).toEqual(['e7', 'e8', 'e9']);
  });

  it('clamps limit to MAX_LIMIT=1000 and floor of 1', () => {
    const log = new ExplorationEventLog();
    for (let i = 0; i < 3; i++) log.record(makeEvent());
    const lowSnap = log.getSnapshot({ limit: 0 });
    expect(lowSnap.recentEvents).toHaveLength(1); // floor 1
    const highSnap = log.getSnapshot({ limit: 999_999 });
    expect(highSnap.recentEvents).toHaveLength(3); // cap 1000, all 3 fit
  });

  it('filters events by divergedOnly=true', () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ diverged: false, runId: 'a' }));
    log.record(makeEvent({ diverged: true, runId: 'b' }));
    log.record(makeEvent({ diverged: false, runId: 'c' }));
    log.record(makeEvent({ diverged: true, runId: 'd' }));

    const snap = log.getSnapshot({ divergedOnly: true });
    expect(snap.recentEvents.map((e) => e.runId)).toEqual(['b', 'd']);
  });

  it('builds sign-preserving divergence histogram from biased-score margins', () => {
    const log = new ExplorationEventLog();
    // Event 1: margin = +9 (argmax much higher → '>2.0')
    log.record(
      makeEvent({
        chosenTopology: 'PARALLEL',
        argmaxTopology: 'SEQUENTIAL',
        diverged: true,
        topCandidates: [
          { topology: 'SEQUENTIAL', score: 10 },
          { topology: 'PARALLEL', score: 1 },
        ],
      }),
    );
    // Event 2: margin = 0 (tied) → 'same'
    log.record(
      makeEvent({
        chosenTopology: 'HIERARCHICAL',
        argmaxTopology: 'HIERARCHICAL',
        diverged: false,
        topCandidates: [
          { topology: 'HIERARCHICAL', score: 7 },
          { topology: 'PARALLEL', score: 7 },
        ],
      }),
    );
    // Event 3: margin = -0.3 (chosen scored higher) → 'chosen_higher'
    log.record(
      makeEvent({
        chosenTopology: 'PARALLEL',
        argmaxTopology: 'SEQUENTIAL',
        diverged: true,
        topCandidates: [
          { topology: 'SEQUENTIAL', score: 5 },
          { topology: 'PARALLEL', score: 5.3 },
        ],
      }),
    );
    // Event 4: margin = +1.5 → '1.0-2.0'
    log.record(
      makeEvent({
        chosenTopology: 'PARALLEL',
        argmaxTopology: 'SEQUENTIAL',
        diverged: true,
        topCandidates: [
          { topology: 'SEQUENTIAL', score: 8 },
          { topology: 'PARALLEL', score: 6.5 },
        ],
      }),
    );

    const snap = log.getSnapshot();
    const byBucket = Object.fromEntries(
      snap.divergenceHistogram.map((b) => [b.marginBucket, b.count]),
    );
    expect(byBucket['>2.0']).toBe(1);
    expect(byBucket['same']).toBe(1);
    expect(byBucket['chosen_higher']).toBe(1);
    expect(byBucket['1.0-2.0']).toBe(1);
    expect(byBucket['<0.5']).toBe(0);
    expect(byBucket['0.5-1.0']).toBe(0);
  });

  it('histogram always emits all 6 buckets even when empty', () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent());
    const snap = log.getSnapshot();
    expect(snap.divergenceHistogram).toHaveLength(6);
    expect(snap.divergenceHistogram.map((b) => b.marginBucket)).toEqual([
      'same',
      'chosen_higher',
      '<0.5',
      '0.5-1.0',
      '1.0-2.0',
      '>2.0',
    ]);
  });

  it('totals are filter-aware (privacy: tenant-A cant see tenant-B volume)', () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ tenantId: 'A' }));
    log.record(makeEvent({ tenantId: 'B' }));
    log.record(makeEvent({ tenantId: 'A', diverged: true }));

    const aSnap = log.getSnapshot({ tenantId: 'A' });
    expect(aSnap.totals.routingCount).toBe(2); // filter-aware
    expect(aSnap.globalStats.lifetimeRoutingCount).toBe(3); // process-lifetime
    expect(aSnap.tenants).toHaveLength(1);
  });

  it('per-tenant rates are computed correctly', () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ tenantId: 'A' }));
    log.record(makeEvent({ tenantId: 'A' }));
    log.record(makeEvent({ tenantId: 'A', diverged: true }));
    log.record(makeEvent({ tenantId: 'B' }));

    const snap = log.getSnapshot();
    const a = snap.tenants.find((t) => t.tenantId === 'A')!;
    const b = snap.tenants.find((t) => t.tenantId === 'B')!;
    expect(a.routingCount).toBe(3);
    expect(a.explorationCount).toBe(1);
    expect(a.divergenceCount).toBe(1);
    expect(a.explorationRate).toBeCloseTo(1 / 3);
    expect(a.divergenceRate).toBeCloseTo(1 / 3);
    expect(b.routingCount).toBe(1);
    expect(b.explorationRate).toBe(0);
  });

  it('tracks coordinationOverride count', () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ coordinationOverride: true, finalTopology: 'SINGLE' }));
    log.record(makeEvent({ coordinationOverride: false }));
    log.record(makeEvent({ coordinationOverride: true, finalTopology: 'SINGLE' }));
    const snap = log.getSnapshot();
    expect(snap.totals.coordinationOverrideCount).toBe(2);
    expect(snap.recentEvents[0]?.coordinationOverride).toBe(true);
    expect(snap.recentEvents[0]?.finalTopology).toBe('SINGLE');
    expect(snap.recentEvents[1]?.coordinationOverride).toBe(false);
  });

  it('updateFinalTopology sets the final topology and flag', () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ runId: 'r1' }));
    const ev = log.getSnapshot().recentEvents[0]!;
    const updated = log.updateFinalTopology(ev.eventId, 'SINGLE');
    expect(updated).toBe(true);
    const after = log.getSnapshot().recentEvents[0]!;
    expect(after.finalTopology).toBe('SINGLE');
    expect(after.coordinationOverride).toBe(true);
    expect(log.getSnapshot().totals.coordinationOverrideCount).toBe(1);
  });

  it('updateFinalTopology is a no-op for evicted events', () => {
    const log = new ExplorationEventLog(1);
    const r1 = log.record(makeEvent({ runId: 'r1' }));
    log.record(makeEvent({ runId: 'r2' })); // evicts r1
    const updated = log.updateFinalTopology(r1.eventId, 'SINGLE');
    expect(updated).toBe(false);
  });

  it('record() returns the assigned eventId and timestamp', () => {
    const log = new ExplorationEventLog();
    const r1 = log.record(makeEvent({ runId: 'r1' }));
    const r2 = log.record(makeEvent({ runId: 'r2' }));
    expect(r1.eventId).toBe(1);
    expect(r2.eventId).toBe(2);
    expect(r1.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r2.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r1.eventId).toBeLessThan(r2.eventId);
  });

  it('eventId is monotonically increasing and unique even with rapid inserts', async () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ runId: 'a' }));
    log.record(makeEvent({ runId: 'b' }));
    log.record(makeEvent({ runId: 'c' }));
    const events = log.getSnapshot().recentEvents;
    const ids = events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBeLessThan(ids[1]!);
    expect(ids[1]).toBeLessThan(ids[2]!);
  });

  it('findLatestByRunId returns the most recent event for a runId', () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ runId: 'r1', chosenTopology: 'PARALLEL' }));
    log.record(makeEvent({ runId: 'r2', chosenTopology: 'SEQUENTIAL' }));
    log.record(makeEvent({ runId: 'r1', chosenTopology: 'HIERARCHICAL' }));
    const latest = log.findLatestByRunId('r1');
    expect(latest?.chosenTopology).toBe('HIERARCHICAL');
    const missing = log.findLatestByRunId('nonexistent');
    expect(missing).toBeUndefined();
  });

  it('default finalTopology equals chosenTopology when not specified', () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ chosenTopology: 'PARALLEL' }));
    const ev = log.getSnapshot().recentEvents[0]!;
    expect(ev.finalTopology).toBe('PARALLEL');
    expect(ev.coordinationOverride).toBe(false);
  });

  it('reset() clears all state including per-tenant aggregates and coordination count', () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ tenantId: 'A' }));
    log.record(makeEvent({ tenantId: 'B', diverged: true, coordinationOverride: true }));
    log.reset();
    const snap = log.getSnapshot();
    expect(snap.globalStats.lifetimeRoutingCount).toBe(0);
    expect(snap.globalStats.lifetimeOverflowCount).toBe(0);
    expect(snap.totals.coordinationOverrideCount).toBe(0);
    expect(snap.tenants).toHaveLength(0);
    expect(snap.recentEvents).toHaveLength(0);
  });

  it('size() and capacity() expose the current state', () => {
    const log = new ExplorationEventLog(50);
    expect(log.capacity()).toBe(50);
    expect(log.size()).toBe(0);
    log.record(makeEvent());
    log.record(makeEvent());
    expect(log.size()).toBe(2);
  });

  it('records a timestamp on every event', async () => {
    const log = new ExplorationEventLog();
    const before = Date.now();
    log.record(makeEvent());
    const snap = log.getSnapshot();
    const ts = Date.parse(snap.recentEvents[0]!.timestamp);
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('handles missing topCandidates without throwing', () => {
    const log = new ExplorationEventLog();
    const ev = makeEvent();
    log.record({ ...ev, topCandidates: [] });
    const snap = log.getSnapshot();
    expect(snap.recentEvents).toHaveLength(1);
    expect(snap.divergenceHistogram.every((b) => b.count >= 0)).toBe(true);
  });

  it('sorts tenants by routingCount desc', () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ tenantId: 'small' }));
    for (let i = 0; i < 5; i++) log.record(makeEvent({ tenantId: 'big' }));
    for (let i = 0; i < 3; i++) log.record(makeEvent({ tenantId: 'medium' }));
    const snap = log.getSnapshot();
    expect(snap.tenants.map((t) => t.tenantId)).toEqual(['big', 'medium', 'small']);
  });
});
