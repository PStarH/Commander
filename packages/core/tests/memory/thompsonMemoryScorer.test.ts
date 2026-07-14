import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ThompsonMemoryScorer,
  type ThompsonScorerConfig,
} from '../../src/memory/thompsonMemoryScorer';

describe('ThompsonMemoryScorer', () => {
  let scorer: ThompsonMemoryScorer;

  beforeEach(() => {
    scorer = new ThompsonMemoryScorer();
  });

  it('uses default config when none provided', () => {
    expect(scorer.size).toBe(0);
    expect(scorer.getMeanUsefulness('x')).toBe(0.5);
  });

  it('merges custom config', () => {
    const custom: Partial<ThompsonScorerConfig> = {
      priorAlpha: 2,
      evictionThreshold: 0.1,
      minRetrievalsForEviction: 5,
      surpriseWeight: 0.5,
    };
    const s = new ThompsonMemoryScorer(custom);
    s.updateUsefulness('m', true);
    expect(s.getStats('m')?.mean).toBe(3 / 4); // (2+1)/(2+1+1)=3/4
  });

  it('updateUsefulness creates new entry on first call', () => {
    scorer.updateUsefulness('mem-1', true);
    expect(scorer.size).toBe(1);
    expect(scorer.getTrackedIds()).toContain('mem-1');
  });

  it('updateUsefulness increments alpha on useful outcome', () => {
    scorer.updateUsefulness('mem-1', true);
    expect(scorer.getStats('mem-1')?.mean).toBe(2 / 3); // (1+1)/(1+1+1)
  });

  it('updateUsefulness increments beta on non-useful outcome', () => {
    scorer.updateUsefulness('mem-1', false);
    expect(scorer.getStats('mem-1')?.mean).toBe(1 / 3); // 1/(1+1+1)
  });

  it('updateUsefulness updates retrieval count and timestamp', () => {
    scorer.updateUsefulness('mem-1', true);
    scorer.updateUsefulness('mem-1', true);
    const stats = scorer.getStats('mem-1')!;
    expect(stats.retrievalCount).toBe(2);
    expect(stats.confidence).toBe(2 / 20);
  });

  it('sampleUsefulness returns 0.5 for untracked memory', () => {
    expect(scorer.sampleUsefulness('missing')).toBe(0.5);
  });

  it('sampleUsefulness returns a number between 0 and 1 for tracked memory', () => {
    scorer.updateUsefulness('mem-1', true);
    const sampled = scorer.sampleUsefulness('mem-1');
    expect(sampled).toBeGreaterThanOrEqual(0);
    expect(sampled).toBeLessThanOrEqual(1);
  });

  it('getMeanUsefulness returns 0.5 for untracked memory', () => {
    expect(scorer.getMeanUsefulness('missing')).toBe(0.5);
  });

  it('getMeanUsefulness reflects updated counts', () => {
    scorer.updateUsefulness('mem-1', true);
    scorer.updateUsefulness('mem-1', false);
    expect(scorer.getMeanUsefulness('mem-1')).toBe(2 / 4); // (1+1)/(1+1+1+1)
  });

  it('calculateSurprise is 0.5 for untracked memory', () => {
    expect(scorer.calculateSurprise('missing', true)).toBe(0.5);
  });

  it('calculateSurprise measures absolute difference from expected', () => {
    scorer.updateUsefulness('mem-1', true);
    scorer.updateUsefulness('mem-1', true);
    // mean = 3/4; actual true => |1 - 0.75| = 0.25
    expect(scorer.calculateSurprise('mem-1', true)).toBeCloseTo(0.25, 5);
    expect(scorer.calculateSurprise('mem-1', false)).toBeCloseTo(0.75, 5);
  });

  it('getSurpriseBoost scales surprise by config weight', () => {
    scorer.updateUsefulness('mem-1', true);
    const surprise = scorer.calculateSurprise('mem-1', false);
    expect(scorer.getSurpriseBoost('mem-1', false)).toBe(surprise * 0.3);
  });

  it('getEvictionCandidates returns empty when no memories exist', () => {
    expect(scorer.getEvictionCandidates()).toEqual([]);
  });

  it('getEvictionCandidates respects threshold and min retrievals', () => {
    for (let i = 0; i < 10; i++) {
      scorer.updateUsefulness('bad', false);
    }
    for (let i = 0; i < 10; i++) {
      scorer.updateUsefulness('good', true);
    }
    const candidates = scorer.getEvictionCandidates();
    expect(candidates).toContain('bad');
    expect(candidates).not.toContain('good');
  });

  it('getEvictionCandidates ignores low retrieval counts', () => {
    scorer.updateUsefulness('bad', false);
    expect(scorer.getEvictionCandidates()).toEqual([]);
  });

  it('getStats returns null for untracked memory', () => {
    expect(scorer.getStats('missing')).toBeNull();
  });

  it('getStats returns correct statistics', () => {
    scorer.updateUsefulness('mem-1', true);
    const stats = scorer.getStats('mem-1')!;
    expect(stats.mean).toBe(2 / 3);
    expect(stats.variance).toBeCloseTo((2 * 1) / (3 ** 2 * 4), 5);
    expect(stats.retrievalCount).toBe(1);
    expect(stats.confidence).toBe(1 / 20);
  });

  it('getStats caps confidence at 1', () => {
    for (let i = 0; i < 25; i++) {
      scorer.updateUsefulness('mem-1', true);
    }
    expect(scorer.getStats('mem-1')?.confidence).toBe(1);
  });

  it('remove deletes a tracked memory', () => {
    scorer.updateUsefulness('mem-1', true);
    expect(scorer.remove('mem-1')).toBe(true);
    expect(scorer.size).toBe(0);
  });

  it('remove returns false for untracked memory', () => {
    expect(scorer.remove('missing')).toBe(false);
  });

  it('clear removes all memories', () => {
    scorer.updateUsefulness('mem-1', true);
    scorer.updateUsefulness('mem-2', false);
    scorer.clear();
    expect(scorer.size).toBe(0);
    expect(scorer.getTrackedIds()).toEqual([]);
  });

  it('toJSON/fromJSON round-trips data', () => {
    scorer.updateUsefulness('mem-1', true);
    scorer.updateUsefulness('mem-2', false);
    const json = scorer.toJSON();
    const restored = new ThompsonMemoryScorer();
    restored.fromJSON(json);
    expect(restored.size).toBe(2);
    expect(restored.getStats('mem-1')?.retrievalCount).toBe(1);
    expect(restored.getStats('mem-2')?.mean).toBeCloseTo(1 / 3, 5);
  });

  it('fromJSON overwrites existing data', () => {
    scorer.updateUsefulness('old', true);
    scorer.fromJSON({
      new: { alpha: 5, beta: 1, lastUpdated: 1, retrievalCount: 3 },
    });
    expect(scorer.size).toBe(1);
    expect(scorer.getTrackedIds()).toContain('new');
  });

  it('beta/gamma sampling is deterministic with seeded random', () => {
    const s1 = new ThompsonMemoryScorer();
    const s2 = new ThompsonMemoryScorer();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    s1.updateUsefulness('mem-1', true);
    s2.updateUsefulness('mem-1', true);
    expect(s1.sampleUsefulness('mem-1')).toBe(s2.sampleUsefulness('mem-1'));
    randomSpy.mockRestore();
  });

  it('handles many updates without error', () => {
    for (let i = 0; i < 100; i++) {
      scorer.updateUsefulness('mem-1', i % 3 !== 0);
    }
    const stats = scorer.getStats('mem-1')!;
    expect(stats.retrievalCount).toBe(100);
    expect(stats.confidence).toBe(1);
    expect(stats.mean).toBeGreaterThan(0);
    expect(stats.mean).toBeLessThan(1);
  });
});
