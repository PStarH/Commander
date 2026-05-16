import { describe, it, expect, beforeEach } from 'vitest';
import {
  PatternTracker,
  resetPatternTracker,
  getPatternTracker,
  planSpeculativeExecution,
  isSpeculativelySafe,
} from '../../src/runtime/speculativeExecutor';

describe('SpeculativeExecutor - isSpeculativelySafe', () => {
  it('returns true for read-only tools', () => {
    expect(isSpeculativelySafe('web_search')).toBe(true);
    expect(isSpeculativelySafe('file_read')).toBe(true);
    expect(isSpeculativelySafe('memory_recall')).toBe(true);
  });

  it('returns false for state-mutating tools', () => {
    expect(isSpeculativelySafe('shell_execute')).toBe(false);
    expect(isSpeculativelySafe('file_write')).toBe(false);
    expect(isSpeculativelySafe('git')).toBe(false);
  });
});

describe('SpeculativeExecutor - PatternTracker', () => {
  let tracker: PatternTracker;

  beforeEach(() => {
    tracker = new PatternTracker();
  });

  it('starts with no patterns', () => {
    expect(tracker.getTopPatterns(10)).toHaveLength(0);
  });

  it('records single sequences', () => {
    tracker.recordSequence(['web_search', 'web_fetch']);
    const patterns = tracker.getTopPatterns(10);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
  });

  it('records longer sequences', () => {
    tracker.recordSequence(['web_search', 'web_fetch', 'file_write']);
    tracker.recordSequence(['web_search', 'web_fetch', 'file_write']);
    const patterns = tracker.getTopPatterns(10);
    const webSearchFetchWrite = patterns.find(
      p => p.sequence.join('→') === 'web_search→web_fetch→file_write'
    );
    expect(webSearchFetchWrite).toBeDefined();
    expect(webSearchFetchWrite!.frequency).toBe(2);
  });

  it('predicts next tool from observed patterns', () => {
    tracker.recordSequence(['web_search', 'web_fetch']);
    tracker.recordSequence(['web_search', 'web_fetch']);
    tracker.recordSequence(['web_search', 'web_fetch']);

    const predictions = tracker.predictNext(['web_search']);
    expect(predictions.length).toBeGreaterThan(0);
    expect(predictions[0].toolName).toBe('web_fetch');
    expect(predictions[0].confidence).toBeGreaterThan(0);
  });

  it('returns empty predictions for unknown sequences', () => {
    const predictions = tracker.predictNext(['unknown_tool']);
    expect(predictions).toHaveLength(0);
  });

  it('increases confidence with frequency', () => {
    for (let i = 0; i < 10; i++) {
      tracker.recordSequence(['file_read', 'file_edit', 'file_write']);
    }
    const predictions = tracker.predictNext(['file_read']);
    const fileEdit = predictions.find(p => p.toolName === 'file_edit');
    expect(fileEdit).toBeDefined();
    expect(fileEdit!.confidence).toBeGreaterThan(0.5);
  });

  it('returns top patterns sorted by frequency', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordSequence(['a', 'b']);
    }
    for (let i = 0; i < 3; i++) {
      tracker.recordSequence(['c', 'd']);
    }
    const top = tracker.getTopPatterns(5);
    expect(top[0].sequence.join('→')).toBe('a→b');
    expect(top[0].frequency).toBe(5);
  });
});

describe('SpeculativeExecutor - getPatternTracker', () => {
  beforeEach(() => {
    resetPatternTracker();
  });

  it('returns a singleton instance', () => {
    const t1 = getPatternTracker();
    const t2 = getPatternTracker();
    expect(t1).toBe(t2);
  });

  it('reset creates a new instance', () => {
    const t1 = getPatternTracker();
    resetPatternTracker();
    const t2 = getPatternTracker();
    expect(t1).not.toBe(t2);
  });
});

describe('SpeculativeExecutor - planSpeculativeExecution', () => {
  let tracker: PatternTracker;

  beforeEach(() => {
    tracker = new PatternTracker();
  });

  it('returns empty plan with no patterns', () => {
    const plan = planSpeculativeExecution(
      tracker,
      [{ name: 'web_search', arguments: { query: 'test' } }],
      ['web_search', 'web_fetch'],
    );
    expect(plan).toHaveLength(0);
  });

  it('predicts next tool from learned pattern', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordSequence(['web_search', 'web_fetch']);
    }

    const plan = planSpeculativeExecution(
      tracker,
      [{ name: 'web_search', arguments: { query: 'test' } }],
      ['web_search', 'web_fetch', 'file_read'],
    );

    expect(plan.length).toBeGreaterThan(0);
    expect(plan[0].name).toBe('web_fetch');
  });

  it('skips unsafe tools in predictions', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordSequence(['file_read', 'shell_execute']);
    }

    const plan = planSpeculativeExecution(
      tracker,
      [{ name: 'file_read', arguments: { path: '/test' } }],
      ['file_read', 'shell_execute'],
    );

    const hasUnsafe = plan.some(p => p.name === 'shell_execute');
    expect(hasUnsafe).toBe(false);
  });

  it('limits to max 2 predictions', () => {
    for (let i = 0; i < 10; i++) {
      tracker.recordSequence(['file_read', 'file_search', 'file_edit', 'file_write']);
    }

    const plan = planSpeculativeExecution(
      tracker,
      [{ name: 'file_read', arguments: { path: '/test' } }],
      ['file_read', 'file_search', 'file_edit', 'file_write'],
    );

    expect(plan.length).toBeLessThanOrEqual(2);
  });
});
