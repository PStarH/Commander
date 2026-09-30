/**
 * Regression tests for memory-subsystem audit findings.
 *
 * Covers three defects re-derived from the 2026-09-10 audit corpus:
 *  - `proceduralStore.select` operator precedence bypassing `minSuccessRate`
 *  - `reflexionLoop` reporting a rising success rate as 'declining'
 *  - `BM25Scorer.addDocument` inflating index statistics on a duplicate id
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ProceduralMemoryStore } from '../../src/memory/proceduralStore';
import { ReflexionLoop } from '../../src/memory/reflexionLoop';
import { BM25Scorer } from '../../src/memory/ftsScorer';
import type { MemoryStore } from '../../src/episodicMemory';

function entry(id: string, successRate: number, conditions: string[] = ['deploy']) {
  return {
    id,
    content: `rule ${id}`,
    title: `rule ${id}`,
    meta: {
      proceduralType: 'sop',
      successRate,
      usageCount: 10,
      conditions,
      goal: 'deploy service',
      action: 'run the deploy step',
    },
  };
}

function fakeStore(items: ReturnType<typeof entry>[]): MemoryStore {
  return {
    searchSemantic: async () => items,
  } as unknown as MemoryStore;
}

describe('ProceduralMemoryStore.select minSuccessRate', () => {
  it('rejects entries below the requested success-rate threshold', async () => {
    const store = new ProceduralMemoryStore(
      fakeStore([entry('low', 0.1), entry('high', 0.95)]),
      'project-a',
    );

    const selected = await store.select({
      context: 'deploy',
      minSuccessRate: 0.9,
    });

    assert.deepEqual(
      selected.map((e) => e.id),
      ['high'],
    );
  });

  it('treats a non-finite stored success rate as unmeasured (never passing a threshold)', async () => {
    const store = new ProceduralMemoryStore(
      fakeStore([entry('nan', Number.NaN), entry('high', 0.95)]),
      'project-a',
    );

    const selected = await store.select({ context: 'deploy', minSuccessRate: 0.5 });
    assert.deepEqual(
      selected.map((e) => e.id),
      ['high'],
    );
  });
});

describe('ReflexionLoop.getImprovements trend direction', () => {
  function reflect(loop: ReflexionLoop, success: boolean, latencyMs: number): void {
    loop.recordOutcome({ success, task: 't', latencyMs, tokenCost: 100 }, {
      insight: 'x',
      action: 'y',
    } as never);
  }

  it('reports a rising success rate as improving, not declining', () => {
    const loop = new ReflexionLoop();
    // First half fails, second half succeeds.
    reflect(loop, false, 100);
    reflect(loop, false, 100);
    reflect(loop, true, 10);
    reflect(loop, true, 10);

    const trend = loop.getImprovements()[0];
    assert.equal(trend.successRateTrend, 'improving');
    assert.equal(trend.latencyTrend, 'improving');
  });

  it('reports a falling success rate as declining', () => {
    const loop = new ReflexionLoop();
    reflect(loop, true, 10);
    reflect(loop, true, 10);
    reflect(loop, false, 100);
    reflect(loop, false, 100);

    const trend = loop.getImprovements()[0];
    assert.equal(trend.successRateTrend, 'declining');
    assert.equal(trend.latencyTrend, 'declining');
  });
});

describe('BM25Scorer.addDocument duplicate ids', () => {
  it('does not inflate document count or term statistics on re-add', () => {
    const scorer = new BM25Scorer();
    scorer.addDocument('doc-1', 'alpha beta gamma');
    const afterFirst = scorer.getStats();

    scorer.addDocument('doc-1', 'alpha beta gamma');
    const afterSecond = scorer.getStats();

    assert.equal(afterSecond.documents, afterFirst.documents);
    assert.equal(afterSecond.terms, afterFirst.terms);
    assert.equal(afterSecond.avgDocLength, afterFirst.avgDocLength);
  });

  it('returns the index to empty after removing the (re-added) document', () => {
    const scorer = new BM25Scorer();
    scorer.addDocument('doc-1', 'alpha beta gamma');
    scorer.addDocument('doc-1', 'delta epsilon');
    scorer.removeDocument('doc-1');

    const stats = scorer.getStats();
    assert.equal(stats.documents, 0);
    assert.equal(stats.terms, 0);
    assert.equal(stats.avgDocLength, 0);
  });
});
